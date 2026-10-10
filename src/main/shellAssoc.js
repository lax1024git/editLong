const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const MENU_KEY = "EditLongOpen";
const MENU_LABEL = "用 EditLong 打开";
const PROGID = "EditLong.Document";
const APP_NAME = "EditLong";

const OPEN_WITH_EXTS = [
  "txt",
  "log",
  "md",
  "json",
  "xml",
  "csv",
  "ini",
  "cfg",
  "conf",
  "js",
  "ts",
  "css",
  "html",
  "htm",
  "py",
  "c",
  "cpp",
  "h",
  "java",
  "sql",
  "bat",
  "cmd",
  "yml",
  "yaml",
  "bin",
  "dat",
  "hex",
];

function quote(s) {
  return '"' + String(s).replace(/"/g, '\\"') + '"';
}

function openCommand() {
  if (app.isPackaged) {
    return quote(process.execPath) + " " + '"%1"';
  }
  return quote(process.execPath) + " " + quote(app.getAppPath()) + " " + '"%1"';
}

function iconPath() {
  if (app.isPackaged) return process.execPath + ",0";
  const ico = path.join(app.getAppPath(), "build", "icon.ico");
  return fs.existsSync(ico) ? ico : process.execPath + ",0";
}

function appExeName() {
  return path.basename(process.execPath);
}

function runReg(args) {
  return new Promise((resolve) => {
    execFile("reg.exe", args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: String(stderr || err.message || err) });
        return;
      }
      resolve({ ok: true, text: String(stdout || "") });
    });
  });
}

async function regAdd(key, valueName, data, type) {
  const args = ["ADD", key, "/f"];
  if (valueName == null) args.push("/ve");
  else args.push("/v", valueName);
  if (type === "NONE") {
    args.push("/t", "REG_NONE");
  } else {
    if (type) args.push("/t", type);
    args.push("/d", data == null ? "" : String(data));
  }
  return runReg(args);
}

async function regDelete(key) {
  const r = await runReg(["DELETE", key, "/f"]);
  if (!r.ok && /unable to find|找不到|cannot find/i.test(r.error || "")) {
    return { ok: true };
  }
  return r;
}

async function registerOpenWith(cmd, icon) {
  const exeName = appExeName();
  const appKey = "HKCU\\Software\\Classes\\Applications\\" + exeName;
  const progKey = "HKCU\\Software\\Classes\\" + PROGID;
  const appPaths = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exeName;

  let r = await regAdd(progKey, null, APP_NAME + " 文档");
  if (!r.ok) return r;
  r = await regAdd(progKey + "\\DefaultIcon", null, icon);
  if (!r.ok) return r;
  r = await regAdd(progKey + "\\shell\\open\\command", null, cmd);
  if (!r.ok) return r;

  r = await regAdd(appKey, "FriendlyAppName", APP_NAME);
  if (!r.ok) return r;
  r = await regAdd(appKey + "\\DefaultIcon", null, icon);
  if (!r.ok) return r;
  r = await regAdd(appKey + "\\shell\\open\\command", null, cmd);
  if (!r.ok) return r;
  r = await regAdd(appKey + "\\SupportedTypes", ".*", "");
  if (!r.ok) return r;
  for (const ext of OPEN_WITH_EXTS) {
    r = await regAdd(appKey + "\\SupportedTypes", "." + ext, "");
    if (!r.ok) return r;
  }

  r = await regAdd("HKCU\\Software\\Classes\\*\\OpenWithList\\" + exeName, null, "");
  if (!r.ok) return r;
  r = await regAdd("HKCU\\Software\\Classes\\*\\OpenWithProgids", PROGID, null, "NONE");
  if (!r.ok) return r;

  for (const ext of OPEN_WITH_EXTS) {
    r = await regAdd("HKCU\\Software\\Classes\\." + ext + "\\OpenWithProgids", PROGID, null, "NONE");
    if (!r.ok) return r;
    r = await regAdd("HKCU\\Software\\Classes\\." + ext + "\\OpenWithList\\" + exeName, null, "");
    if (!r.ok) return r;
  }

  r = await regAdd(appPaths, null, process.execPath);
  if (!r.ok) return r;
  r = await regAdd(appPaths, "Path", path.dirname(process.execPath));
  return r;
}

async function unregisterOpenWith() {
  const exeName = appExeName();
  const keys = [
    "HKCU\\Software\\Classes\\Applications\\" + exeName,
    "HKCU\\Software\\Classes\\" + PROGID,
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exeName,
    "HKCU\\Software\\Classes\\*\\OpenWithList\\" + exeName,
  ];
  for (const key of keys) {
    const r = await regDelete(key);
    if (!r.ok) return r;
  }
  await runReg(["DELETE", "HKCU\\Software\\Classes\\*\\OpenWithProgids", "/v", PROGID, "/f"]);
  for (const ext of OPEN_WITH_EXTS) {
    await runReg([
      "DELETE",
      "HKCU\\Software\\Classes\\." + ext + "\\OpenWithProgids",
      "/v",
      PROGID,
      "/f",
    ]);
    await regDelete("HKCU\\Software\\Classes\\." + ext + "\\OpenWithList\\" + exeName);
  }
  return { ok: true };
}

async function registerContextMenu() {
  if (process.platform !== "win32") {
    return { ok: false, error: "仅支持 Windows" };
  }
  const base = "HKCU\\Software\\Classes\\*\\shell\\" + MENU_KEY;
  const cmd = openCommand();
  const icon = iconPath();
  let r = await regAdd(base, null, MENU_LABEL);
  if (!r.ok) return r;
  r = await regAdd(base, "Icon", icon.replace(/,0$/, ""));
  if (!r.ok) return r;
  r = await regAdd(base + "\\command", null, cmd);
  if (!r.ok) return r;
  r = await registerOpenWith(cmd, icon);
  return r.ok ? { ok: true } : r;
}

async function unregisterContextMenu() {
  if (process.platform !== "win32") {
    return { ok: false, error: "仅支持 Windows" };
  }
  const base = "HKCU\\Software\\Classes\\*\\shell\\" + MENU_KEY;
  let r = await regDelete(base);
  if (!r.ok) return r;
  r = await unregisterOpenWith();
  return r.ok ? { ok: true } : r;
}

async function isContextMenuRegistered() {
  if (process.platform !== "win32") return false;
  const base = "HKCU\\Software\\Classes\\*\\shell\\" + MENU_KEY;
  const r = await runReg(["QUERY", base, "/ve"]);
  return r.ok;
}

function collectOpenPaths(argv) {
  const skipNames = new Set(["electron.exe", "electron", "editlong.exe", "editlong"]);
  const files = [];
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg.startsWith("-")) continue;
    if (arg === ".") continue;
    const base = path.basename(arg).toLowerCase();
    if (skipNames.has(base)) continue;
    if (base === "main.js" || base === "package.json") continue;
    let resolved;
    try {
      resolved = path.resolve(arg);
    } catch {
      continue;
    }
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    } catch {
      continue;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(resolved);
  }
  return files;
}

module.exports = {
  registerContextMenu,
  unregisterContextMenu,
  isContextMenuRegistered,
  collectOpenPaths,
  MENU_LABEL,
  OPEN_WITH_EXTS,
};
