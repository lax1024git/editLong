const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const { ENCODINGS } = require("./fileSession");
const { TabWorkspace } = require("./tabs");
const { registerToolboxIpc } = require("./toolbox");
const { registerScreenshot } = require("./screenshot");
const { registerRecorder } = require("./recorder");
const { registerStorage } = require("./storage");
const { registerSsh } = require("./ssh");
const { registerHttp } = require("./http");
const { registerVideoEditIpc } = require("./videoEdit");
const {
  registerVideoEditor,
  registerMediaSchemePrivileged,
} = require("./videoEditorWin");
const {
  collectOpenPaths,
  registerContextMenu,
  unregisterContextMenu,
} = require("./shellAssoc");

let screenshotApi = null;
let storageApi = null;
let sshApi = null;
let httpApi = null;
let videoEditorApi = null;

/** @type {Map<string, { win: import("electron").BrowserWindow, ready: boolean }>} */
const editorWindows = new Map();
let primaryWindowId = null;
let windowSeq = 0;
const workspace = new TabWorkspace();
let pendingOpenPaths = [];
/** @type {{ tabId: string, fromWindowId: string, viewState: object|null } | null} */
let tabDragSession = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 必须在 app ready 之前注册自定义协议特权
  registerMediaSchemePrivileged();
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

function emptyMeta(windowId) {
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
    windowId: windowId || null,
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

function getPrimaryWindow() {
  if (primaryWindowId && editorWindows.has(primaryWindowId)) {
    const entry = editorWindows.get(primaryWindowId);
    if (entry && entry.win && !entry.win.isDestroyed()) return entry.win;
  }
  for (const entry of editorWindows.values()) {
    if (entry.win && !entry.win.isDestroyed()) return entry.win;
  }
  return null;
}

function getFocusedEditorEntry() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    for (const [id, entry] of editorWindows) {
      if (entry.win === focused) return { windowId: id, ...entry };
    }
  }
  if (primaryWindowId && editorWindows.has(primaryWindowId)) {
    return { windowId: primaryWindowId, ...editorWindows.get(primaryWindowId) };
  }
  const first = editorWindows.entries().next().value;
  return first ? { windowId: first[0], ...first[1] } : null;
}

function windowIdFromWebContents(wc) {
  if (!wc) return null;
  for (const [id, entry] of editorWindows) {
    if (entry.win && !entry.win.isDestroyed() && entry.win.webContents === wc) return id;
  }
  return null;
}

function windowIdFromEvent(e) {
  return windowIdFromWebContents(e && e.sender);
}

function entryForWindowId(windowId) {
  return windowId ? editorWindows.get(windowId) || null : null;
}

function sendToWindow(windowId, channel, payload) {
  const entry = entryForWindowId(windowId);
  if (entry && entry.win && !entry.win.isDestroyed()) {
    entry.win.webContents.send(channel, payload);
  }
}

function send(channel, payload) {
  const focused = getFocusedEditorEntry();
  if (focused) sendToWindow(focused.windowId, channel, payload);
  else if (primaryWindowId) sendToWindow(primaryWindowId, channel, payload);
}

function sendToAllEditors(channel, payload) {
  for (const id of editorWindows.keys()) sendToWindow(id, channel, payload);
}

function anyEditorReady() {
  for (const entry of editorWindows.values()) {
    if (entry.ready) return true;
  }
  return false;
}

function syncMenuFromTab(tab) {
  if (!tab) return;
  menuState.encoding = tab.session.encoding || menuState.encoding;
  menuState.language = tab.language;
  menuState.wrap = tab.wrap;
  menuState.mode = tab.mode;
  buildMenu();
}

function emitTabs(windowId) {
  if (windowId != null) {
    sendToWindow(windowId, "tabs-changed", workspace.listForWindow(windowId));
    return;
  }
  for (const id of editorWindows.keys()) {
    sendToWindow(id, "tabs-changed", workspace.listForWindow(id));
  }
}

