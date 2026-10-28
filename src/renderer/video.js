const api = window.videoEditor;

const state = {
  videoPath: "",
  audioPath: "",
  mediaUrl: "",
  duration: 0,
  current: 0,
  inPoint: 0,
  outPoint: 0,
  frames: [],
  clips: [],
  selectedClipId: null,
  clipSeq: 1,
  lastOut: "",
  dragging: null, // playhead | in | out | select
  scrubbing: false,
  pointerDownX: 0,
  pointerDownT: 0,
  seekTimer: null,
  pendingSeek: null,
  lastSeekAt: 0,
};

const ui = {
  player: document.getElementById("player"),
  previewScrub: document.getElementById("preview-scrub"),
  empty: document.getElementById("preview-empty"),
  play: document.getElementById("btn-play"),
  timecode: document.getElementById("timecode"),
  inoutLabel: document.getElementById("inout-label"),
  clipsLabel: document.getElementById("clips-label"),
  audioLabel: document.getElementById("audio-label"),
  filmstrip: document.getElementById("filmstrip"),
  frames: document.getElementById("filmstrip-frames"),
  clipsLayer: document.getElementById("clips-layer"),
  gapShades: document.getElementById("gap-shades"),
  playhead: document.getElementById("playhead"),
  handleIn: document.getElementById("handle-in"),
  handleOut: document.getElementById("handle-out"),
  shadeL: document.getElementById("range-shade-left"),
  shadeR: document.getElementById("range-shade-right"),
  scrubPreview: document.getElementById("scrub-preview"),
  scrubImg: document.getElementById("scrub-preview-img"),
  scrubTime: document.getElementById("scrub-preview-time"),
  status: document.getElementById("status-text"),
  progressBar: document.getElementById("progress-bar"),
  progressFill: document.getElementById("progress-fill"),
  action: document.getElementById("action"),
  format: document.getElementById("format"),
  formatWrap: document.getElementById("format-wrap"),
  qualityWrap: document.getElementById("quality-wrap"),
  mixWrap: document.getElementById("mix-wrap"),
  copyWrap: document.getElementById("copy-wrap"),
  exportBtn: document.getElementById("btn-export"),
  revealBtn: document.getElementById("btn-reveal"),
  splitBtn: document.getElementById("btn-split"),
  deleteClipBtn: document.getElementById("btn-delete-clip"),
};

const SEEK_MIN_INTERVAL_MS = 40;

function pad2(n) {
  return String(Math.floor(n)).padStart(2, "0");
}

function formatTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return pad2(m) + ":" + pad2(s) + "." + String(Math.floor((s % 1) * 10));
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function syncActionUi() {
  const action = ui.action.value;
  ui.qualityWrap.classList.toggle("hidden", action !== "compress");
  ui.mixWrap.classList.toggle("hidden", action !== "mix");
  ui.copyWrap.classList.toggle("hidden", action !== "trim");
  ui.formatWrap.classList.toggle("hidden", action === "compress");
}

function setStatus(text) {
  ui.status.textContent = text || "";
}

function keptClips() {
  return state.clips
    .slice()
    .sort((a, b) => a.start - b.start)
    .filter((c) => c.end - c.start > 0.05);
}

function hasSplitEdits() {
  const clips = keptClips();
  if (clips.length !== 1) return true;
  if (!state.duration) return false;
  return clips[0].start > 0.05 || clips[0].end < state.duration - 0.05;
}

function resetClips() {
  state.clips = [];
  state.clipSeq = 1;
  if (state.duration > 0) {
    const id = state.clipSeq++;
    state.clips.push({ id, start: 0, end: state.duration });
    state.selectedClipId = id;
  } else {
    state.selectedClipId = null;
  }
}

function getSelectedClip() {
  return state.clips.find((c) => c.id === state.selectedClipId) || null;
}

function clipAtTime(t) {
  return (
    keptClips().find((c) => t >= c.start - 0.001 && t <= c.end + 0.001) || null
  );
}

function selectClip(id, refresh) {
  state.selectedClipId = id;
  updateTransport();
  if (refresh !== false) renderClipsLayer();
}

