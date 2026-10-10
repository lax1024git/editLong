const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const { ENCODINGS } = require("./fileSession");
const { TabWorkspace } = require("./tabs");
const { registerToolboxIpc } = require("./toolbox");
const { registerScreenshot } = require("./screenshot");
const { registerRecorder } = require("./recorder");
const {
  collectOpenPaths,
  registerContextMenu,
  unregisterContextMenu,
} = require("./shellAssoc");

let screenshotApi = null;

let win;
const workspace = new TabWorkspace();
let pendingOpenPaths = [];
let rendererReady = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const LANGUAGES = [
  { id: "plaintext", label: "纯文本" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "html", label: "HTML" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "markdown", label: "Markdown" },
  { id: "python", label: "Python" },
  { id: "xml", label: "XML" },
  { id: "batch", label: "Batch" },
  { id: "ini", label: "INI" },
  { id: "sql", label: "SQL" },
  { id: "php", label: "PHP" },
];

const menuState = {
  encoding: "utf8",
  language: "plaintext",
  wrap: false,
  onTop: false,
  mode: "text",
  recents: [],
};

function recentsFile() {
  return path.join(app.getPath("userData"), "recents.json");
}

function loadRecents() {
  try {
    const raw = fs.readFileSync(recentsFile(), "utf8");
    const list = JSON.parse(raw);
    if (Array.isArray(list)) menuState.recents = list.filter((p) => typeof p === "string").slice(0, 12);
  } catch {
    menuState.recents = [];
  }
}

function saveRecents() {
  try {
    fs.writeFileSync(recentsFile(), JSON.stringify(menuState.recents, null, 2));
  } catch {
    /* ignore */
  }
}

function addRecent(filePath) {
  menuState.recents = [filePath, ...menuState.recents.filter((p) => p !== filePath)].slice(0, 12);
  saveRecents();
  buildMenu();
}

function encodingList() {
  return Object.entries(ENCODINGS).map(([id, v]) => ({ id, label: v.label }));
}

function emptyMeta() {
  return {
    path: null,
    untitled: false,
    size: 0,
    encoding: menuState.encoding,
    encodings: encodingList(),
    language: menuState.language,
    wrap: menuState.wrap,
    mode: menuState.mode,
    tabId: null,
  };
}

function tabDefaults() {
  return {
    encoding: menuState.encoding,
    language: menuState.language,
    wrap: menuState.wrap,
    mode: menuState.mode || "text",
  };
}

function syncMenuFromTab(tab) {
  if (!tab) return;
  menuState.encoding = tab.session.encoding || menuState.encoding;
  menuState.language = tab.language;
  menuState.wrap = tab.wrap;
  menuState.mode = tab.mode;
  buildMenu();
}

function emitTabs() {
  send("tabs-changed", workspace.list());
}

function emitOpened(tab) {
  if (!tab) {
    send("file-opened", emptyMeta());
    emitTabs();
    return;
  }
  const meta = workspace.snapshot(tab);
  send("file-opened", { ...meta, tabId: tab.id });
  emitTabs();
}

function startIndex(tab) {
  if (!tab || tab.untitled || !tab.session.path) return;
  tab.indexJob += 1;
  const job = tab.indexJob;
  const id = tab.id;
  tab.session
    .buildIndex((progress) => {
      if (tab.indexJob !== job) return;
      if (workspace.activeId === id) {
        send("index-progress", { ...workspace.snapshot(tab), ...progress, tabId: id });
      }
    })
    .then((done) => {
      if (tab.indexJob !== job) return;
      if (workspace.activeId === id) {
        send("index-progress", { ...workspace.snapshot(tab), ...done, tabId: id });
      } else {
        emitTabs();
      }
    })
    .catch((err) => {
      if (tab.indexJob === job && workspace.activeId === id) {
        send("app-error", String(err.message || err));
      }
    });
}

async function openPaths(filePaths) {
  const list = Array.isArray(filePaths) ? filePaths : [];
  for (const filePath of list) {
    try {
      await openPath(filePath);
    } catch (err) {
      send("app-error", "无法打开：\n" + filePath + "\n" + String(err.message || err));
    }
  }
}