function emitOpened(tab, windowId) {
  const wid = windowId != null ? windowId : tab && tab.windowId;
  if (!tab) {
    if (wid != null) {
      sendToWindow(wid, "file-opened", emptyMeta(wid));
      emitTabs(wid);
    }
    return;
  }
  const meta = workspace.snapshot(tab, tab.windowId);
  sendToWindow(tab.windowId, "file-opened", { ...meta, tabId: tab.id });
  emitTabs(tab.windowId);
}

function startIndex(tab) {
  if (!tab || tab.untitled || !tab.session.path) return;
  tab.indexJob += 1;
  const job = tab.indexJob;
  const id = tab.id;
  const wid = tab.windowId;
  tab.session
    .buildIndex((progress) => {
      if (tab.indexJob !== job) return;
      if (workspace.getActiveId(wid) === id) {
        sendToWindow(wid, "index-progress", {
          ...workspace.snapshot(tab, wid),
          ...progress,
          tabId: id,
        });
      }
    })
    .then((done) => {
      if (tab.indexJob !== job) return;
      if (workspace.getActiveId(wid) === id) {
        sendToWindow(wid, "index-progress", {
          ...workspace.snapshot(tab, wid),
          ...done,
          tabId: id,
        });
      } else {
        emitTabs(wid);
      }
    })
    .catch((err) => {
      if (tab.indexJob === job && workspace.getActiveId(wid) === id) {
        sendToWindow(wid, "app-error", String(err.message || err));
      }
    });
}

function focusEditorWindow(windowId) {
  const entry = entryForWindowId(windowId);
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.show();
  entry.win.focus();
}

function focusMainWindow() {
  const win = getPrimaryWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function openPaths(filePaths, windowId) {
  const list = Array.isArray(filePaths) ? filePaths : [];
  const targetId = windowId || primaryWindowId;
  for (const filePath of list) {
    try {
      await openPath(filePath, targetId);
    } catch (err) {
      sendToWindow(targetId, "app-error", "无法打开：\n" + filePath + "\n" + String(err.message || err));
    }
  }
}

async function flushPendingOpens(windowId) {
  if (!pendingOpenPaths.length) return;
  if (!anyEditorReady()) return;
  const list = pendingOpenPaths.slice();
  pendingOpenPaths = [];
  await openPaths(list, windowId || primaryWindowId);
}

function createEditorWindow(opts = {}) {
  const windowId = "ew" + ++windowSeq;
  const iconPath = path.join(__dirname, "..", "..", "build", "icon.ico");
  const win = new BrowserWindow({
    width: opts.width || 1100,
    height: opts.height || 740,
    minWidth: 720,
    minHeight: 480,
    x: typeof opts.x === "number" ? opts.x : undefined,
    y: typeof opts.y === "number" ? opts.y : undefined,
    backgroundColor: "#f3f3f3",
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: ["--editlong-window-id=" + windowId],
    },
  });

  workspace.ensureWindow(windowId);
  editorWindows.set(windowId, { win, ready: false });
  if (!primaryWindowId) primaryWindowId = windowId;

  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.webContents.on("zoom-changed", () => {
    win.webContents.setZoomFactor(1);
    win.webContents.setZoomLevel(0);
  });
  win.webContents.once("did-finish-load", () => {
    win.webContents.setZoomFactor(1);
    win.webContents.setZoomLevel(0);
    const entry = editorWindows.get(windowId);
    if (entry) entry.ready = true;
    win.webContents.send("window-init", { windowId, isPrimary: windowId === primaryWindowId });
    emitTabs(windowId);
    if (windowId === primaryWindowId) flushPendingOpens(windowId);
  });
  win.on("closed", async () => {
    const tabs = workspace.tabsOf(windowId);
    for (const tab of tabs) {
      await workspace.close(tab.id);
    }
    workspace.removeWindow(windowId);
    editorWindows.delete(windowId);
    if (primaryWindowId === windowId) {
      primaryWindowId = editorWindows.keys().next().value || null;
      if (!primaryWindowId) {
        if (storageApi && typeof storageApi.close === "function") storageApi.close();
        if (sshApi && typeof sshApi.close === "function") sshApi.close();
        if (httpApi && typeof httpApi.close === "function") httpApi.close();
      }
    }
  });
  buildMenu();
  return { windowId, win };
}

function createWindow() {
  return createEditorWindow();
}

