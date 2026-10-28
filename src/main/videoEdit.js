const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { dialog, shell } = require("electron");
const { runFfmpeg, probeMedia } = require("./ffmpeg");

const VIDEO_FILTERS = [
  {
    name: "视频",
    extensions: ["mp4", "webm", "mkv", "mov", "avi", "flv", "wmv", "m4v", "ts"],
  },
  { name: "所有文件", extensions: ["*"] },
];

const AUDIO_FILTERS = [
  {
    name: "音频",
    extensions: ["mp3", "wav", "aac", "m4a", "flac", "ogg", "wma"],
  },
  { name: "所有文件", extensions: ["*"] },
];

const FORMAT_PRESETS = {
  mp4: { ext: "mp4", vcodec: "libx264", acodec: "aac", extra: ["-movflags", "+faststart"] },
  webm: { ext: "webm", vcodec: "libvpx-vp9", acodec: "libopus", extra: [] },
  mkv: { ext: "mkv", vcodec: "libx264", acodec: "aac", extra: [] },
  mov: { ext: "mov", vcodec: "libx264", acodec: "aac", extra: ["-movflags", "+faststart"] },
  avi: { ext: "avi", vcodec: "libx264", acodec: "mp3", extra: [] },
  mp3: { ext: "mp3", vcodec: null, acodec: "libmp3lame", extra: [] },
  wav: { ext: "wav", vcodec: null, acodec: "pcm_s16le", extra: [] },
  aac: { ext: "aac", vcodec: null, acodec: "aac", extra: [] },
};