function nearestFrame(time) {
  if (!state.frames.length) return null;
  let best = state.frames[0];
  let bestD = Math.abs((best.time || 0) - time);
  for (let i = 1; i < state.frames.length; i++) {
    const f = state.frames[i];
    const d = Math.abs((f.time || 0) - time);
    if (d < bestD) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

function applyFrameToPreview(time) {
  const frame = nearestFrame(time);
  if (!frame || !frame.url) return null;
  if (ui.scrubImg.getAttribute("src") !== frame.url) ui.scrubImg.src = frame.url;
  if (ui.previewScrub.getAttribute("src") !== frame.url) ui.previewScrub.src = frame.url;
  return frame;
}

function showScrubPreview(time) {
  applyFrameToPreview(time);
  ui.scrubTime.textContent = formatTime(time);
  ui.previewScrub.classList.remove("hidden");
  const dur = state.duration || 1;
  const x = ratioToX(time / dur);
  const half = 80;
  const maxX = Math.max(half, (ui.filmstrip.clientWidth || half * 2) - half);
  const left = clamp(x, half, maxX);
  ui.scrubPreview.style.left = left + "px";
  ui.scrubPreview.classList.remove("hidden");
}

function hideScrubPreview() {
  ui.scrubPreview.classList.add("hidden");
  ui.previewScrub.classList.add("hidden");
  state.scrubbing = false;
}

function applyPlayerTime(t) {
  try {
    ui.player.currentTime = t;
  } catch {
    /* ignore */
  }
}

function flushVideoSeek(force) {
  if (state.pendingSeek == null) return;
  const now = performance.now();
  if (!force && now - state.lastSeekAt < SEEK_MIN_INTERVAL_MS) {
    if (!state.seekTimer) {
      state.seekTimer = setTimeout(() => {
        state.seekTimer = null;
        flushVideoSeek(true);
      }, SEEK_MIN_INTERVAL_MS - (now - state.lastSeekAt));
    }
    return;
  }
  if (state.seekTimer) {
    clearTimeout(state.seekTimer);
    state.seekTimer = null;
  }
  const t = state.pendingSeek;
  state.pendingSeek = null;
  state.lastSeekAt = now;
  applyPlayerTime(t);
}

function queueVideoSeek(time, immediate) {
  state.pendingSeek = time;
  flushVideoSeek(Boolean(immediate));
}

/** 立刻把播放器定位到指定时间（取消节流队列） */
function commitSeek(time) {
  const t = clamp(time, 0, state.duration || 0);
  state.current = t;
  state.pendingSeek = null;
  if (state.seekTimer) {
    clearTimeout(state.seekTimer);
    state.seekTimer = null;
  }
  applyPlayerTime(t);
  updatePlayheadUi();
  updateTransport();
  return t;
}

function updateTransport() {
  ui.timecode.textContent = formatTime(state.current) + " / " + formatTime(state.duration);
  ui.inoutLabel.textContent =
    "入 " + formatTime(state.inPoint) + " · 出 " + formatTime(state.outPoint);
  const clips = keptClips();
  const n = clips.length;
  const sel = getSelectedClip();
  const selIdx = sel ? clips.findIndex((c) => c.id === sel.id) + 1 : 0;
  ui.clipsLabel.textContent = sel
    ? "已选片段 " + selIdx + "/" + n + "  (" + formatTime(sel.start) + "-" + formatTime(sel.end) + ")"
    : "片段 " + n + " · 点击时间轴选择";
  ui.play.textContent = ui.player.paused ? "播放" : "暂停";
  const canEdit = Boolean(state.videoPath && state.duration);
  ui.splitBtn.disabled = !canEdit;
  // 有选中片段且至少还有片段时允许删除（删到只剩一段也可删，会恢复整段）
  ui.deleteClipBtn.disabled = !canEdit || !sel;
}

function ratioToX(ratio) {
  const w = ui.filmstrip.clientWidth || 1;
  return clamp(ratio, 0, 1) * w;
}

function xToTime(clientX) {
  const rect = ui.filmstrip.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
  return ratio * state.duration;
}

function renderClipsLayer() {
  ui.clipsLayer.replaceChildren();
  ui.gapShades.replaceChildren();
  const dur = state.duration || 1;
  const clips = keptClips();
  let cursor = 0;
  clips.forEach((c, i) => {
    if (c.start > cursor + 0.02) {
      const gap = document.createElement("div");
      gap.className = "gap-shade";
      gap.style.left = ratioToX(cursor / dur) + "px";
      gap.style.width = Math.max(0, ratioToX(c.start / dur) - ratioToX(cursor / dur)) + "px";
      ui.gapShades.appendChild(gap);
    }
    const el = document.createElement("div");
    el.className = "clip-seg" + (c.id === state.selectedClipId ? " selected" : "");
    el.dataset.id = String(c.id);
    el.title = "片段 " + (i + 1) + " · 点击选中后可删除";
    el.style.left = ratioToX(c.start / dur) + "px";
    el.style.width = Math.max(6, ratioToX(c.end / dur) - ratioToX(c.start / dur)) + "px";
    const label = document.createElement("span");
    label.className = "clip-label";
    label.textContent = String(i + 1);
    el.appendChild(label);
    ui.clipsLayer.appendChild(el);
    cursor = c.end;
  });
  if (cursor < dur - 0.02) {
    const gap = document.createElement("div");
    gap.className = "gap-shade";
    gap.style.left = ratioToX(cursor / dur) + "px";
    gap.style.width = Math.max(0, ratioToX(1) - ratioToX(cursor / dur)) + "px";
    ui.gapShades.appendChild(gap);
  }
}

function updatePlayheadUi() {
  const dur = state.duration || 1;
  ui.playhead.style.left = ratioToX(state.current / dur) + "px";
}

function updateHandlesUi() {
  const dur = state.duration || 1;
  const inR = state.inPoint / dur;
  const outR = state.outPoint / dur;
  ui.handleIn.style.left = Math.max(0, ratioToX(inR) - 2) + "px";
  ui.handleOut.style.left = Math.max(0, ratioToX(outR) - 6) + "px";
  ui.shadeL.style.left = "0";
  ui.shadeL.style.width = ratioToX(inR) + "px";
  ui.shadeR.style.left = ratioToX(outR) + "px";
  ui.shadeR.style.right = "0";
  ui.shadeR.style.width = Math.max(0, ui.filmstrip.clientWidth - ratioToX(outR)) + "px";
}

function updateTimelineUi() {
  updatePlayheadUi();
  updateHandlesUi();
  renderClipsLayer();
}

function renderFilmstrip() {
  ui.frames.replaceChildren();
  state.frames.forEach((f) => {
    const img = document.createElement("img");
    img.src = f.url;
    img.alt = "";
    img.draggable = false;
    ui.frames.appendChild(img);
  });
  updateTimelineUi();
}

function setEditButtons(enabled) {
  ui.play.disabled = !enabled;
  document.getElementById("btn-mark-in").disabled = !enabled;
  document.getElementById("btn-mark-out").disabled = !enabled;
  ui.splitBtn.disabled = !enabled;
  ui.deleteClipBtn.disabled = !enabled || !getSelectedClip();
  ui.exportBtn.disabled = !enabled;
}

async function loadVideo(filePath, probe) {
  state.videoPath = filePath;
  state.current = 0;
  state.duration = Number(probe && probe.duration) || 0;
  state.inPoint = 0;
  state.outPoint = state.duration;
  state.frames = [];
  state.lastOut = "";
  resetClips();
  ui.revealBtn.disabled = true;
  setEditButtons(false);
  ui.empty.classList.add("hidden");
  hideScrubPreview();
  setStatus("加载预览…");

  const urlRes = await api.toMediaUrl(filePath);
  if (!urlRes || !urlRes.ok) {
    setStatus(urlRes && urlRes.error ? urlRes.error : "无法加载视频");
    return;
  }
  state.mediaUrl = urlRes.url;
  ui.player.src = state.mediaUrl;
  ui.player.load();

  await new Promise((resolve) => {
    const onMeta = () => {
      ui.player.removeEventListener("loadedmetadata", onMeta);
      if (!state.duration && Number.isFinite(ui.player.duration)) {
        state.duration = ui.player.duration;
        state.outPoint = state.duration;
        resetClips();
      }
      resolve();
    };
    ui.player.addEventListener("loadedmetadata", onMeta);
    setTimeout(resolve, 2000);
  });

  setEditButtons(true);
  updateTransport();
  updateTimelineUi();
  setStatus("生成胶片预览…");

  const fsRes = await api.filmstrip({ path: filePath, count: 48 });
  if (fsRes && fsRes.ok) {
    state.frames = fsRes.frames || [];
    if (fsRes.duration) {
      state.duration = fsRes.duration;
      if (state.outPoint <= 0 || state.outPoint > state.duration) state.outPoint = state.duration;
      if (!state.clips.length) resetClips();
      else {
        state.clips.forEach((c) => {
          c.end = Math.min(c.end, state.duration);
        });
      }
    }
    renderFilmstrip();
    setStatus("就绪 · " + (state.frames.length || 0) + " 帧预览");
  } else {
    setStatus((fsRes && fsRes.error) || "胶片预览失败，仍可播放与导出");
  }
  updateTransport();
  updateTimelineUi();
}

async function openVideo() {
  const res = await api.pick("video");
  if (!res || res.cancelled || !res.ok) return;
  await loadVideo(res.path, res.probe);
}

async function openAudio() {
  const res = await api.pick("audio");
  if (!res || res.cancelled || !res.ok) return;
  state.audioPath = res.path;
  ui.audioLabel.textContent = "音频：" + res.path.split(/[/\\]/).pop();
  setStatus("已选择音频轨");
}

function seekTo(time, showPreview, immediateSeek) {
  if (!state.duration) return;
  state.current = clamp(time, 0, state.duration);
  if (showPreview) {
    state.scrubbing = true;
    showScrubPreview(state.current);
    queueVideoSeek(state.current, immediateSeek);
  } else {
    queueVideoSeek(state.current, true);
  }
  updateTransport();
  updatePlayheadUi();
}

async function togglePlay() {
  if (!state.videoPath) return;
  if (!ui.player.paused) {
    ui.player.pause();
    updateTransport();
    return;
  }

  // 从当前时间轴位置开始播：先落地 seek，再去掉胶片遮罩
  let startAt = state.current;
  const nearEnd =
    startAt >= state.outPoint - 0.05 ||
    (state.duration > 0 && startAt >= state.duration - 0.05);
  if (nearEnd) startAt = state.inPoint;

  hideScrubPreview();
  commitSeek(startAt);

  try {
    await ui.player.play();
  } catch (err) {
    // 偶发 seek 未就绪，再试一次
    commitSeek(startAt);
    try {
      await ui.player.play();
    } catch (err2) {
      setStatus("播放失败：" + String(err2.message || err2));
    }
  }
  updateTransport();
}

function splitAtPlayhead() {
  if (!state.duration) return;
  const t = state.current;
  const idx = state.clips.findIndex((c) => t > c.start + 0.05 && t < c.end - 0.05);
  if (idx < 0) {
    setStatus("请将播放头移到片段中间再分割");
    return;
  }
  const clip = state.clips[idx];
  const left = { id: state.clipSeq++, start: clip.start, end: t };
  const right = { id: state.clipSeq++, start: t, end: clip.end };
  state.clips.splice(idx, 1, left, right);
  state.selectedClipId = right.id;
  setStatus("已分割为 " + keptClips().length + " 个片段，点击片段可选中后删除");
  updateTransport();
  updateTimelineUi();
}

function deleteSelectedClip() {
  const sel = getSelectedClip();
  if (!sel) {
    setStatus("请先在时间轴上点击选中一个片段");
    return;
  }
  const before = keptClips().length;
  const i = state.clips.findIndex((c) => c.id === sel.id);
  if (i < 0) return;
  state.clips.splice(i, 1);
  const remain = keptClips();
  if (!remain.length) {
    resetClips();
    setStatus("已删光片段，已恢复为整段视频");
  } else {
    state.selectedClipId = remain[Math.min(i, remain.length - 1)].id;
    setStatus("已删除第 " + (i + 1) + " 段，剩余 " + remain.length + " 段（原 " + before + "）");
  }
  updateTransport();
  updateTimelineUi();
}

async function doExport() {
  if (!state.videoPath) return;
  const action = ui.action.value;
  if (action === "mix" && !state.audioPath) {
    setStatus("请先打开音频文件");
    return;
  }

  const clips = keptClips()
    .filter((c) => c.end > state.inPoint + 0.02 && c.start < state.outPoint - 0.02)
    .map((c) => ({
      start: Math.max(c.start, state.inPoint),
      end: Math.min(c.end, state.outPoint),
    }))
    .filter((c) => c.end - c.start > 0.05);

  if (!clips.length) {
    setStatus("没有可导出的片段");
    return;
  }

  const useConcat = action === "trim" && (hasSplitEdits() || clips.length > 1);

  ui.exportBtn.disabled = true;
  ui.progressBar.classList.remove("hidden");
  ui.progressFill.style.width = "0%";
  setStatus("正在导出…");

  const payload = useConcat
    ? {
        action: "concat-clips",
        inputPath: state.videoPath,
        clips,
        format: "mp4",
        copyStreams: document.getElementById("copy-streams").checked,
        duration: clips.reduce((s, c) => s + (c.end - c.start), 0),
      }
    : {
        action,
        inputPath: state.videoPath,
        audioPath: action === "mix" ? state.audioPath : undefined,
        start:
          action === "trim" || action === "mix" || action === "convert" || action === "compress"
            ? clips.length === 1
              ? clips[0].start
              : state.inPoint
            : undefined,
        end:
          action === "trim" || action === "mix" || action === "convert" || action === "compress"
            ? clips.length === 1
              ? clips[0].end
              : state.outPoint
            : undefined,
        format: ui.format.value,
        quality: document.getElementById("quality").value,
        mixMode: document.getElementById("mix-mode").value,
        copyStreams: document.getElementById("copy-streams").checked,
        duration:
          (clips.length === 1 ? clips[0].end - clips[0].start : state.outPoint - state.inPoint) ||
          state.duration,
      };

  try {
    const res = await api.run(payload);
    if (!res || res.cancelled) {
      setStatus("已取消导出");
      return;
    }
    if (!res.ok) {
      setStatus(res.error || "导出失败");
      return;
    }
    state.lastOut = res.path || "";
    ui.revealBtn.disabled = !state.lastOut;
    setStatus("导出完成：" + state.lastOut);
    ui.progressFill.style.width = "100%";
  } catch (err) {
    setStatus(String(err.message || err));
  } finally {
    ui.exportBtn.disabled = !state.videoPath;
    setTimeout(() => ui.progressBar.classList.add("hidden"), 800);
  }
}

function isPlayheadTarget(target) {
  return (
    target === ui.playhead ||
    (target && target.id === "playhead-grip") ||
    (target && target.closest && target.closest("#playhead"))
  );
}

function onPointerDownFilmstrip(e) {
  if (!state.duration) return;
  const target = e.target;
  if (target === ui.handleIn || (target.classList && target.classList.contains("in"))) {
    state.dragging = "in";
    hideScrubPreview();
    ui.filmstrip.setPointerCapture(e.pointerId);
    return;
  }
  if (target === ui.handleOut || (target.classList && target.classList.contains("out"))) {
    state.dragging = "out";
    hideScrubPreview();
    ui.filmstrip.setPointerCapture(e.pointerId);
    return;
  }

  // 优先拖拽播放头箭头
  if (isPlayheadTarget(target)) {
    state.dragging = "playhead";
    ui.playhead.classList.add("dragging");
    if (!ui.player.paused) ui.player.pause();
    seekTo(xToTime(e.clientX), true, true);
    ui.filmstrip.setPointerCapture(e.pointerId);
    e.stopPropagation();
    return;
  }

  const t = xToTime(e.clientX);
  const hit = clipAtTime(t);
  if (hit) selectClip(hit.id);

  state.pointerDownX = e.clientX;
  state.pointerDownT = t;
  state.dragging = "playhead";
  ui.playhead.classList.add("dragging");
  if (!ui.player.paused) ui.player.pause();
  seekTo(t, true, true);
  ui.filmstrip.setPointerCapture(e.pointerId);
}

function onPointerMoveFilmstrip(e) {
  if (!state.dragging || !state.duration) return;
  const t = xToTime(e.clientX);
  if (state.dragging === "playhead") {
    // 拖动时主预览用胶片帧即时更新，视频 seek 节流跟上
    seekTo(t, true, false);
    const hit = clipAtTime(t);
    if (hit && hit.id !== state.selectedClipId) selectClip(hit.id);
  } else if (state.dragging === "in") {
    state.inPoint = clamp(t, 0, Math.max(0, state.outPoint - 0.05));
    const sel = getSelectedClip();
    if (sel && keptClips().length === 1) sel.start = state.inPoint;
    seekTo(state.inPoint, true, false);
    updateTransport();
    updateHandlesUi();
  } else if (state.dragging === "out") {
    state.outPoint = clamp(t, Math.min(state.duration, state.inPoint + 0.05), state.duration);
    const sel = getSelectedClip();
    if (sel && keptClips().length === 1) sel.end = state.outPoint;
    seekTo(state.outPoint, true, false);
    updateTransport();
    updateHandlesUi();
  }
}

function onPointerUpFilmstrip(e) {
  if (!state.dragging) return;
  const mode = state.dragging;
  state.dragging = null;
  ui.playhead.classList.remove("dragging");
  try {
    ui.filmstrip.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  if (mode === "playhead" || mode === "in" || mode === "out") {
    const t =
      mode === "in" ? state.inPoint : mode === "out" ? state.outPoint : xToTime(e.clientX);
    if (mode === "playhead") {
      const hit = clipAtTime(t);
      if (hit) selectClip(hit.id);
    }
    // 松手：定格到拖拽位置，去掉遮罩，便于接着点「播放」从这里开始
    commitSeek(t);
    hideScrubPreview();
    // 时间轴小预览短暂保留一下位置感
    applyFrameToPreview(t);
    ui.scrubTime.textContent = formatTime(t);
    const dur = state.duration || 1;
    const x = ratioToX(t / dur);
    const half = 80;
    const maxX = Math.max(half, (ui.filmstrip.clientWidth || half * 2) - half);
    ui.scrubPreview.style.left = clamp(x, half, maxX) + "px";
    ui.scrubPreview.classList.remove("hidden");
    setTimeout(() => {
      if (!state.dragging && ui.player.paused) ui.scrubPreview.classList.add("hidden");
    }, 500);
  }
}

function bind() {
  syncActionUi();
  ui.action.onchange = syncActionUi;
  document.getElementById("btn-open-video").onclick = openVideo;
  document.getElementById("btn-open-audio").onclick = openAudio;
  ui.exportBtn.onclick = doExport;
  ui.revealBtn.onclick = () => {
    if (state.lastOut) api.reveal(state.lastOut);
  };
  ui.play.onclick = togglePlay;
  ui.splitBtn.onclick = splitAtPlayhead;
  ui.deleteClipBtn.onclick = deleteSelectedClip;
  document.getElementById("btn-mark-in").onclick = () => {
    state.inPoint = clamp(state.current, 0, Math.max(0, state.outPoint - 0.05));
    const sel = getSelectedClip();
    if (sel) sel.start = Math.min(state.inPoint, sel.end - 0.05);
    updateTransport();
    updateTimelineUi();
  };
  document.getElementById("btn-mark-out").onclick = () => {
    state.outPoint = clamp(
      state.current,
      Math.min(state.duration, state.inPoint + 0.05),
      state.duration,
    );
    const sel = getSelectedClip();
    if (sel) sel.end = Math.max(state.outPoint, sel.start + 0.05);
    updateTransport();
    updateTimelineUi();
  };

  ui.player.addEventListener("timeupdate", () => {
    if (state.dragging === "playhead" || state.dragging === "in" || state.dragging === "out") {
      return;
    }
    state.current = ui.player.currentTime || 0;
    if (!ui.player.paused && state.current >= state.outPoint - 0.02) {
      ui.player.pause();
      commitSeek(state.outPoint);
      hideScrubPreview();
    }
    updateTransport();
    updatePlayheadUi();
  });
  ui.player.addEventListener("seeked", () => {
    if (state.dragging === "playhead" || state.dragging === "in" || state.dragging === "out") {
      showScrubPreview(state.current);
    }
  });
  ui.player.addEventListener("play", () => {
    hideScrubPreview();
    updateTransport();
  });
  ui.player.addEventListener("pause", updateTransport);

  ui.filmstrip.addEventListener("pointerdown", onPointerDownFilmstrip);
  ui.filmstrip.addEventListener("pointermove", onPointerMoveFilmstrip);
  ui.filmstrip.addEventListener("pointerup", onPointerUpFilmstrip);
  ui.filmstrip.addEventListener("pointercancel", onPointerUpFilmstrip);
  window.addEventListener("resize", updateTimelineUi);

  api.onProgress((p) => {
    if (!p) return;
    if (p.phase === "filmstrip") setStatus(p.message || "生成胶片…");
    if (p.phase === "export") {
      ui.progressBar.classList.remove("hidden");
      if (p.percent != null) ui.progressFill.style.width = p.percent + "%";
      setStatus(
        "导出中…" +
          (p.percent != null ? " " + p.percent + "%" : "") +
          (p.time != null ? "  " + formatTime(p.time) : ""),
      );
    }
    if (p.phase === "done") ui.progressFill.style.width = "100%";
    if (p.phase === "error") setStatus(p.error || "出错");
  });
}

bind();
