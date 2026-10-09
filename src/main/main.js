const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const { FileSession, ENCODINGS } = require("./fileSession");
const { registerToolboxIpc } = require("./toolbox");
const { registerScreenshot } = require("./screenshot");
const { registerRecorder } = require("./recorder");

let screenshotApi = null;

let win;
const session = new FileSession();
let indexJob = 0;

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

function untitledMeta() {
  return {
    path: null,
    untitled: true,
    size: 0,
    encoding: menuState.encoding,
    encodingLabel: ENCODINGS[menuState.encoding]?.label || "UTF-8",
    bom: 0,
    editable: true,
    indexDone: true,
    totalLines: 1,
    encodings: encodingList(),
    language: menuState.language,
    wrap: menuState.wrap,
    mode: menuState.mode,
  };
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
  };
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
  win.on("closed", () => {
    win = null;
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
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return;
  await openPath(result.filePaths[0]);
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
  indexJob += 1;
  const job = indexJob;
  const meta = await session.open(filePath);
  menuState.encoding = meta.encoding;
  addRecent(filePath);
  send("file-opened", { ...meta, language: menuState.language, wrap: menuState.wrap, mode: menuState.mode });
  session
    .buildIndex((progress) => {
      if (job === indexJob) {
        send("index-progress", {
          ...progress,
          language: menuState.language,
          wrap: menuState.wrap,
          mode: menuState.mode,
        });
      }
    })
    .then((done) => {
      if (job === indexJob) {
        send("index-progress", {
          ...done,
          language: menuState.language,
          wrap: menuState.wrap,
          mode: menuState.mode,
        });
      }
    })
    .catch((err) => {
      if (job === indexJob) send("app-error", String(err.message || err));
    });
}

async function newFile() {
  indexJob += 1;
  await session.close();
  session.encoding = menuState.encoding;
  send("file-opened", untitledMeta());
}

async function closeFile() {
  indexJob += 1;
  await session.close();
  send("file-opened", emptyMeta());
}

function applyEncoding(encoding) {
  menuState.encoding = encoding;
  const meta = session.setEncoding(encoding);
  if (session.path) {
    send("encoding-changed", {
      ...meta,
      language: menuState.language,
      wrap: menuState.wrap,
      mode: menuState.mode,
    });
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
        { label: "关闭(&C)", accelerator: "CmdOrCtrl+W", click: () => closeFile() },
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
            send("menu", "language:" + lang.id);
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
            send("menu", menuState.wrap ? "wrap-on" : "wrap-off");
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
            send("menu", "view-text");
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
            send("menu", "view-hex");
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

ipcMain.handle("dialog:open", () => pickOpen());
ipcMain.handle("file:meta", () => session.meta());
ipcMain.handle("file:set-encoding", (_e, encoding) => {
  menuState.encoding = encoding;
  const meta = session.setEncoding(encoding);
  buildMenu();
  return meta;
});
ipcMain.handle("file:read-lines", (_e, startLine, count) =>
  session.readLines(startLine, count)
);
ipcMain.handle("file:read-bytes", async (_e, offset, length) => {
  const buf = await session.readBytes(offset, length);
  return { offset, bytes: Array.from(buf) };
});
ipcMain.handle("file:read-text", () => session.readText());
ipcMain.handle("file:find", (_e, opts) => session.findNext(opts));
ipcMain.handle("file:save-text", async (_e, { text, saveAs }) => {
  let target = session.path;
  if (saveAs || !target) {
    target = await pickSave(target || "未命名.txt");
    if (!target) return { cancelled: true };
  }
  const meta = await session.saveText(target, text);
  addRecent(target);
  indexJob += 1;
  const job = indexJob;
  session
    .buildIndex((progress) => {
      if (job === indexJob) send("index-progress", progress);
    })
    .then((done) => {
      if (job === indexJob) send("index-progress", done);
    });
  return { cancelled: false, meta };
});
ipcMain.handle("file:offset-to-line", (_e, offset) => session.offsetToLine(offset));
registerToolboxIpc(ipcMain, () => currentWindow());
ipcMain.handle("file:new", () => newFile());
ipcMain.handle("file:close", () => closeFile());
ipcMain.handle("ui:set-mode", (_e, mode) => {
  menuState.mode = mode === "hex" ? "hex" : "text";
  buildMenu();
});

app.whenReady().then(() => {
  loadRecents();
  screenshotApi = registerScreenshot(app, { rebuildMenu: () => buildMenu() });
  const shot = screenshotApi.registerShortcut();
  if (!shot.ok) screenshotApi.registerShortcut();
  registerRecorder(app, { pickRegion: () => screenshotApi.pickRegion() });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  await session.close();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await session.close();
});
