const { BrowserWindow, ipcMain, dialog, globalShortcut, screen, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let ffmpegProc = null;
let tempFile = "";
let recWin = null;
let recording = false;
let pickRegion = async () => null;
let settingsPath = "";
let micOn = false;
let sysOn = false;
let phase = "setup";
let deviceCache = null;
let deviceCacheAt = 0;

function even(n) {
  n = Math.max(2, Math.floor(n));
  return n % 2 === 0 ? n : n - 1;
}

function resolveFfmpeg() {
  try {
    let bin = require("ffmpeg-static");
    if (bin && bin.includes("app.asar")) {
      bin = bin.replace("app.asar", "app.asar.unpacked");
    }
    if (bin && fs.existsSync(bin)) return bin;
  } catch {
    /* ignore */
  }
  return "ffmpeg";
}

function loadAudioPrefs() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (typeof data.recordMic === "boolean") micOn = data.recordMic;
    if (typeof data.recordSysAudio === "boolean") sysOn = data.recordSysAudio;
  } catch {
    /* keep defaults */
  }
}

function saveAudioPrefs() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    data = {};
  }
  data.recordMic = micOn;
  data.recordSysAudio = sysOn;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

function decodeFfmpegText(buf) {
  if (!buf || !buf.length) return "";
  const utf = buf.toString("utf8");
  if (!utf.includes("\uFFFD")) return utf;
  try {
    const iconv = require("iconv-lite");
    return iconv.decode(buf, "cp936");
  } catch {
    return utf;
  }
}

function isLoopbackName(name) {
  return /立体声混音|立体聲混音|stereo\s*mix|wave\s*out\s*mix|what\s*u\s*hear|loopback|cable|vb-audio|voicemeeter|系统音频|系統音訊/i.test(
    name,
  );
}

function isMicName(name) {
  return /麦克风|麥克風|microphone|\bmic\b/i.test(name);
}

function listDshowAudio() {
  const ffmpeg = resolveFfmpeg();
  const r = spawnSync(
    ffmpeg,
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { windowsHide: true, timeout: 20000, encoding: "buffer" },
  );
  const text = decodeFfmpegText(r.stderr) + decodeFfmpegText(r.stdout);
  const names = [];
  const re = /"([^"]+)"\s+\(audio\)/gi;
  let m;
  while ((m = re.exec(text))) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function pickAudioDevices() {
  if (deviceCache && Date.now() - deviceCacheAt < 20000) return deviceCache;
  const names = listDshowAudio();
  const sys = names.find(isLoopbackName) || "";
  const mic =
    names.find((n) => isMicName(n) && !isLoopbackName(n)) ||
    names.find((n) => !isLoopbackName(n)) ||
    "";
  deviceCache = { names, mic, sys };
  deviceCacheAt = Date.now();
  return deviceCache;
}

function recState() {
  const devices = deviceCache || { names: [], mic: "", sys: "" };
  return {
    phase,
    recording,
    micOn,
    sysOn,
    micDevice: devices.mic,
    sysDevice: devices.sys,
    audioDevices: devices.names,
  };
}

function sendRecState() {
  if (recWin && !recWin.isDestroyed()) {
    recWin.webContents.send("rec:state", recState());
  }
}

function stopProcess() {
  return new Promise((resolve) => {
    if (!ffmpegProc) return resolve();
    const proc = ffmpegProc;
    ffmpegProc = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    proc.once("close", finish);
    try {
      proc.stdin.write("q\n");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (!done) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish();
      }
    }, 6000);
  });
}

function closeRecWin() {
  if (recWin && !recWin.isDestroyed()) recWin.close();
  recWin = null;
  phase = "setup";
}

function placeSetupWindow() {
  const w = 320;
  const h = 176;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const b = display.workArea;
  recWin.setBounds({
    width: w,
    height: h,
    x: Math.round(b.x + (b.width - w) / 2),
    y: Math.round(b.y + (b.height - h) / 2),
  });
}

function placeRecBar(region) {
  const w = 280;
  const h = 46;
  let x = Math.round(region.screenX + region.width / 2 - w / 2);
  let y = Math.round(region.screenY + region.height + 10);
  const display = screen.getDisplayNearestPoint({
    x: Math.round(region.screenX),
    y: Math.round(region.screenY),
  });
  const bounds = display.bounds;
  if (y + h > bounds.y + bounds.height - 4) {
    y = Math.round(region.screenY - h - 10);
  }
  if (y < bounds.y) y = bounds.y + 8;
  x = Math.min(Math.max(bounds.x + 8, x), bounds.x + bounds.width - w - 8);
  recWin.setBounds({ width: w, height: h, x, y });
}

