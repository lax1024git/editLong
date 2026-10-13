const {
  BrowserWindow,
  desktopCapturer,
  screen,
  ipcMain,
  dialog,
  clipboard,
  globalShortcut,
  nativeImage,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const TOOLBAR = 32;
const PIN_MIN_WIDTH = 660;
const PIN_MIN_HEIGHT = TOOLBAR + 48;
const DEFAULT_SHORTCUT = "CommandOrControl+Shift+A";

let snipping = false;
let capturing = false;
let overlayWindows = [];
const pins = new Map();
const frames = new Map();
const frameFiles = [];
let settingsPath = "";
let currentShortcut = DEFAULT_SHORTCUT;
let rebuildMenu = () => {};
let pickWaiter = null;
let lastSnipAccel = "";

function prettyAccel(acc) {
  return String(acc || "")
    .replace(/CommandOrControl/g, "Ctrl")
    .replace(/Command/g, "Cmd")
    .replace(/Control/g, "Ctrl");
}

function loadShortcut() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (data && typeof data.snipShortcut === "string" && data.snipShortcut.trim()) {
      currentShortcut = data.snipShortcut.trim();
    }
  } catch {
    currentShortcut = DEFAULT_SHORTCUT;
  }
}

function saveShortcut() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    data = {};
  }
  data.snipShortcut = currentShortcut;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

function registerCurrentShortcut() {
  if (lastSnipAccel) {
    try {
      globalShortcut.unregister(lastSnipAccel);
    } catch {
      /* ignore */
    }
  }
  if (!currentShortcut) return { ok: true };
  const ok = globalShortcut.register(currentShortcut, () => {
    startRegionSnip();
  });
  if (ok) lastSnipAccel = currentShortcut;
  return { ok, shortcut: currentShortcut, label: prettyAccel(currentShortcut) };
}

function rendererDir() {
  return path.join(__dirname, "..", "renderer");
}

function closeOverlays() {
  overlayWindows.forEach((w) => {
    if (!w.isDestroyed()) w.close();
  });
  overlayWindows = [];
  snipping = false;
}

function cleanupFrameFiles() {
  frameFiles.splice(0).forEach((file) => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  });
}

function cancelSnip() {
  closeOverlays();
  frames.clear();
  cleanupFrameFiles();
  capturing = false;
  if (pickWaiter) {
    const done = pickWaiter;
    pickWaiter = null;
    done(null);
  }
}

function findSource(sources, display) {
  const id = String(display.id);
  let source = sources.find((s) => String(s.display_id) === id);
  if (source) return source;
  if (sources.length === 1) return sources[0];
  const phys = displayPhysicalBounds(display);
  source = sources.find((s) => {
    const size = s.thumbnail.getSize();
    return Math.abs(size.width - phys.width) < 8 && Math.abs(size.height - phys.height) < 8;
  });
  return source || sources[0];
}

function isMostlyBlack(image) {
  const size = image.getSize();
  if (size.width < 8 || size.height < 8) return true;
  const bmp = image.getBitmap();
  if (!bmp || !bmp.length) return true;
  let dark = 0;
  const samples = 80;
  for (let i = 0; i < samples; i++) {
    const x = (i * 17) % size.width;
    const y = (i * 31) % size.height;
    const o = (y * size.width + x) * 4;
    if (bmp[o] + bmp[o + 1] + bmp[o + 2] < 24) dark += 1;
  }
  return dark > samples * 0.92;
}

function displayPhysicalBounds(display) {
  const dip = {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width || display.size.width,
    height: display.bounds.height || display.size.height,
  };
  try {
    if (typeof screen.dipToScreenRect === "function") {
      const phys = screen.dipToScreenRect(null, dip);
      if (phys && phys.width > 0 && phys.height > 0) {
        return {
          x: Math.round(phys.x),
          y: Math.round(phys.y),
          width: Math.max(1, Math.round(phys.width)),
          height: Math.max(1, Math.round(phys.height)),
        };
      }
    }
  } catch {
    /* fall through */
  }
  const s = display.scaleFactor || 1;
  return {
    x: Math.round(dip.x * s),
    y: Math.round(dip.y * s),
    width: Math.max(1, Math.round(dip.width * s)),
    height: Math.max(1, Math.round(dip.height * s)),
  };
}

