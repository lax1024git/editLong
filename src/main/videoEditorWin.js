const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { BrowserWindow, protocol, net, ipcMain } = require("electron");
const { runFfmpeg, probeMedia } = require("./ffmpeg");
const { runVideoEdit } = require("./videoEdit");

let videoWin = null;
let getMainWindow = null;
let filmstripDir = null;
let protocolReady = false;

function registerMediaSchemePrivileged() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "editlong-media",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
}

function pathToMediaUrl(filePath) {
  const b64 = Buffer.from(String(filePath), "utf8").toString("base64url");
  return "editlong-media://local/" + b64;
}

function mediaUrlToPath(requestUrl) {
  try {
    const u = new URL(requestUrl);
    let b64 = (u.pathname || "").replace(/^\/+/, "");
    if (!b64 && u.hostname && u.hostname !== "local") b64 = u.hostname;
    if (!b64) return null;
    return Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function registerMediaProtocol() {
  if (protocolReady) return;
  protocol.handle("editlong-media", (request) => {
    const filePath = mediaUrlToPath(request.url);
    if (!filePath || !fs.existsSync(filePath)) {
      return new Response("Not Found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });
  protocolReady = true;
}

async function clearFilmstripDir() {
  if (!filmstripDir) return;
  const dir = filmstripDir;
  filmstripDir = null;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function buildFilmstrip(videoPath, count) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { ok: false, error: "视频文件不存在" };
  }
  const probe = await probeMedia(videoPath);
  if (!probe.ok) return { ok: false, error: probe.error || "无法解析视频" };
  const duration = Number(probe.duration) || 0;
  if (duration <= 0) return { ok: false, error: "无法获取视频时长" };

  const n = Math.min(40, Math.max(12, Math.round(Number(count) || 32)));
  await clearFilmstripDir();
  const dir = path.join(os.tmpdir(), "editlong-filmstrip-" + Date.now());
  await fsp.mkdir(dir, { recursive: true });
  filmstripDir = dir;

  const fps = n / duration;
  try {
    await runFfmpeg(
      [
        "-y",
        "-hide_banner",
        "-i",
        videoPath,
        "-vf",
        "fps=" + fps.toFixed(5) + ",scale=160:-1",
        "-q:v",
        "6",
        "-frames:v",
        String(n),
        path.join(dir, "f_%03d.jpg"),
      ],
      { timeoutMs: 120000 },
    );
  } catch (err) {
    await clearFilmstripDir();
    return { ok: false, error: String(err.message || err) };
  }

  let files = (await fsp.readdir(dir)).filter((f) => /\.jpe?g$/i.test(f));
  files.sort();
  if (!files.length) {
    await clearFilmstripDir();
    return { ok: false, error: "未能生成胶片预览帧" };
  }

  const frames = files.map((f, i) => {
    const t = files.length <= 1 ? 0 : (i / (files.length - 1)) * duration;
    return {
      time: t,
      url: pathToMediaUrl(path.join(dir, f)),
    };
  });

  return {
    ok: true,
    duration,
    frames,
    mediaUrl: pathToMediaUrl(videoPath),
    probe,
  };
}

function sendProgress(payload) {
  if (videoWin && !videoWin.isDestroyed()) {
    videoWin.webContents.send("video:progress", payload);
  }
}

function createVideoEditorWindow() {
  registerMediaProtocol();
  if (videoWin && !videoWin.isDestroyed()) {
    if (videoWin.isMinimized()) videoWin.restore();
    videoWin.show();
    videoWin.focus();
    return videoWin;
  }

  const parent = typeof getMainWindow === "function" ? getMainWindow() : null;
  const parentOk = parent && !parent.isDestroyed();
  const iconPath = path.join(__dirname, "..", "..", "build", "icon.ico");

  videoWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "视频剪辑 - EditLong",
    backgroundColor: "#1a1a1a",
    show: false,
    parent: parentOk ? parent : undefined,
    modal: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload-video.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  videoWin.once("ready-to-show", () => videoWin.show());
  videoWin.loadFile(path.join(__dirname, "..", "renderer", "video.html"));
  videoWin.on("closed", () => {
    videoWin = null;
    clearFilmstripDir();
  });
  return videoWin;
}

function closeVideoEditorWindow() {
  if (videoWin && !videoWin.isDestroyed()) videoWin.close();
  videoWin = null;
  clearFilmstripDir();
}

function getVideoWindow() {
  if (videoWin && !videoWin.isDestroyed()) return videoWin;
  return typeof getMainWindow === "function" ? getMainWindow() : null;
}

function registerVideoEditor(opts = {}) {
  getMainWindow = typeof opts.getMainWindow === "function" ? opts.getMainWindow : null;

  ipcMain.handle("video:open-window", () => {
    createVideoEditorWindow();
    return true;
  });

  ipcMain.handle("video:to-media-url", (_e, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: "文件不存在" };
    return { ok: true, url: pathToMediaUrl(filePath) };
  });

  ipcMain.handle("video:filmstrip", async (_e, { path: videoPath, count }) => {
    sendProgress({ phase: "filmstrip", message: "正在生成胶片预览…" });
    const result = await buildFilmstrip(videoPath, count);
    sendProgress({ phase: "filmstrip-done", ok: result.ok });
    return result;
  });

  // Override run with progress + duration for percent (registered after videoEdit may already register video:run)
  try {
    ipcMain.removeHandler("video:run");
  } catch {
    /* ignore */
  }
  ipcMain.handle("video:run", async (e, payload) => {
    const data = payload || {};
    const sender = e.sender;
    let durationHint = Number(data.duration) || 0;
    if (!durationHint && data.inputPath) {
      const p = await probeMedia(data.inputPath);
      durationHint = Number(p.duration) || 0;
    }
    sendProgress({ phase: "export", time: 0, percent: 0, message: "开始导出…" });
    const result = await runVideoEdit(
      {
        ...data,
        onProgress: (sec) => {
          const percent =
            durationHint > 0 ? Math.min(99, Math.round((sec / durationHint) * 100)) : null;
          if (sender && !sender.isDestroyed()) {
            sender.send("video:progress", {
              phase: "export",
              time: sec,
              percent,
              duration: durationHint,
            });
          }
        },
      },
      getVideoWindow,
    );
    if (result && result.ok && !result.cancelled) {
      sendProgress({ phase: "done", percent: 100, path: result.path });
    } else if (result && result.cancelled) {
      sendProgress({ phase: "cancelled" });
    } else {
      sendProgress({ phase: "error", error: (result && result.error) || "导出失败" });
    }
    return result;
  });

  return {
    open: createVideoEditorWindow,
    close: closeVideoEditorWindow,
    getWindow: getVideoWindow,
    registerMediaSchemePrivileged,
    registerMediaProtocol,
  };
}

module.exports = {
  registerVideoEditor,
  registerMediaSchemePrivileged,
  createVideoEditorWindow,
  closeVideoEditorWindow,
  pathToMediaUrl,
};