function ensureRecWindow() {
  if (recWin && !recWin.isDestroyed()) return recWin;
  recWin = new BrowserWindow({
    width: 320,
    height: 176,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: true,
    backgroundColor: "#2b2b2b",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload-rec.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  recWin.setAlwaysOnTop(true, "screen-saver");
  recWin.loadFile(path.join(__dirname, "..", "renderer", "rec.html"));
  recWin.webContents.on("did-finish-load", () => sendRecState());
  recWin.on("closed", () => {
    recWin = null;
    phase = "setup";
    if (recording) stopRecord(true);
  });
  return recWin;
}

function buildAudioArgs(wantMic, wantSys) {
  const devices = pickAudioDevices();
  const args = [];
  const warnings = [];
  let micName = "";
  let sysName = "";
  let useWasapi = false;

  if (wantMic) {
    if (devices.mic) micName = devices.mic;
    else warnings.push("未检测到麦克风，将不录麦克风。");
  }
  if (wantSys) {
    if (devices.sys) sysName = devices.sys;
    else useWasapi = true;
  }

  if (micName) {
    args.push("-thread_queue_size", "1024", "-f", "dshow", "-audio_buffer_size", "80", "-i", "audio=" + micName);
  }
  if (sysName) {
    args.push("-thread_queue_size", "1024", "-f", "dshow", "-audio_buffer_size", "80", "-i", "audio=" + sysName);
  } else if (useWasapi) {
    args.push("-thread_queue_size", "1024", "-f", "wasapi", "-i", "loopback");
  }

  const audioInputs = (micName ? 1 : 0) + (sysName || useWasapi ? 1 : 0);
  if (audioInputs === 0) {
    args.push("-an");
  } else if (audioInputs === 1) {
    args.push("-map", "0:v", "-map", "1:a", "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k");
  } else {
    args.push(
      "-filter_complex",
      "[1:a][2:a]amix=inputs=2:duration=longest:dropout_transition=2[aout]",
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:a",
      "aac",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "128k",
    );
  }
  return { args, warnings, audioInputs, useWasapi, micName, sysName };
}

function startRecord() {
  if (recording) {
    stopRecord(true);
    return;
  }
  if (recWin && !recWin.isDestroyed()) {
    recWin.show();
    recWin.focus();
    sendRecState();
    return;
  }
  phase = "setup";
  ensureRecWindow();
  placeSetupWindow();
  recWin.show();
  recWin.focus();
  setImmediate(() => {
    deviceCache = null;
    deviceCacheAt = 0;
    pickAudioDevices();
    sendRecState();
  });
}

async function beginRecord() {
  if (recording) return { ok: false, error: "正在录制" };
  ensureRecWindow();
  if (recWin && !recWin.isDestroyed()) recWin.hide();

  const region = await pickRegion();
  if (!region || region.width < 4 || region.height < 4) {
    if (recWin && !recWin.isDestroyed()) {
      phase = "setup";
      placeSetupWindow();
      recWin.show();
      sendRecState();
    }
    return { ok: false, cancelled: true };
  }

  const scale = region.scale || 1;
  const x = even(Math.round(region.screenX * scale));
  const y = even(Math.round(region.screenY * scale));
  const vw = even(Math.round(region.width * scale));
  const vh = even(Math.round(region.height * scale));
  let audio = buildAudioArgs(micOn, sysOn);
  const notes = audio.warnings.slice();
  if (sysOn && audio.useWasapi) {
    notes.push("未找到立体声混音，将尝试 WASAPI 环回采集电脑声音。");
  }
  if (notes.length) {
    const buttons = sysOn && audio.useWasapi ? ["继续", "不录电脑音频", "取消"] : ["继续", "取消"];
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      title: "录音设备",
      message: notes.join("\n"),
      detail: "可在 Windows 声音设置中启用立体声混音，并允许应用使用麦克风。",
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });
    const cancelId = buttons.length - 1;
    if (choice === cancelId) {
      if (recWin && !recWin.isDestroyed()) {
        phase = "setup";
        placeSetupWindow();
        recWin.show();
        sendRecState();
      }
      return { ok: false, cancelled: true };
    }
    if (sysOn && audio.useWasapi && choice === 1) {
      audio = buildAudioArgs(micOn, false);
    }
  }

  tempFile = path.join(os.tmpdir(), "editlong-rec-" + Date.now() + ".mp4");
  const ffmpeg = resolveFfmpeg();
  const args = [
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    "30",
    "-draw_mouse",
    "1",
    "-offset_x",
    String(x),
    "-offset_y",
    String(y),
    "-video_size",
    vw + "x" + vh,
    "-i",
    "desktop",
    ...audio.args,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    tempFile,
  ];

  recording = true;
  phase = "recording";
  if (!recWin || recWin.isDestroyed()) ensureRecWindow();
  placeRecBar(region);
  recWin.show();
  sendRecState();

  ffmpegProc = spawn(ffmpeg, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let errLog = "";
  ffmpegProc.on("error", (err) => {
    recording = false;
    phase = "setup";
    closeRecWin();
    dialog.showErrorBox("录屏失败", "无法启动 ffmpeg：\n" + err.message);
  });
  ffmpegProc.stderr.on("data", (chunk) => {
    errLog += chunk.toString("utf8");
    if (errLog.length > 8000) errLog = errLog.slice(-4000);
  });
  ffmpegProc.on("close", (code) => {
    if (recording && code && code !== 0) {
      recording = false;
      const file = tempFile;
      tempFile = "";
      closeRecWin();
      dialog.showErrorBox(
        "录屏失败",
        (errLog || "ffmpeg 退出代码 " + code).slice(-1200),
      );
      try {
        if (file && fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  });
  return { ok: true };
}

async function stopRecord(askSave) {
  if (!recording && !ffmpegProc) {
    closeRecWin();
    return;
  }
  recording = false;
  const file = tempFile;
  tempFile = "";
  closeRecWin();
  await stopProcess();
  if (!askSave) {
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    return;
  }
  if (!file || !fs.existsSync(file) || fs.statSync(file).size < 100) {
    dialog.showErrorBox("录屏失败", "没有生成有效的视频文件。");
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    return;
  }
  const stamp = new Date();
  const name =
    "录屏-" +
    stamp.getFullYear() +
    String(stamp.getMonth() + 1).padStart(2, "0") +
    String(stamp.getDate()).padStart(2, "0") +
    "-" +
    String(stamp.getHours()).padStart(2, "0") +
    String(stamp.getMinutes()).padStart(2, "0") +
    String(stamp.getSeconds()).padStart(2, "0") +
    ".mp4";
  const result = await dialog.showSaveDialog({
    title: "保存录屏",
    defaultPath: name,
    filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
  });
  if (result.canceled || !result.filePath) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    fs.copyFileSync(file, result.filePath);
    fs.unlinkSync(file);
  } catch (err) {
    dialog.showErrorBox("保存失败", String(err.message || err));
    return;
  }
  const choice = await dialog.showMessageBox({
    type: "info",
    title: "录屏完成",
    message: "已保存为 MP4",
    detail: result.filePath,
    buttons: ["打开文件夹", "关闭"],
    defaultId: 0,
  });
  if (choice.response === 0) shell.showItemInFolder(result.filePath);
}

function registerRecorder(app, hooks) {
  pickRegion = hooks.pickRegion || pickRegion;
  settingsPath = path.join(app.getPath("userData"), "settings.json");
  loadAudioPrefs();

  ipcMain.handle("record:start", () => startRecord());
  ipcMain.handle("record:state", () => recState());
  ipcMain.handle("record:set-audio", (_e, next) => {
    if (recording) return recState();
    if (typeof next.micOn === "boolean") micOn = next.micOn;
    if (typeof next.sysOn === "boolean") sysOn = next.sysOn;
    saveAudioPrefs();
    sendRecState();
    return recState();
  });
  ipcMain.handle("record:begin", () => beginRecord());
  ipcMain.on("record:stop", () => stopRecord(true));
  ipcMain.on("record:cancel", () => {
    if (!recording) closeRecWin();
  });

  app.whenReady().then(() => {
    globalShortcut.register("CommandOrControl+Shift+R", () => {
      if (recording) stopRecord(true);
      else startRecord();
    });
  });

  app.on("will-quit", () => {
    stopRecord(false);
  });

  return { startRecord, stopRecord };
}

module.exports = { registerRecorder };