function parseTimeToSeconds(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Number(s));
  const m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
  if (!m) return null;
  if (m[3] != null) {
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

function defaultOutName(inputPath, suffix, ext) {
  const base = path.basename(inputPath, path.extname(inputPath));
  return base + (suffix || "") + "." + ext.replace(/^\./, "");
}

async function pickSavePath(getWindow, defaultName, filters) {
  const win = getWindow();
  const result = await dialog.showSaveDialog(win, {
    title: "保存输出文件",
    defaultPath: defaultName,
    filters: filters || VIDEO_FILTERS,
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

async function ensureParentDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

function compressCrf(level) {
  const n = String(level || "medium");
  if (n === "high") return 18;
  if (n === "low") return 32;
  if (n === "very-low") return 36;
  return 28; // medium
}

/**
 * @param {{
 *   action: "trim"|"convert"|"compress"|"mix"|"concat-clips",
 *   inputPath: string,
 *   audioPath?: string,
 *   start?: string|number,
 *   end?: string|number,
 *   clips?: { start: number, end: number }[],
 *   format?: string,
 *   quality?: string,
 *   mixMode?: "replace"|"mix",
 *   copyStreams?: boolean,
 *   outputPath?: string,
 *   onProgress?: (sec: number) => void,
 * }} opts
 */
async function runVideoEdit(opts, getWindow) {
  const action = opts && opts.action;
  const inputPath = opts && opts.inputPath;
  if (!inputPath || !fs.existsSync(inputPath)) {
    return { ok: false, error: "请选择有效的输入文件" };
  }
  if (!action) return { ok: false, error: "未指定操作" };

  const start = parseTimeToSeconds(opts.start);
  const end = parseTimeToSeconds(opts.end);
  if (action !== "concat-clips" && start != null && end != null && end <= start) {
    return { ok: false, error: "结束时间必须大于开始时间" };
  }

  let formatKey = String(opts.format || "mp4").toLowerCase();
  if (action === "mix" && !FORMAT_PRESETS[formatKey]) formatKey = "mp4";
  if (action === "compress" || action === "concat-clips") formatKey = "mp4";
  const preset = FORMAT_PRESETS[formatKey] || FORMAT_PRESETS.mp4;

  let outputPath = opts.outputPath;
  if (!outputPath) {
    const suffix =
      action === "trim"
        ? "_trim"
        : action === "compress"
          ? "_compressed"
          : action === "mix"
            ? "_mix"
            : action === "concat-clips"
              ? "_edited"
              : "_converted";
    const filters =
      preset.vcodec == null
        ? AUDIO_FILTERS
        : [{ name: preset.ext.toUpperCase(), extensions: [preset.ext] }, ...VIDEO_FILTERS];
    outputPath = await pickSavePath(
      getWindow,
      defaultOutName(inputPath, suffix, preset.ext),
      filters,
    );
    if (!outputPath) return { ok: true, cancelled: true };
  }

  // ensure extension matches format
  const wantExt = "." + preset.ext;
  if (path.extname(outputPath).toLowerCase() !== wantExt) {
    outputPath = outputPath.replace(/\.[^.]+$/, "") + wantExt;
  }
  if (path.resolve(outputPath) === path.resolve(inputPath)) {
    return { ok: false, error: "输出路径不能与输入文件相同" };
  }

  await ensureParentDir(outputPath);

  try {
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : undefined;
    if (action === "concat-clips") {
      await exportConcatClips(
        inputPath,
        opts.clips || [],
        outputPath,
        preset,
        Boolean(opts.copyStreams),
        onProgress,
      );
    } else {
      let args;
      if (action === "trim") {
        args = buildTrimArgs(inputPath, outputPath, start, end, preset, Boolean(opts.copyStreams));
      } else if (action === "convert") {
        args = buildConvertArgs(inputPath, outputPath, start, end, preset);
      } else if (action === "compress") {
        args = buildCompressArgs(inputPath, outputPath, start, end, opts.quality);
      } else if (action === "mix") {
        const audioPath = opts.audioPath;
        if (!audioPath || !fs.existsSync(audioPath)) {
          return { ok: false, error: "请选择要混合的音频文件" };
        }
        args = buildMixArgs(
          inputPath,
          audioPath,
          outputPath,
          start,
          end,
          preset,
          opts.mixMode === "mix" ? "mix" : "replace",
        );
      } else {
        return { ok: false, error: "未知操作：" + action };
      }

      await runFfmpeg(args, { timeoutMs: 0, onProgress });
    }
    const stat = await fsp.stat(outputPath);
    return {
      ok: true,
      cancelled: false,
      path: outputPath,
      size: stat.size,
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function escapeConcatPath(p) {
  return String(p).replace(/\\/g, "/").replace(/'/g, "'\\''");
}

async function exportConcatClips(inputPath, clips, outputPath, preset, copyStreams, onProgress) {
  const kept = (clips || [])
    .map((c) => ({
      start: Number(c.start),
      end: Number(c.end),
    }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end - c.start > 0.05)
    .sort((a, b) => a.start - b.start);
  if (!kept.length) throw new Error("没有可导出的片段（可能已全部删除）");

  if (kept.length === 1) {
    const args = buildTrimArgs(
      inputPath,
      outputPath,
      kept[0].start,
      kept[0].end,
      preset,
      copyStreams,
    );
    await runFfmpeg(args, { timeoutMs: 0, onProgress });
    return;
  }

  const tmpDir = path.join(os.tmpdir(), "editlong-clips-" + Date.now());
  await fsp.mkdir(tmpDir, { recursive: true });
  const parts = [];
  try {
    for (let i = 0; i < kept.length; i++) {
      const part = path.join(tmpDir, "part_" + String(i).padStart(3, "0") + ".mp4");
      // 片段强制重编码，避免 copy 拼接时间戳问题
      const args = buildTrimArgs(inputPath, part, kept[i].start, kept[i].end, preset, false);
      await runFfmpeg(args, {
        timeoutMs: 0,
        onProgress: onProgress
          ? (sec) => onProgress(kept[i].start + sec)
          : undefined,
      });
      parts.push(part);
    }
    const listFile = path.join(tmpDir, "list.txt");
    await fsp.writeFile(
      listFile,
      parts.map((p) => "file '" + escapeConcatPath(p) + "'").join("\n"),
      "utf8",
    );
    await runFfmpeg(
      ["-y", "-hide_banner", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outputPath],
      { timeoutMs: 0, onProgress },
    );
  } finally {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function buildTrimArgs(input, output, start, end, preset, copyStreams) {
  const args = ["-y", "-hide_banner"];
  if (start != null) args.push("-ss", String(start));
  args.push("-i", input);
  if (end != null) {
    if (start != null) args.push("-t", String(Math.max(0.1, end - start)));
    else args.push("-to", String(end));
  }
  if (copyStreams && preset.vcodec) {
    args.push("-c", "copy", "-avoid_negative_ts", "make_zero");
  } else if (preset.vcodec == null) {
    args.push("-vn", "-c:a", preset.acodec);
  } else {
    args.push("-c:v", preset.vcodec, "-preset", "fast", "-crf", "23", "-c:a", preset.acodec, "-b:a", "128k");
    if (preset.extra) args.push(...preset.extra);
  }
  args.push(output);
  return args;
}

function buildConvertArgs(input, output, start, end, preset) {
  const args = ["-y", "-hide_banner"];
  if (start != null) args.push("-ss", String(start));
  args.push("-i", input);
  if (end != null) {
    if (start != null) args.push("-t", String(Math.max(0.1, end - start)));
    else args.push("-to", String(end));
  }
  if (preset.vcodec == null) {
    args.push("-vn", "-c:a", preset.acodec);
  } else {
    args.push("-c:v", preset.vcodec, "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p");
    args.push("-c:a", preset.acodec, "-b:a", "160k");
    if (preset.extra) args.push(...preset.extra);
  }
  args.push(output);
  return args;
}

function buildCompressArgs(input, output, start, end, quality) {
  const crf = compressCrf(quality);
  const args = ["-y", "-hide_banner"];
  if (start != null) args.push("-ss", String(start));
  args.push("-i", input);
  if (end != null) {
    if (start != null) args.push("-t", String(Math.max(0.1, end - start)));
    else args.push("-to", String(end));
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    crf >= 32 ? "96k" : "128k",
    "-movflags",
    "+faststart",
    output,
  );
  return args;
}

function buildMixArgs(videoPath, audioPath, output, start, end, preset, mixMode) {
  const args = ["-y", "-hide_banner"];
  if (start != null) args.push("-ss", String(start));
  args.push("-i", videoPath, "-i", audioPath);
  if (end != null) {
    if (start != null) args.push("-t", String(Math.max(0.1, end - start)));
    else args.push("-to", String(end));
  }
  const vcodec = preset.vcodec || "libx264";
  const acodec = preset.acodec || "aac";
  if (mixMode === "mix") {
    // 混合：原视频有音轨则 amix；无音轨时退化为替换
    args.push(
      "-filter_complex",
      "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]",
      "-map",
      "0:v:0",
      "-map",
      "[aout]",
      "-c:v",
      vcodec,
      "-preset",
      "fast",
      "-crf",
      "23",
      "-c:a",
      acodec,
      "-b:a",
      "160k",
      "-shortest",
    );
  } else {
    // 替换：使用新音频，丢弃原音轨（视频重编码以保证与裁剪兼容）
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      vcodec,
      "-preset",
      "fast",
      "-crf",
      "23",
      "-c:a",
      acodec,
      "-b:a",
      "160k",
      "-shortest",
    );
  }
  if (preset.extra) args.push(...preset.extra);
  args.push(output);
  return args;
}

function registerVideoEditIpc(ipcMain, getWindow) {
  ipcMain.handle("video:pick", async (_e, kind) => {
    const win = getWindow();
    const isAudio = kind === "audio";
    const result = await dialog.showOpenDialog(win, {
      title: isAudio ? "选择音频文件" : "选择视频文件",
      properties: ["openFile"],
      filters: isAudio ? AUDIO_FILTERS : VIDEO_FILTERS,
    });
    if (result.canceled || !result.filePaths[0]) return { ok: true, cancelled: true };
    const filePath = result.filePaths[0];
    const probe = await probeMedia(filePath);
    return { ok: true, cancelled: false, path: filePath, probe };
  });

  ipcMain.handle("video:probe", async (_e, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: "文件不存在" };
    return probeMedia(filePath);
  });

  ipcMain.handle("video:run", async (e, payload) => {
    const data = payload || {};
    const sender = e.sender;
    return runVideoEdit(
      {
        ...data,
        onProgress: (sec) => {
          if (sender && !sender.isDestroyed()) {
            sender.send("video:progress", { phase: "export", time: sec });
          }
        },
      },
      getWindow,
    );
  });

  ipcMain.handle("video:reveal", (_e, filePath) => {
    if (filePath) shell.showItemInFolder(filePath);
    return true;
  });
}

module.exports = {
  registerVideoEditIpc,
  runVideoEdit,
  FORMAT_PRESETS,
};