async function flushPendingOpens() {
  if (!rendererReady || !pendingOpenPaths.length) return;
  const list = pendingOpenPaths.slice();
  pendingOpenPaths = [];
  await openPaths(list);
}

function focusMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#f3f3f3",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.webContents.once("did-finish-load", () => {
    rendererReady = true;
    flushPendingOpens();
  });
  win.on("closed", () => {
    win = null;
    rendererReady = false;
  });
  buildMenu();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function currentWindow() {
  return BrowserWindow.getFocusedWindow() || win;
}

async function pickOpen() {
  const result = await dialog.showOpenDialog(currentWindow(), {
    title: "打开",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled || !result.filePaths.length) return;
  for (const filePath of result.filePaths) {
    await openPath(filePath);
  }
}

async function pickSave(defaultPath) {
  const result = await dialog.showSaveDialog(currentWindow(), {
    title: "另存为",
    defaultPath,
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

async function openPath(filePath) {
  const { tab, reused } = await workspace.createFromPath(filePath, tabDefaults());
  addRecent(filePath);
  syncMenuFromTab(tab);
  emitOpened(tab);
  if (!reused) startIndex(tab);
}

async function newFile() {
  const tab = workspace.createUntitled(tabDefaults());
  syncMenuFromTab(tab);
  emitOpened(tab);
}

async function closeTab(id) {
  const target = id || workspace.activeId;
  if (!target) return workspace.list();
  const next = await workspace.close(target);
  if (next) syncMenuFromTab(next);
  else buildMenu();
  emitOpened(next);
  return workspace.list();
}

async function closeFile() {
  await closeTab(workspace.activeId);
}

async function activateTab(id) {
  const tab = workspace.activate(id);
  if (!tab) return null;
  syncMenuFromTab(tab);
  emitOpened(tab);
  return workspace.snapshot(tab);
}

function applyEncoding(encoding) {
  menuState.encoding = encoding;
  const tab = workspace.active();
  if (tab) {
    const meta = tab.session.setEncoding(encoding);
    send("encoding-changed", { ...workspace.snapshot(tab), ...meta, tabId: tab.id });
  }
  buildMenu();
}

function buildMenu() {
  const recentSub =
    menuState.recents.length === 0
      ? [{ label: "(空)", enabled: false }]
      : menuState.recents.map((filePath, i) => ({
          label: (i < 9 ? "&" + (i + 1) + " " : "") + filePath,
          click: () => openPath(filePath),
        }));

  const template = [
    {
      label: "文件(&F)",
      submenu: [
        { label: "新建(&N)", accelerator: "CmdOrCtrl+N", click: () => newFile() },
        { label: "打开(&O)...", accelerator: "CmdOrCtrl+O", click: () => pickOpen() },
        { label: "最近打开的文件(&R)", submenu: recentSub },
        { type: "separator" },
        { label: "保存(&S)", accelerator: "CmdOrCtrl+S", click: () => send("menu", "save") },
        {
          label: "另存为(&A)...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => send("menu", "save-as"),
        },
        { type: "separator" },
        { label: "关闭(&C)", accelerator: "CmdOrCtrl+W", click: () => send("menu", "close") },
        { label: "关闭全部", click: () => send("menu", "close-all") },
        { type: "separator" },
        { label: "退出(&X)", role: "quit" },
      ],
    },
    {
      label: "编辑(&E)",
      submenu: [
        { label: "撤销(&U)", accelerator: "CmdOrCtrl+Z", role: "undo" },
        { label: "重做(&R)", accelerator: "CmdOrCtrl+Y", role: "redo" },
        { type: "separator" },
        { label: "剪切(&T)", accelerator: "CmdOrCtrl+X", role: "cut" },
        { label: "复制(&C)", accelerator: "CmdOrCtrl+C", role: "copy" },
        { label: "粘贴(&P)", accelerator: "CmdOrCtrl+V", role: "paste" },
        { label: "删除(&L)", accelerator: "Delete", click: () => send("menu", "delete") },
        { type: "separator" },
        { label: "全选(&A)", accelerator: "CmdOrCtrl+A", role: "selectAll" },
        { type: "separator" },
        { label: "转为大写", click: () => send("menu", "upper") },
        { label: "转为小写", click: () => send("menu", "lower") },
      ],
    },
    {
      label: "搜索(&S)",
      submenu: [
        { label: "查找(&F)...", accelerator: "CmdOrCtrl+F", click: () => send("menu", "find") },
        { label: "查找下一个(&N)", accelerator: "F3", click: () => send("menu", "find-next") },
        {
          label: "查找上一个(&P)",
          accelerator: "Shift+F3",
          click: () => send("menu", "find-prev"),
        },
        { type: "separator" },
        { label: "转到(&G)...", accelerator: "CmdOrCtrl+G", click: () => send("menu", "goto") },
      ],
    },
    {
      label: "编码(&N)",
      submenu: encodingList().map((enc) => ({
        label: "以 " + enc.label + " 编码打开",
        type: "radio",
        checked: menuState.encoding === enc.id,
        click: () => applyEncoding(enc.id),
      })),
    },
    {
      label: "语言(&L)",
      submenu: LANGUAGES.map((lang, idx) => {
        const item = {
          label: lang.label,
          type: "radio",
          checked: menuState.language === lang.id,
          click: () => {
            menuState.language = lang.id;
            const tab = workspace.active();
            if (tab) tab.language = lang.id;
            send("menu", "language:" + lang.id);
            emitTabs();
            buildMenu();
          },
        };
        if (idx === 1) return [{ type: "separator" }, item];
        return item;
      }).flat(),
    },
    {
      label: "设置(&T)",
      submenu: [
        {
          label: "自动换行",
          type: "checkbox",
          checked: menuState.wrap,
          click: (item) => {
            menuState.wrap = item.checked;
            const tab = workspace.active();
            if (tab) tab.wrap = item.checked;
            send("menu", menuState.wrap ? "wrap-on" : "wrap-off");
            emitTabs();
          },
        },
        {
          label: "窗口置顶",
          type: "checkbox",
          checked: menuState.onTop,
          click: (item) => {
            menuState.onTop = item.checked;
            if (win) win.setAlwaysOnTop(menuState.onTop);
          },
        },
        { type: "separator" },
        {
          label: "截图快捷键...",
          click: () => send("menu", "snip-hotkey"),
        },
        { type: "separator" },
        {
          label: "注册「打开方式 / 右键打开」",
          click: async () => {
            const r = await registerContextMenu();
            dialog.showMessageBox(currentWindow(), {
              type: r.ok ? "info" : "error",
              title: "打开方式",
              message: r.ok
                ? "已注册：\n• 右键菜单「用 EditLong 打开」\n• 「打开方式」中可选 EditLong\n若列表未刷新，可注销后重登或重启资源管理器。"
                : "注册失败：\n" + (r.error || ""),
            });
          },
        },
        {
          label: "取消打开方式 / 右键注册",
          click: async () => {
            const r = await unregisterContextMenu();
            dialog.showMessageBox(currentWindow(), {
              type: r.ok ? "info" : "error",
              title: "打开方式",
              message: r.ok ? "已取消打开方式与右键菜单注册。" : "取消失败：\n" + (r.error || ""),
            });
          },
        },
      ],
    },
    {
      label: "工具(&O)",
      submenu: [
        { label: "快捷工具箱", click: () => send("menu", "toolbox") },
        { type: "separator" },
        { label: "时间", click: () => send("menu", "toolbox:time") },
        { label: "JSON", click: () => send("menu", "toolbox:json") },
        { label: "图片", click: () => send("menu", "toolbox:image") },
        { label: "加解密", click: () => send("menu", "toolbox:crypto") },
        { type: "separator" },
        {
          label:
            "区域截图" +
            (screenshotApi ? " (" + screenshotApi.getShortcutLabel() + ")" : ""),
          click: () => screenshotApi && screenshotApi.startRegionSnip(),
        },
        {
          label: "截图快捷键...",
          click: () => send("menu", "snip-hotkey"),
        },
        {
          label: "区域录屏 (Ctrl+Shift+R)",
          click: () => send("menu", "record"),
        },
      ],
    },
    {
      label: "窗口(&W)",
      submenu: [
        {
          label: "文本",
          type: "radio",
          checked: menuState.mode === "text",
          accelerator: "CmdOrCtrl+1",
          click: () => {
            menuState.mode = "text";
            const tab = workspace.active();
            if (tab) tab.mode = "text";
            send("menu", "view-text");
            emitTabs();
            buildMenu();
          },
        },
        {
          label: "二进制 / 十六进制",
          type: "radio",
          checked: menuState.mode === "hex",
          accelerator: "CmdOrCtrl+2",
          click: () => {
            menuState.mode = "hex";
            const tab = workspace.active();
            if (tab) tab.mode = "hex";
            send("menu", "view-hex");
            emitTabs();
            buildMenu();
          },
        },
        { type: "separator" },
        { label: "最小化", role: "minimize" },
        { label: "最大化", role: "maximize" },
      ],
    },
    {
      label: "?",
      submenu: [
        {
          label: "关于 EditLong...",
          click: () => send("menu", "about"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function requireActive() {
  const tab = workspace.active();
  if (!tab) throw new Error("未打开文件");
  return tab;
}

ipcMain.handle("dialog:open", () => pickOpen());
ipcMain.handle("file:meta", () => {
  const tab = workspace.active();
  return tab ? workspace.snapshot(tab) : emptyMeta();
});
ipcMain.handle("file:set-encoding", (_e, encoding) => {
  menuState.encoding = encoding;
  const tab = requireActive();
  const meta = tab.session.setEncoding(encoding);
  buildMenu();
  emitTabs();
  return { ...workspace.snapshot(tab), ...meta, tabId: tab.id };
});
ipcMain.handle("file:read-lines", (_e, startLine, count) =>
  requireActive().session.readLines(startLine, count)
);
ipcMain.handle("file:read-bytes", async (_e, offset, length) => {
  const buf = await requireActive().session.readBytes(offset, length);
  return { offset, bytes: Array.from(buf) };
});
ipcMain.handle("file:read-text", () => requireActive().session.readText());
ipcMain.handle("file:find", (_e, opts) => requireActive().session.findNext(opts));
ipcMain.handle("file:save-text", async (_e, { text, saveAs }) => {
  const tab = requireActive();
  let target = tab.session.path;
  if (saveAs || !target) {
    target = await pickSave(target || tab.title + ".txt");
    if (!target) return { cancelled: true };
  }
  const meta = await tab.session.saveText(target, text);
  workspace.markSaved(tab);
  addRecent(target);
  startIndex(tab);
  emitTabs();
  return { cancelled: false, meta: { ...workspace.snapshot(tab), ...meta, tabId: tab.id } };
});
ipcMain.handle("file:offset-to-line", (_e, offset) => requireActive().session.offsetToLine(offset));
registerToolboxIpc(ipcMain, () => currentWindow());
ipcMain.handle("file:new", () => newFile());
ipcMain.handle("file:close", (_e, id) => closeTab(id));
ipcMain.handle("tabs:activate", (_e, id) => activateTab(id));
ipcMain.handle("tabs:close-all", async () => {
  await workspace.closeAll();
  buildMenu();
  emitOpened(null);
  return workspace.list();
});
ipcMain.handle("ui:set-mode", (_e, mode) => {
  menuState.mode = mode === "hex" ? "hex" : "text";
  const tab = workspace.active();
  if (tab) tab.mode = menuState.mode;
  buildMenu();
  emitTabs();
});

if (gotLock) {
  app.on("second-instance", (_e, argv) => {
    const files = collectOpenPaths(argv);
    focusMainWindow();
    if (!files.length) return;
    if (rendererReady) openPaths(files);
    else pendingOpenPaths.push(...files);
  });

  app.whenReady().then(() => {
    loadRecents();
    screenshotApi = registerScreenshot(app, { rebuildMenu: () => buildMenu() });
    const shot = screenshotApi.registerShortcut();
    if (!shot.ok) screenshotApi.registerShortcut();
    registerRecorder(app, { pickRegion: () => screenshotApi.pickRegion() });
    pendingOpenPaths.push(...collectOpenPaths(process.argv));
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", async () => {
    await workspace.closeAll();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", async () => {
    await workspace.closeAll();
  });
}
