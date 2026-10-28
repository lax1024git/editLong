const { spawn } = require("child_process");
const fs = require("fs");
const iconv = require("iconv-lite");

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

function decodeFfmpegText(buf) {
  if (!buf || !buf.length) return "";
  try {
    return iconv.decode(buf, "cp936");
  } catch {
    return buf.toString("utf8");
  }
}

/** Parse `time=HH:MM:SS.xx` from ffmpeg progress stderr */
function parseProgressSeconds(text) {
  const m = String(text || "").match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Run ffmpeg; resolve when process exits 0.
 * @param {string[]} args
 * @param {{ onStderr?: (chunk: string) => void, onProgress?: (sec: number) => void, timeoutMs?: number }} [opts]
 */
function runFfmpeg(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpeg();
    const proc = spawn(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errText = "";
    let settled = false;
    const timeoutMs = opts.timeoutMs || 0;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        if (!settled) {
          settled = true;
          reject(new Error("ffmpeg 超时"));
        }
      }, timeoutMs);
    }
    proc.stderr.on("data", (chunk) => {
      const text = decodeFfmpegText(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      errText += text;
      if (opts.onStderr) opts.onStderr(text);
      if (opts.onProgress) {
        const sec = parseProgressSeconds(text);
        if (sec != null) opts.onProgress(sec);
      }
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ ok: true, log: errText });
      else {
        const tip = errText.trim().split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
        reject(new Error(tip || "ffmpeg 失败，退出码 " + code));
      }
    });
  });
}

/** Parse duration seconds from ffmpeg -i stderr */
function parseDurationSeconds(log) {
  const m = String(log || "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function probeMedia(filePath) {
  const bin = resolveFfmpeg();
  return new Promise((resolve) => {
    const proc = spawn(bin, ["-hide_banner", "-i", filePath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errText = "";
    proc.stderr.on("data", (chunk) => {
      errText += decodeFfmpegText(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    proc.on("close", () => {
      const duration = parseDurationSeconds(errText);
      const hasVideo = /Stream #\d+:\d+.*Video:/i.test(errText);
      const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(errText);
      const vMatch = errText.match(/Video:\s*([^\s,]+)/i);
      const aMatch = errText.match(/Audio:\s*([^\s,]+)/i);
      const sizeMatch = errText.match(/,\s*(\d{2,5})x(\d{2,5})/);
      resolve({
        ok: true,
        path: filePath,
        duration,
        hasVideo,
        hasAudio,
        videoCodec: vMatch ? vMatch[1] : "",
        audioCodec: aMatch ? aMatch[1] : "",
        width: sizeMatch ? Number(sizeMatch[1]) : null,
        height: sizeMatch ? Number(sizeMatch[2]) : null,
      });
    });
    proc.on("error", (err) => {
      resolve({ ok: false, error: String(err.message || err) });
    });
  });
}

module.exports = {
  resolveFfmpeg,
  runFfmpeg,
  probeMedia,
  parseDurationSeconds,
  parseProgressSeconds,
  decodeFfmpegText,
};