function captureDisplayGdi(display) {
  const phys = displayPhysicalBounds(display);
  const tmp = path.join(os.tmpdir(), "editlong-gdi-" + display.id + "-" + Date.now() + ".png");
  const tmpEsc = tmp.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$b = New-Object System.Drawing.Bitmap(${phys.width}, ${phys.height})`,
    "$g = [System.Drawing.Graphics]::FromImage($b)",
    `$g.CopyFromScreen(${phys.x}, ${phys.y}, 0, 0, $b.Size)`,
    `$b.Save('${tmpEsc}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose()",
    "$b.Dispose()",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
    windowsHide: true,
    timeout: 20000,
  });
  const image = nativeImage.createFromPath(tmp);
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  if (image.isEmpty()) throw new Error("GDI 截屏为空");
  return image;
}

async function withAppHidden(fn) {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible());
  wins.forEach((w) => w.hide());
  await new Promise((r) => setTimeout(r, 140));
  try {
    return await fn();
  } finally {
    wins.forEach((w) => {
      if (!w.isDestroyed()) w.showInactive();
    });
  }
}

async function captureDisplay(display) {
  const phys = displayPhysicalBounds(display);
  const thumbW = phys.width;
  const thumbH = phys.height;
  let image = null;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
    const source = findSource(sources, display);
    if (source && !source.thumbnail.isEmpty()) image = source.thumbnail;
  } catch {
    image = null;
  }
  if (!image || isMostlyBlack(image)) {
    if (process.platform === "win32") image = captureDisplayGdi(display);
  }
  if (!image || image.isEmpty()) throw new Error("无法获取屏幕画面");
  const size = image.getSize();
  if (size.width < 8 || size.height < 8) {
    throw new Error("屏幕截取失败，画面为空");
  }
  return image;
}

function cropFrame(image, display, rect) {
  const size = image.getSize();
  const viewW = Math.max(1, Number(rect.viewW) || display.bounds.width || display.size.width);
  const viewH = Math.max(1, Number(rect.viewH) || display.bounds.height || display.size.height);

  // 按预览窗口实际像素比例映射，并对角取整，避免宽高各自四舍五入造成偏移
  let x1 = Math.round((rect.x / viewW) * size.width);
  let y1 = Math.round((rect.y / viewH) * size.height);
  let x2 = Math.round(((rect.x + rect.width) / viewW) * size.width);
  let y2 = Math.round(((rect.y + rect.height) / viewH) * size.height);

  // 若可用，再用 DIP→物理 坐标校正（多屏/非整数缩放更稳）
  try {
    if (typeof screen.dipToScreenRect === "function") {
      const dipFull = {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width || display.size.width,
        height: display.bounds.height || display.size.height,
      };
      const dipSel = {
        x: display.bounds.x + rect.x,
        y: display.bounds.y + rect.y,
        width: rect.width,
        height: rect.height,
      };
      const physFull = screen.dipToScreenRect(null, dipFull);
      const physSel = screen.dipToScreenRect(null, dipSel);
      if (physFull && physSel && physFull.width > 0 && physFull.height > 0) {
        const sx = size.width / physFull.width;
        const sy = size.height / physFull.height;
        x1 = Math.round((physSel.x - physFull.x) * sx);
        y1 = Math.round((physSel.y - physFull.y) * sy);
        x2 = Math.round((physSel.x - physFull.x + physSel.width) * sx);
        y2 = Math.round((physSel.y - physFull.y + physSel.height) * sy);
      }
    }
  } catch {
    /* keep ratio mapping */
  }

  x1 = Math.max(0, Math.min(size.width - 1, x1));
  y1 = Math.max(0, Math.min(size.height - 1, y1));
  x2 = Math.max(x1 + 1, Math.min(size.width, x2));
  y2 = Math.max(y1 + 1, Math.min(size.height, y2));
  return image.crop({
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  });
}