function setWindowOnTop(on) {
  menuState.onTop = Boolean(on);
  const focused = getFocusedEditorEntry();
  if (focused && focused.win && !focused.win.isDestroyed()) {
    focused.win.setAlwaysOnTop(menuState.onTop);
  } else {
    const primary = getPrimaryWindow();
    if (primary) primary.setAlwaysOnTop(menuState.onTop);
  }
  buildMenu();
  if (focused) {
    sendToWindow(focused.windowId, "menu", menuState.onTop ? "on-top" : "on-top-off");
  } else {
    send("menu", menuState.onTop ? "on-top" : "on-top-off");
  }
}

function currentWindow() {
  const focused = getFocusedEditorEntry();
  if (focused && focused.win && !focused.win.isDestroyed()) return focused.win;
  return getPrimaryWindow() || BrowserWindow.getFocusedWindow();
}

function requireActiveFrom(e) {
  const windowId = windowIdFromEvent(e);
  const tab = workspace.activeFor(windowId);
  if (!tab) throw new Error("未打开文件");
  return tab;
}

async function pickOpen(windowId) {
  const result = await dialog.showOpenDialog(currentWindow(), {
    title: "打开",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled || !result.filePaths.length) return;
  const wid = windowId || getFocusedEditorEntry()?.windowId || primaryWindowId;
  for (const filePath of result.filePaths) {
    await openPath(filePath, wid);
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

async function openPath(filePath, windowId) {
  const wid = windowId || primaryWindowId;
  const { tab, reused } = await workspace.createFromPath(filePath, tabDefaults(), wid);
  addRecent(filePath);
  if (reused && tab.windowId !== wid) {
    focusEditorWindow(tab.windowId);
    workspace.activate(tab.id, tab.windowId);
    syncMenuFromTab(tab);
    emitOpened(tab);
    return tab;
  }
  syncMenuFromTab(tab);
  emitOpened(tab);
  if (!reused) startIndex(tab);
  return tab;
}

async function newFile(windowId) {
  const wid = windowId || getFocusedEditorEntry()?.windowId || primaryWindowId;
  const tab = workspace.createUntitled(tabDefaults(), wid);
  syncMenuFromTab(tab);
  emitOpened(tab);
  return tab;
}

async function closeTab(id, windowId) {
  const tab = workspace.get(id);
  const wid = windowId || (tab && tab.windowId);
  if (!id) {
    const active = workspace.activeFor(wid);
    if (!active) return workspace.listForWindow(wid);
    id = active.id;
  }
  const next = await workspace.close(id);
  if (next) syncMenuFromTab(next);
  else buildMenu();
  emitOpened(next, wid);
  maybeCloseEmptySecondary(wid);
  return workspace.listForWindow(wid);
}

function maybeCloseEmptySecondary(windowId) {
  if (!windowId || windowId === primaryWindowId) return;
  if (!workspace.isEmpty(windowId)) return;
  const entry = entryForWindowId(windowId);
  if (entry && entry.win && !entry.win.isDestroyed()) {
    entry.win.close();
  }
}

async function activateTab(id, windowId) {
  const tab = workspace.get(id);
  if (!tab) return null;
  const wid = windowId != null ? windowId : tab.windowId;
  if (tab.windowId !== wid) return null;
  workspace.activate(id, wid);
  syncMenuFromTab(tab);
  emitOpened(tab);
  return workspace.snapshot(tab, wid);
}

function applyEncoding(encoding) {
  menuState.encoding = encoding;
  const focused = getFocusedEditorEntry();
  const tab = focused ? workspace.activeFor(focused.windowId) : null;
  if (tab) {
    const meta = tab.session.setEncoding(encoding);
    sendToWindow(tab.windowId, "encoding-changed", {
      ...workspace.snapshot(tab, tab.windowId),
      ...meta,
      tabId: tab.id,
    });
  }
  buildMenu();
}

function resolveDragPayload(payload) {
  const p = payload || {};
  const tabId = p.tabId || (tabDragSession && tabDragSession.tabId);
  const viewState =
    p.viewState != null
      ? p.viewState
      : tabDragSession && tabDragSession.tabId === tabId
        ? tabDragSession.viewState
        : null;
  return { tabId, viewState, screenX: p.screenX, screenY: p.screenY, index: p.index };
}

async function tearOffTab(raw) {
  const { tabId, screenX, screenY, viewState } = resolveDragPayload(raw);
  const tab = workspace.get(tabId);
  if (!tab) return { ok: false, error: "标签不存在" };
  const fromWindowId = tab.windowId;
  const { windowId, win } = createEditorWindow({
    x: Math.round((screenX || 100) - 80),
    y: Math.round((screenY || 100) - 20),
    width: 1100,
    height: 740,
  });
  workspace.setWindowId(tabId, windowId);
  emitTabs(fromWindowId);
  const fromActive = workspace.activeFor(fromWindowId);
  emitOpened(fromActive, fromWindowId);
  maybeCloseEmptySecondary(fromWindowId);

  const deliver = () => {
    const meta = workspace.snapshot(tab, windowId);
    sendToWindow(windowId, "tab-attach", {
      meta: { ...meta, tabId: tab.id },
      viewState: viewState || null,
    });
    emitTabs(windowId);
    syncMenuFromTab(tab);
  };

  if (editorWindows.get(windowId)?.ready) {
    deliver();
  } else {
    win.webContents.once("did-finish-load", () => setTimeout(deliver, 0));
  }
  return { ok: true, windowId };
}

async function attachTab(raw) {
  const { tabId, viewState, index } = resolveDragPayload(raw);
  const targetWindowId = raw && raw.targetWindowId;
  const tab = workspace.get(tabId);
  if (!tab) return { ok: false, error: "标签不存在" };
  if (!targetWindowId || !editorWindows.has(targetWindowId)) {
    return { ok: false, error: "目标窗口不存在" };
  }
  const fromWindowId = tab.windowId;
  if (fromWindowId === targetWindowId) {
    workspace.setWindowId(tabId, targetWindowId, index);
    emitTabs(targetWindowId);
    emitOpened(tab);
    return { ok: true };
  }
  workspace.setWindowId(tabId, targetWindowId, index);
  emitTabs(fromWindowId);
  emitOpened(workspace.activeFor(fromWindowId), fromWindowId);
  maybeCloseEmptySecondary(fromWindowId);

  const meta = workspace.snapshot(tab, targetWindowId);
  sendToWindow(targetWindowId, "tab-attach", {
    meta: { ...meta, tabId: tab.id },
    viewState: viewState || null,
  });
  emitTabs(targetWindowId);
  focusEditorWindow(targetWindowId);
  syncMenuFromTab(tab);
  return { ok: true };
}

function buildMenu() {
  const recentSub =
    menuState.recents.length === 0
      ? [{ label: "(空)", enabled: false }]
      : menuState.recents.map((filePath, i) => ({
          label: (i < 9 ? "&" + (i + 1) + " " : "") + filePath,
          click: () => openPath(filePath, getFocusedEditorEntry()?.windowId || primaryWindowId),
        }));

  const template = [
    {
      label: "文件(&F)",
      submenu: [
        {
          label: "新建(&N)",
          accelerator: "CmdOrCtrl+N",
          click: () => newFile(getFocusedEditorEntry()?.windowId || primaryWindowId),
        },
        {
          label: "打开(&O)...",
          accelerator: "CmdOrCtrl+O",
          click: () => pickOpen(getFocusedEditorEntry()?.windowId || primaryWindowId),
        },
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
            const focused = getFocusedEditorEntry();
            const tab = focused ? workspace.activeFor(focused.windowId) : null;
            if (tab) tab.language = lang.id;
            send("menu", "language:" + lang.id);
            if (focused) emitTabs(focused.windowId);
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
            const focused = getFocusedEditorEntry();
            const tab = focused ? workspace.activeFor(focused.windowId) : null;
            if (tab) tab.wrap = item.checked;
            send("menu", menuState.wrap ? "wrap-on" : "wrap-off");
            if (focused) emitTabs(focused.windowId);
          },
        },
        {
          label: "窗口置顶",
          type: "checkbox",
          checked: menuState.onTop,
          click: (item) => setWindowOnTop(item.checked),
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
        { label: "二维码", click: () => send("menu", "toolbox:qrcode") },
        { label: "加解密", click: () => send("menu", "toolbox:crypto") },
        {
          label: "视频剪辑",
          click: () => videoEditorApi && videoEditorApi.open(),
        },
        { label: "视频工具（表单）", click: () => send("menu", "toolbox:video") },
        { type: "separator" },
        {
          label: "对象存储 (OSS/COS/BOS/S3/B2)",
          click: () => storageApi && storageApi.open(),
        },
        {
          label: "远程连接 (SSH/SFTP)",
          click: () => sshApi && sshApi.open(),
        },
        {
          label: "HTTP 请求 (Postman)",
          click: () => httpApi && httpApi.open(),
        },
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
            const focused = getFocusedEditorEntry();
            const tab = focused ? workspace.activeFor(focused.windowId) : null;
            if (tab) tab.mode = "text";
            send("menu", "view-text");
            if (focused) emitTabs(focused.windowId);
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
            const focused = getFocusedEditorEntry();
            const tab = focused ? workspace.activeFor(focused.windowId) : null;
            if (tab) tab.mode = "hex";
            send("menu", "view-hex");
            if (focused) emitTabs(focused.windowId);
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

ipcMain.handle("dialog:open", (e) => pickOpen(windowIdFromEvent(e)));
ipcMain.handle("file:meta", (e) => {
  const windowId = windowIdFromEvent(e);
  const tab = workspace.activeFor(windowId);
  return tab ? workspace.snapshot(tab, windowId) : emptyMeta(windowId);
});
ipcMain.handle("file:set-encoding", (e, encoding) => {
  menuState.encoding = encoding;
  const tab = requireActiveFrom(e);
  const meta = tab.session.setEncoding(encoding);
  buildMenu();
  emitTabs(tab.windowId);
  return { ...workspace.snapshot(tab, tab.windowId), ...meta, tabId: tab.id };
});
ipcMain.handle("file:read-lines", (e, startLine, count) =>
  requireActiveFrom(e).session.readLines(startLine, count),
);
ipcMain.handle("file:read-bytes", async (e, offset, length) => {
  const buf = await requireActiveFrom(e).session.readBytes(offset, length);
  return { offset, bytes: Array.from(buf) };
});
ipcMain.handle("file:read-text", (e) => requireActiveFrom(e).session.readText());
ipcMain.handle("file:find", (e, opts) => requireActiveFrom(e).session.findNext(opts));
ipcMain.handle("file:save-text", async (e, { text, saveAs }) => {
  const tab = requireActiveFrom(e);
  let target = tab.session.path;
  if (saveAs || !target) {
    target = await pickSave(target || tab.title + ".txt");
    if (!target) return { cancelled: true };
  }
  const meta = await tab.session.saveText(target, text);
  workspace.markSaved(tab);
  addRecent(target);
  startIndex(tab);
  emitTabs(tab.windowId);
  return {
    cancelled: false,
    meta: { ...workspace.snapshot(tab, tab.windowId), ...meta, tabId: tab.id },
  };
});
ipcMain.handle("file:offset-to-line", (e, offset) =>
  requireActiveFrom(e).session.offsetToLine(offset),
);
registerToolboxIpc(ipcMain, () => currentWindow());
registerVideoEditIpc(ipcMain, () =>
  (videoEditorApi && videoEditorApi.getWindow && videoEditorApi.getWindow()) || currentWindow(),
);
ipcMain.handle("file:new", (e) => newFile(windowIdFromEvent(e)));
ipcMain.handle("file:close", (e, id) => closeTab(id, windowIdFromEvent(e)));
ipcMain.handle("tabs:activate", (e, id) => activateTab(id, windowIdFromEvent(e)));
ipcMain.handle("tabs:close-all", async (e) => {
  const windowId = windowIdFromEvent(e);
  await workspace.closeAllInWindow(windowId);
  workspace.ensureWindow(windowId);
  buildMenu();
  emitOpened(null, windowId);
  maybeCloseEmptySecondary(windowId);
  return workspace.listForWindow(windowId);
});
ipcMain.handle("tabs:drag-begin", (e, payload) => {
  const windowId = windowIdFromEvent(e);
  const tabId = payload && payload.tabId;
  const tab = workspace.get(tabId);
  if (!tab || tab.windowId !== windowId) return { ok: false };
  tabDragSession = {
    tabId,
    fromWindowId: windowId,
    viewState: (payload && payload.viewState) || null,
  };
  return { ok: true };
});
ipcMain.handle("tabs:drag-finish", () => {
  tabDragSession = null;
  return { ok: true };
});
ipcMain.handle("tabs:tear-off", async (e, payload) => {
  const windowId = windowIdFromEvent(e);
  const resolved = resolveDragPayload(payload);
  const tab = workspace.get(resolved.tabId);
  if (!tab || tab.windowId !== windowId) return { ok: false, error: "标签不在当前窗口" };
  const result = await tearOffTab(resolved);
  tabDragSession = null;
  return result;
});
ipcMain.handle("tabs:attach", async (e, payload) => {
  const targetWindowId = (payload && payload.targetWindowId) || windowIdFromEvent(e);
  const resolved = resolveDragPayload(payload);
  if (!resolved.tabId) return { ok: false, error: "缺少标签" };
  const result = await attachTab({
    tabId: resolved.tabId,
    viewState: resolved.viewState,
    index: payload && payload.index,
    targetWindowId,
  });
  tabDragSession = null;
  return result;
});
ipcMain.handle("window:get-id", (e) => windowIdFromEvent(e));
ipcMain.handle("ui:set-mode", (e, mode) => {
  menuState.mode = mode === "hex" ? "hex" : "text";
  const windowId = windowIdFromEvent(e);
  const tab = workspace.activeFor(windowId);
  if (tab) tab.mode = menuState.mode;
  buildMenu();
  emitTabs(windowId);
});

ipcMain.handle("window:get-on-top", () => Boolean(menuState.onTop));
ipcMain.handle("window:set-on-top", (_e, on) => {
  setWindowOnTop(on);
  return Boolean(menuState.onTop);
});
ipcMain.handle("window:toggle-on-top", () => {
  setWindowOnTop(!menuState.onTop);
  return Boolean(menuState.onTop);
});

if (gotLock) {
  app.on("second-instance", (_e, argv) => {
    const files = collectOpenPaths(argv);
    focusMainWindow();
    if (!files.length) return;
    if (anyEditorReady()) openPaths(files, primaryWindowId);
    else pendingOpenPaths.push(...files);
  });

  app.whenReady().then(() => {
    loadRecents();
    screenshotApi = registerScreenshot(app, { rebuildMenu: () => buildMenu() });
    const shot = screenshotApi.registerShortcut();
    if (!shot.ok) screenshotApi.registerShortcut();
    registerRecorder(app, { pickRegion: () => screenshotApi.pickRegion() });
    storageApi = registerStorage(app, { getMainWindow: () => getPrimaryWindow() });
    sshApi = registerSsh(app, { getMainWindow: () => getPrimaryWindow() });
    httpApi = registerHttp(app, { getMainWindow: () => getPrimaryWindow() });
    videoEditorApi = registerVideoEditor({ getMainWindow: () => getPrimaryWindow() });
    pendingOpenPaths.push(...collectOpenPaths(process.argv));
    createWindow();
    app.on("activate", () => {
      if (editorWindows.size === 0) createWindow();
    });
  });

  app.on("window-all-closed", async () => {
    if (storageApi && typeof storageApi.close === "function") storageApi.close();
    if (sshApi && typeof sshApi.close === "function") sshApi.close();
    if (httpApi && typeof httpApi.close === "function") httpApi.close();
    if (videoEditorApi && typeof videoEditorApi.close === "function") videoEditorApi.close();
    await workspace.closeAll();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", async () => {
    if (storageApi && typeof storageApi.close === "function") storageApi.close();
    if (sshApi && typeof sshApi.close === "function") sshApi.close();
    if (httpApi && typeof httpApi.close === "function") httpApi.close();
    if (videoEditorApi && typeof videoEditorApi.close === "function") videoEditorApi.close();
    await workspace.closeAll();
  });
}