function createPin(image, screenX, screenY, dipW, dipH) {
  const pin = new BrowserWindow({
    width: Math.max(PIN_MIN_WIDTH, Math.round(dipW)),
    height: Math.max(PIN_MIN_HEIGHT, Math.round(dipH) + TOOLBAR),
    minWidth: PIN_MIN_WIDTH,
    minHeight: PIN_MIN_HEIGHT,
    x: Math.round(screenX),
    y: Math.round(screenY),
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#1f1f1f",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload-pin.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  pin.setMinimumSize(PIN_MIN_WIDTH, PIN_MIN_HEIGHT);
  pin.setAlwaysOnTop(true, "screen-saver");
  pin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pin.webContents.on("zoom-changed", (_e, direction) => {
    pin.webContents.setZoomFactor(1);
    pin.webContents.setZoomLevel(0);
    pin.webContents.send("pin:ctrl-zoom", direction);
  });
  pins.set(pin.id, image);
  pin.on("closed", () => pins.delete(pin.id));
  pin.loadFile(path.join(rendererDir(), "pin.html"));
  pin.webContents.on("did-finish-load", () => {
    pin.webContents.setZoomFactor(1);
    pin.webContents.send("pin:image", image.toDataURL());
    pin.show();
  });
}

function finishSnip(payload) {
  capturing = true;
  const display =
    screen.getAllDisplays().find((d) => Number(d.id) === Number(payload.displayId)) ||
    screen.getDisplayNearestPoint({
      x: payload.screenX,
      y: payload.screenY,
    });
  if (pickWaiter) {
    const done = pickWaiter;
    pickWaiter = null;
    closeOverlays();
    frames.clear();
    cleanupFrameFiles();
    capturing = false;
    const dipSel = {
      x: display.bounds.x + payload.x,
      y: display.bounds.y + payload.y,
      width: payload.width,
      height: payload.height,
    };
    let physSel = null;
    try {
      if (typeof screen.dipToScreenRect === "function") {
        physSel = screen.dipToScreenRect(null, dipSel);
      }
    } catch {
      physSel = null;
    }
    if (!physSel) {
      const s = display.scaleFactor || 1;
      physSel = {
        x: Math.round(dipSel.x * s),
        y: Math.round(dipSel.y * s),
        width: Math.round(dipSel.width * s),
        height: Math.round(dipSel.height * s),
      };
    }
    done({
      displayId: display.id,
      x: payload.x,
      y: payload.y,
      width: payload.width,
      height: payload.height,
      screenX: dipSel.x,
      screenY: dipSel.y,
      scale: display.scaleFactor || 1,
      // 物理像素，供 ffmpeg gdigrab 直接使用
      physX: Math.round(physSel.x),
      physY: Math.round(physSel.y),
      physW: Math.max(2, Math.round(physSel.width)),
      physH: Math.max(2, Math.round(physSel.height)),
    });
    return;
  }
  const frame = frames.get(String(display.id)) || frames.get(String(payload.displayId));
  closeOverlays();
  frames.clear();
  cleanupFrameFiles();
  try {
    if (!frame) throw new Error("没有可用的屏幕画面");
    const image = cropFrame(frame, display, {
      x: payload.x,
      y: payload.y,
      width: payload.width,
      height: payload.height,
      viewW: payload.viewW,
      viewH: payload.viewH,
    });
    try {
      clipboard.writeImage(image);
    } catch {
      /* ignore clipboard errors */
    }
    const pinX = display.bounds.x + payload.x;
    const pinY = display.bounds.y + payload.y;
    createPin(image, pinX, pinY, payload.width, payload.height);
  } finally {
    capturing = false;
  }
}

function pickRegion() {
  return new Promise((resolve) => {
    if (pickWaiter) pickWaiter(null);
    pickWaiter = resolve;
    startRegionSnip({ purpose: "record" });
  });
}

async function startRegionSnip(opts = {}) {
  if (snipping || capturing) {
    if (pickWaiter) {
      const done = pickWaiter;
      pickWaiter = null;
      done(null);
    }
    return;
  }
  overlayWindows.forEach((w) => {
    if (!w.isDestroyed()) w.close();
  });
  overlayWindows = [];
  frames.clear();
  cleanupFrameFiles();
  snipping = true;
  const displays = screen.getAllDisplays();
  try {
    await withAppHidden(async () => {
      for (const display of displays) {
        frames.set(String(display.id), await captureDisplay(display));
      }
    });
  } catch (err) {
    snipping = false;
    if (pickWaiter) {
      const done = pickWaiter;
      pickWaiter = null;
      done(null);
      return;
    }
    dialog.showErrorBox("截图失败", String(err.message || err));
    return;
  }
  for (const display of displays) {
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      hasShadow: false,
      enableLargerThanScreen: true,
      backgroundColor: "#1a1a1a",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload-snip.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: false,
        zoomFactor: 1,
      },
    });
    // 强制对齐显示器 DIP 边界，避免窗口实际位置与 bounds 有偏差
    overlay.setBounds({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.loadFile(path.join(rendererDir(), "snip.html"), {
      query: { displayId: String(display.id), purpose: opts.purpose || "snip" },
    });
    overlay.webContents.on("did-finish-load", async () => {
      try {
        overlay.webContents.setZoomFactor(1);
        overlay.webContents.setZoomLevel(0);
      } catch {
        /* ignore */
      }
      try {
        const img = frames.get(String(display.id));
        if (!img) {
          overlay.show();
          return;
        }
        const tmp = path.join(os.tmpdir(), "editlong-snip-" + display.id + "-" + Date.now() + ".png");
        fs.writeFileSync(tmp, img.toPNG());
        frameFiles.push(tmp);
        const fileUrl = pathToFileURL(tmp).href;
        await overlay.webContents.executeJavaScript(
          `new Promise((resolve, reject) => {
            const el = document.getElementById("bg");
            if (!el) return reject(new Error("no bg"));
            el.onload = () => resolve(true);
            el.onerror = () => reject(new Error("bg load"));
            el.src = ${JSON.stringify(fileUrl)};
          })`
        );
      } catch {
        const img = frames.get(String(display.id));
        if (img) {
          try {
            await overlay.webContents.executeJavaScript(
              `document.getElementById("bg").src = ${JSON.stringify(img.toDataURL())}`
            );
          } catch {
            /* still show overlay */
          }
        }
      }
      if (!overlay.isDestroyed()) {
        overlay.setBounds({
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
        });
        overlay.show();
      }
    });
    overlay.on("closed", () => {
      overlayWindows = overlayWindows.filter((w) => w !== overlay);
      if (!overlayWindows.length) snipping = false;
    });
    overlayWindows.push(overlay);
  }
}

function imageFromEvent(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? pins.get(win.id) : null;
}

function registerScreenshot(app, hooks) {
  rebuildMenu = hooks.rebuildMenu || (() => {});
  settingsPath = path.join(app.getPath("userData"), "settings.json");
  loadShortcut();

  ipcMain.handle("snip:start", () => {
    startRegionSnip();
    return true;
  });
  ipcMain.on("snip:cancel", () => cancelSnip());
  ipcMain.on("snip:done", async (e, payload) => {
    try {
      await finishSnip(payload);
    } catch (err) {
      closeOverlays();
      dialog.showErrorBox("截图失败", String(err.message || err));
    }
  });

  ipcMain.handle("pin:save", async (e, format, dataUrl) => {
    const image = dataUrl
      ? nativeImage.createFromDataURL(dataUrl)
      : imageFromEvent(e);
    if (!image) return { cancelled: true };
    const win = BrowserWindow.fromWebContents(e.sender);
    const ext = format === "jpg" ? "jpg" : "png";
    const result = await dialog.showSaveDialog(win, {
      title: "保存截图",
      defaultPath: "screenshot." + ext,
      filters:
        ext === "jpg"
          ? [{ name: "JPEG", extensions: ["jpg", "jpeg"] }]
          : [{ name: "PNG", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    const buf = ext === "jpg" ? image.toJPEG(92) : image.toPNG();
    fs.writeFileSync(result.filePath, buf);
    return { cancelled: false, path: result.filePath };
  });

  ipcMain.handle("pin:copy", (e, dataUrl) => {
    const image = dataUrl
      ? nativeImage.createFromDataURL(dataUrl)
      : imageFromEvent(e);
    if (!image) return { ok: false };
    clipboard.writeImage(image);
    return { ok: true };
  });

  ipcMain.on("pin:close", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle("snip:get-shortcut", () => ({
    shortcut: currentShortcut,
    label: prettyAccel(currentShortcut),
    defaultShortcut: DEFAULT_SHORTCUT,
    defaultLabel: prettyAccel(DEFAULT_SHORTCUT),
  }));

  ipcMain.handle("snip:set-shortcut", (_e, accelerator) => {
    const next = String(accelerator || "").trim();
    if (!next) return { ok: false, error: "快捷键不能为空" };
    if (lastSnipAccel) {
      try {
        globalShortcut.unregister(lastSnipAccel);
      } catch {
        /* ignore */
      }
    }
    const ok = globalShortcut.register(next, () => startRegionSnip());
    if (!ok) {
      registerCurrentShortcut();
      return { ok: false, error: "该快捷键无法注册，可能已被系统占用" };
    }
    currentShortcut = next;
    saveShortcut();
    rebuildMenu();
    return { ok: true, shortcut: currentShortcut, label: prettyAccel(currentShortcut) };
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    closeOverlays();
  });

  return {
    startRegionSnip,
    pickRegion,
    registerShortcut: registerCurrentShortcut,
    prettyAccel,
    getShortcut: () => currentShortcut,
    getShortcutLabel: () => prettyAccel(currentShortcut),
  };
}

module.exports = { registerScreenshot, prettyAccel, DEFAULT_SHORTCUT };
