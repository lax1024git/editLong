const api = window.editlong;

const FONT_MIN = 10;
const FONT_MAX = 40;
const FONT_DEFAULT = 14;

function loadFontSize() {
  const n = parseInt(localStorage.getItem("editlong.fontSize") || "", 10);
  if (Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX) return n;
  return FONT_DEFAULT;
}

const state = {
  meta: null,
  tabId: null,
  mode: "text",
  firstLine: 0,
  firstRow: 0,
  fontSize: loadFontSize(),
  rowHeight: 20,
  visible: 40,
  match: null,
  dirty: false,
  dragging: false,
  language: "plaintext",
  wrap: false,
  viewReady: false,
};

const tabViews = new Map();
let tabList = [];

const ui = {
  welcome: document.getElementById("welcome"),
  textEdit: document.getElementById("text-edit"),
  textView: document.getElementById("text-view"),
  hexView: document.getElementById("hex-view"),
  editor: document.getElementById("editor"),
  textGutter: document.getElementById("text-gutter"),
  textBody: document.getElementById("text-body"),
  hexBody: document.getElementById("hex-body"),
  vscroll: document.getElementById("vscroll"),
  vthumb: document.getElementById("vthumb"),
  encoding: document.getElementById("encoding"),
  findBar: document.getElementById("find-bar"),
  findInput: document.getElementById("find-input"),
  findHex: document.getElementById("find-hex"),
  findCase: document.getElementById("find-case"),
  gotoBar: document.getElementById("goto-bar"),
  gotoInput: document.getElementById("goto-input"),
  btnText: document.getElementById("btn-text"),
  btnHex: document.getElementById("btn-hex"),
  stFile: document.getElementById("st-file"),
  stPos: document.getElementById("st-pos"),
  stOff: document.getElementById("st-off"),
  stSize: document.getElementById("st-size"),
  stMode: document.getElementById("st-mode"),
  stLang: document.getElementById("st-lang"),
  stZoom: document.getElementById("st-zoom"),
  tabbar: document.getElementById("tabbar"),
  tabstrip: document.getElementById("tabstrip"),
};

const LANG_LABELS = {
  plaintext: "纯文本",
  c: "C",
  cpp: "C++",
  html: "HTML",
  javascript: "JavaScript",
  json: "JSON",
  markdown: "Markdown",
  python: "Python",
  xml: "XML",
  batch: "Batch",
  ini: "INI",
  sql: "SQL",
  php: "PHP",
};

function hasDoc() {
  return Boolean(state.meta && (state.meta.path || state.meta.untitled));
}

function formatSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function hexByte(n) {
  return n.toString(16).toUpperCase().padStart(2, "0");
}

function printable(n) {
  return n >= 32 && n < 127 ? String.fromCharCode(n) : ".";
}

function totalUnits() {
  if (!state.meta) return 1;
  if (state.mode === "hex") {
    return Math.max(1, Math.ceil(state.meta.size / 16));
  }
  return Math.max(1, state.meta.totalLines || 1);
}

function currentIndex() {
  return state.mode === "hex" ? state.firstRow : state.firstLine;
}

function setIndex(next) {
  const max = Math.max(0, totalUnits() - state.visible);
  next = Math.max(0, Math.min(max, next | 0));
  if (state.mode === "hex") state.firstRow = next;
  else state.firstLine = next;
}

function measureVisible() {
  const stage = document.getElementById("stage");
  state.visible = Math.max(8, Math.floor((stage.clientHeight - 16) / state.rowHeight));
}

function applyFontSize() {
  const fs = state.fontSize;
  const lh = Math.max(14, Math.round(fs * 1.45));
  state.rowHeight = lh;
  document.documentElement.style.setProperty("--editor-font-size", fs + "px");
  document.documentElement.style.setProperty("--editor-line-height", lh + "px");
  if (ui.stZoom) {
    const pct = Math.round((fs / FONT_DEFAULT) * 100);
    ui.stZoom.textContent = pct + "%";
  }
  try {
    localStorage.setItem("editlong.fontSize", String(fs));
  } catch {
    /* ignore */
  }
}

function setFontSize(next) {
  const n = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(next)));
  if (n === state.fontSize) return;
  state.fontSize = n;
  applyFontSize();
  if (hasDoc()) render();
}

function applyMeta(meta) {
  state.meta = meta;
  if (meta.language) state.language = meta.language;
  if (typeof meta.wrap === "boolean") applyWrap(meta.wrap);
  if (!ui.encoding.options.length && meta.encodings) {
    meta.encodings.forEach((enc) => {
      const opt = document.createElement("option");
      opt.value = enc.id;
      opt.textContent = enc.label;
      ui.encoding.appendChild(opt);
    });
  }
  if (meta.encoding) ui.encoding.value = meta.encoding;
  const name = meta.title
    ? meta.title
    : meta.untitled
      ? "未命名"
      : meta.path
        ? meta.path.split(/[\\/]/).pop()
        : "未打开文件";
  document.title = hasDoc() ? (state.dirty ? "*" : "") + name + " - EditLong" : "EditLong";
  ui.stFile.textContent = meta.path
    ? name + (meta.indexDone ? "" : "（正在建立行索引…）")
    : meta.untitled
      ? name
      : "未打开文件";
  ui.stSize.textContent = meta.path ? formatSize(meta.size) : "";
  ui.stLang.textContent = LANG_LABELS[state.language] || "纯文本";
  ui.stMode.textContent = state.mode === "hex" ? "二进制" : meta.editable ? "文本编辑" : "文本浏览";
}

function applyWrap(on) {
  state.wrap = Boolean(on);
  ui.editor.wrap = state.wrap ? "soft" : "off";
}

function showPanes() {
  const opened = hasDoc();
  ui.welcome.classList.toggle("hidden", opened);
  const canEdit = opened && state.mode === "text" && state.meta.editable;
  ui.vscroll.classList.toggle("hidden", !opened || canEdit);
  const vtext = opened && state.mode === "text" && !state.meta.editable;
  const hex = opened && state.mode === "hex";
  ui.textEdit.classList.toggle("hidden", !canEdit);
  ui.textView.classList.toggle("hidden", !vtext);
  ui.hexView.classList.toggle("hidden", !hex);
  ui.btnText.classList.toggle("active", state.mode === "text");
  ui.btnHex.classList.toggle("active", state.mode === "hex");
}

async function openFile() {
  await api.openDialog();
}

function saveCurrentView() {
  if (!state.tabId) return;
  tabViews.set(state.tabId, {
    editorValue: ui.editor.value,
    dirty: state.dirty,
    firstLine: state.firstLine,
    firstRow: state.firstRow,
    mode: state.mode,
    language: state.language,
    wrap: state.wrap,
    match: state.match,
    selStart: ui.editor.selectionStart || 0,
    selEnd: ui.editor.selectionEnd || 0,
  });
}

function tabIsDirty(id) {
  if (id === state.tabId) return state.dirty;
  return Boolean(tabViews.get(id)?.dirty);
}

function paintTabs() {
  if (!ui.tabbar || !ui.tabstrip) return;
  ui.tabbar.classList.toggle("hidden", tabList.length === 0);
  ui.tabstrip.replaceChildren();
  tabList.forEach((tab) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tab" + (tab.id === state.tabId || tab.active ? " active" : "");
    el.title = tab.path || tab.title;
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = (tabIsDirty(tab.id) ? "* " : "") + tab.title;
    const close = document.createElement("span");
    close.className = "tab-close";
    close.title = "关闭";
    close.textContent = "×";
    el.append(title, close);
    el.addEventListener("click", (e) => {
      if (e.target === close) return;
      switchTab(tab.id);
    });
    close.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      requestClose(tab.id);
    });
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        requestClose(tab.id);
      }
    });
    ui.tabstrip.appendChild(el);
  });
  const activeEl = ui.tabstrip.querySelector(".tab.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
}

async function switchTab(id) {
  if (!id || id === state.tabId) return;
  saveCurrentView();
  await api.activateTab(id);
}

async function requestClose(id) {
  if (!id) return;
  if (tabIsDirty(id) && !window.confirm("此标签有未保存的修改，确定关闭？")) return;
  if (id === state.tabId) saveCurrentView();
  tabViews.delete(id);
  await api.closeFile(id);
}

async function requestCloseAll() {
  const dirty = tabList.some((t) => tabIsDirty(t.id));
  if (dirty && !window.confirm("有未保存的修改，确定关闭全部标签？")) return;
  saveCurrentView();
  tabViews.clear();
  await api.closeAllTabs();
}

function cycleTab(reverse) {
  if (tabList.length < 2) return;
  const ids = tabList.map((t) => t.id);
  const i = Math.max(0, ids.indexOf(state.tabId));
  const next = reverse ? ids[(i - 1 + ids.length) % ids.length] : ids[(i + 1) % ids.length];
  switchTab(next);
}

async function onOpened(meta) {
  if (state.tabId && meta.tabId && state.tabId !== meta.tabId && state.viewReady) {
    saveCurrentView();
  }
  const cached = meta.tabId ? tabViews.get(meta.tabId) : null;
  state.tabId = meta.tabId || null;
  state.viewReady = false;
  if (!meta.path && !meta.untitled) {
    state.meta = meta;
    state.dirty = false;
    state.match = null;
    ui.editor.value = "";
    showPanes();
    paintTabs();
    document.title = "EditLong";
    state.viewReady = true;
    return;
  }
  if (cached) {
    state.dirty = cached.dirty;
    state.firstLine = cached.firstLine;
    state.firstRow = cached.firstRow;
    state.mode = cached.mode;
    state.language = cached.language;
    state.match = cached.match;
    applyWrap(cached.wrap);
    applyMeta(meta);
    showPanes();
    if (meta.untitled || (meta.editable && state.mode === "text")) {
      ui.editor.value = cached.editorValue || "";
      const a = cached.selStart || 0;
      const b = cached.selEnd || 0;
      ui.editor.setSelectionRange(a, b);
    }
    await render();
    paintTabs();
    state.viewReady = true;
    return;
  }
  state.dirty = false;
  state.firstLine = 0;
  state.firstRow = 0;
  state.match = null;
  if (meta.mode) state.mode = meta.mode;
  applyMeta(meta);
  showPanes();
  if (meta.untitled) {
    ui.editor.value = "";
    ui.editor.focus();
    updateEditStatus();
    saveCurrentView();
    paintTabs();
    state.viewReady = true;
    return;
  }
  if (!meta.path) return;
  if (meta.editable && state.mode === "text") {
    const text = await api.readText();
    if (state.tabId !== meta.tabId) return;
    ui.editor.value = text;
    ui.editor.focus();
  }
  if (state.tabId !== meta.tabId) return;
  await render();
  saveCurrentView();
  paintTabs();
  state.viewReady = true;
}

async function render() {
  if (!hasDoc()) return;
  if (state.meta.untitled) {
    showPanes();
    updateEditStatus();
    return;
  }
  measureVisible();
  showPanes();
  if (state.mode === "hex") {
    await renderHex();
  } else if (!state.meta.editable) {
    await renderText();
  } else {
    updateEditStatus();
  }
  updateThumb();
}

async function renderText() {
  const data = await api.readLines(state.firstLine, state.visible);
  const matchLine = state.match ? state.match.line : -1;
  ui.textGutter.replaceChildren();
  ui.textBody.replaceChildren();
  data.lines.forEach((row) => {
    const g = document.createElement("div");
    g.textContent = String(row.line + 1);
    g.style.height = state.rowHeight + "px";
    if (row.line === matchLine) g.className = "hit";
    ui.textGutter.appendChild(g);
    const b = document.createElement("div");
    b.textContent = row.text.replace(/\t/g, "    ");
    b.style.height = state.rowHeight + "px";
    if (row.line === matchLine) b.className = "hit";
    ui.textBody.appendChild(b);
  });
  const first = data.lines[0];
  ui.stPos.textContent = "Ln " + (state.firstLine + 1);
  ui.stOff.textContent = first ? "偏移 " + first.offset + " (0x" + first.offset.toString(16).toUpperCase() + ")" : "";
}

async function renderHex() {
  const offset = state.firstRow * 16;
  const length = state.visible * 16;
  const { bytes } = await api.readBytes(offset, length);
  ui.hexBody.replaceChildren();
  const match = state.match;
  for (let r = 0; r < state.visible; r++) {
    const rowOff = offset + r * 16;
    if (rowOff >= state.meta.size && r > 0) break;
    const slice = bytes.slice(r * 16, r * 16 + 16);
    const row = document.createElement("div");
    row.className = "row";
    if (match && match.offset < rowOff + 16 && match.offset + match.length > rowOff) {
      row.classList.add("hit");
    }
    const off = document.createElement("span");
    off.className = "off";
    off.textContent = rowOff.toString(16).toUpperCase().padStart(8, "0");
    const hex = document.createElement("span");
    hex.className = "hexbytes";
    const left = [];
    for (let i = 0; i < 16; i++) {
      left.push(i < slice.length ? hexByte(slice[i]) : "  ");
      if (i === 7) left.push("");
    }
    hex.textContent = left.join(" ");
    const ascii = document.createElement("span");
    ascii.className = "ascii";
    ascii.textContent = slice.map(printable).join("").padEnd(16, " ");
    row.append(off, hex, ascii);
    ui.hexBody.appendChild(row);
  }
  ui.stPos.textContent = "Row " + (state.firstRow + 1);
  ui.stOff.textContent = "偏移 " + offset + " (0x" + offset.toString(16).toUpperCase() + ")";
}

function updateEditStatus() {
  const text = ui.editor.value;
  const pos = ui.editor.selectionStart || 0;
  const before = text.slice(0, pos);
  const line = before.split(/\n/).length;
  const col = pos - before.lastIndexOf("\n");
  ui.stPos.textContent = "Ln " + line + ", Col " + col;
  ui.stOff.textContent = state.dirty ? "未保存" : "已保存";
  if (state.meta) {
    const name = state.meta.title || (state.meta.untitled ? "未命名" : state.meta.path ? state.meta.path.split(/[\\/]/).pop() : "EditLong");
    document.title = (state.dirty ? "*" : "") + name + " - EditLong";
  }
}

function updateThumb() {
  const total = totalUnits();
  const vis = state.visible;
  const track = ui.vscroll.clientHeight || 1;
  const thumbH = Math.max(24, Math.min(track, (vis / total) * track));
  const maxIdx = Math.max(1, total - vis);
  const top = (currentIndex() / maxIdx) * (track - thumbH);
  ui.vthumb.style.height = thumbH + "px";
  ui.vthumb.style.top = Math.max(0, top) + "px";
}

async function setMode(mode) {
  state.mode = mode;
  if (api.setMode) api.setMode(mode);
  applyMeta(state.meta || { path: null, size: 0, editable: false, encodings: [] });
  showPanes();
  if (mode === "text" && state.meta?.editable && !ui.editor.value && state.meta.path) {
    ui.editor.value = await api.readText();
  }
  await render();
}

function transformSelection(fn) {
  if (!(state.meta?.editable && state.mode === "text")) return;
  const start = ui.editor.selectionStart;
  const end = ui.editor.selectionEnd;
  if (start === end) return;
  const selected = ui.editor.value.slice(start, end);
  ui.editor.setRangeText(fn(selected), start, end, "select");
  state.dirty = true;
  updateEditStatus();
}

function deleteSelection() {
  if (!(state.meta?.editable && state.mode === "text")) return;
  const start = ui.editor.selectionStart;
  const end = ui.editor.selectionEnd;
  const to = start === end ? start + 1 : end;
  ui.editor.setRangeText("", start, to, "start");
  state.dirty = true;
  updateEditStatus();
}

async function save(saveAs) {
  if (!state.meta?.editable) {
    window.alert("大文件为浏览模式，不支持直接保存整份修改。");
    return;
  }
  const result = await api.saveText({ text: ui.editor.value, saveAs });
  if (!result.cancelled) {
    state.dirty = false;
    applyMeta(result.meta);
    saveCurrentView();
    updateEditStatus();
    paintTabs();
  }
}

const hotkeyOverlay = document.getElementById("hotkey-overlay");
const hotkeyInput = document.getElementById("hotkey-input");
const hotkeyMsg = document.getElementById("hotkey-msg");
let pendingAccel = "";

function prettyAccel(acc) {
  return String(acc || "")
    .replace(/CommandOrControl/g, "Ctrl")
    .replace(/Command/g, "Cmd")
    .replace(/Control/g, "Ctrl");
}

function eventToAccelerator(e) {
  const mods = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);
  if (mods.has(e.key)) return "";
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const map = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
    PrintScreen: "PrintScreen",
    "+": "Plus",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Enter: "Enter",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  let key = map[e.key];
  if (!key) {
    if (/^F\d{1,2}$/i.test(e.key)) key = e.key.toUpperCase();
    else if (e.key.length === 1) key = e.key.toUpperCase();
    else if (e.code && e.code.startsWith("Key")) key = e.code.slice(3);
    else key = e.key;
  }
  parts.push(key);
  return parts.join("+");
}

async function showHotkeyBox() {
  const info = await api.getSnipShortcut();
  pendingAccel = info.shortcut;
  hotkeyInput.value = info.label;
  hotkeyMsg.textContent = "";
  hotkeyOverlay.classList.remove("hidden");
  hotkeyInput.focus();
}

function hideHotkeyBox() {
  hotkeyOverlay.classList.add("hidden");
}

async function applyHotkey(accel) {
  const result = await api.setSnipShortcut(accel);
  if (!result.ok) {
    hotkeyMsg.textContent = result.error || "注册失败";
    hotkeyMsg.classList.remove("ok");
    return;
  }
  pendingAccel = result.shortcut;
  hotkeyInput.value = result.label;
  hotkeyMsg.textContent = "已保存：" + result.label;
  hotkeyMsg.classList.add("ok");
  const btn = document.getElementById("btn-snip");
  if (btn) btn.title = "区域截图 (" + result.label + ")";
}

hotkeyInput.addEventListener("keydown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    hideHotkeyBox();
    return;
  }
  if (e.key === "Enter") {
    if (pendingAccel) applyHotkey(pendingAccel);
    return;
  }
  const accel = eventToAccelerator(e);
  if (!accel) return;
  pendingAccel = accel;
  hotkeyInput.value = prettyAccel(accel);
  hotkeyMsg.textContent = "回车或点保存以生效";
  hotkeyMsg.classList.remove("ok");
});

document.getElementById("hotkey-save").onclick = () => {
  if (pendingAccel) applyHotkey(pendingAccel);
};
document.getElementById("hotkey-default").onclick = async () => {
  const info = await api.getSnipShortcut();
  applyHotkey(info.defaultShortcut);
};
document.getElementById("hotkey-close").onclick = hideHotkeyBox;
hotkeyOverlay.addEventListener("mousedown", (e) => {
  if (e.target === hotkeyOverlay) hideHotkeyBox();
});

api.getSnipShortcut().then((info) => {
  const btn = document.getElementById("btn-snip");
  if (btn && info && info.label) btn.title = "区域截图 (" + info.label + ")";
}).catch(() => {});

function showFind(show) {
  ui.findBar.classList.toggle("hidden", !show);
  if (show) {
    ui.gotoBar.classList.add("hidden");
    ui.findInput.focus();
    ui.findInput.select();
  }
}

function showGoto(show) {
  ui.gotoBar.classList.toggle("hidden", !show);
  if (show) {
    ui.findBar.classList.add("hidden");
    ui.gotoInput.focus();
    ui.gotoInput.select();
  }
}

function findInEditor(query, reverse) {
  const text = ui.editor.value;
  const cs = ui.findCase.checked;
  const hay = cs ? text : text.toLowerCase();
  const needle = cs ? query : query.toLowerCase();
  const from = reverse
    ? Math.max(0, (ui.editor.selectionStart || 0) - 1)
    : ui.editor.selectionEnd || 0;
  const idx = reverse ? hay.lastIndexOf(needle, from) : hay.indexOf(needle, from);
  if (idx < 0) return false;
  ui.editor.focus();
  ui.editor.setSelectionRange(idx, idx + query.length);
  const line = text.slice(0, idx).split(/\n/).length;
  ui.stFile.textContent = "找到 第 " + line + " 行";
  updateEditStatus();
  return true;
}

async function runFind(reverse) {
  if (!hasDoc()) return;
  const query = ui.findInput.value;
  if (!query) {
    showFind(true);
    return;
  }
  if (state.mode === "text" && state.meta.editable && !ui.findHex.checked) {
    if (!findInEditor(query, reverse)) ui.stFile.textContent = "未找到：" + query;
    return;
  }

  let fromOffset = 0;
  if (state.match) {
    fromOffset = reverse ? state.match.offset : state.match.offset + state.match.length;
  } else if (state.mode === "hex") {
    fromOffset = state.firstRow * 16;
  } else {
    const data = await api.readLines(state.firstLine, 1);
    fromOffset = data.lines[0]?.offset || 0;
  }

  const result = await api.find({
    query,
    isHex: ui.findHex.checked,
    fromOffset,
    caseSensitive: ui.findCase.checked,
    reverse,
  });
  if (!result.found) {
    ui.stFile.textContent = "未找到：" + query;
    return;
  }
  state.match = result;
  if (state.mode === "hex") setIndex(Math.floor(result.offset / 16));
  else setIndex(result.line);
  applyMeta(state.meta);
  ui.stFile.textContent =
    "找到 @ 0x" + result.offset.toString(16).toUpperCase() + "  第 " + (result.line + 1) + " 行";
  await render();
}

async function runGoto() {
  const raw = ui.gotoInput.value.trim();
  if (!raw || !state.meta?.path) return;
  if (/^0x[0-9a-fA-F]+$/i.test(raw)) {
    const offset = parseInt(raw, 16);
    if (state.mode === "hex") setIndex(Math.floor(offset / 16));
    else {
      const line = await api.offsetToLine(offset);
      setIndex(line);
    }
  } else {
    const line = Math.max(1, parseInt(raw, 10) || 1) - 1;
    setIndex(line);
  }
  showGoto(false);
  await render();
}

function onWheel(e) {
  if (e.ctrlKey) {
    e.preventDefault();
    e.stopPropagation();
    const dir = Math.sign(e.deltaY) || (e.deltaX ? Math.sign(e.deltaX) : 0);
    if (!dir) return;
    const step = e.deltaMode === 1 ? 2 : Math.abs(e.deltaY) >= 40 ? 2 : 1;
    setFontSize(state.fontSize - dir * step);
    return;
  }
  if (!hasDoc() || state.meta?.untitled) return;
  if (state.mode === "text" && state.meta.editable) return;
  e.preventDefault();
  const steps = Math.max(1, Math.round(Math.abs(e.deltaY) / 40));
  setIndex(currentIndex() + Math.sign(e.deltaY) * steps);
  render();
}

function onThumbPointer(e) {
  if (ui.vscroll.classList.contains("hidden")) return;
  e.preventDefault();
  state.dragging = true;
  ui.vthumb.classList.add("active");
  const startY = e.clientY;
  const startIdx = currentIndex();
  const track = ui.vscroll.clientHeight - ui.vthumb.clientHeight;
  const move = (ev) => {
    const ratio = track > 0 ? (ev.clientY - startY) / track : 0;
    setIndex(startIdx + ratio * Math.max(1, totalUnits() - state.visible));
    render();
  };
  const up = () => {
    state.dragging = false;
    ui.vthumb.classList.remove("active");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function editCmd(cmd) {
  if (state.meta?.editable && state.mode === "text") ui.editor.focus();
  document.execCommand(cmd);
}

document.getElementById("btn-new").onclick = () => api.newFile();
document.getElementById("btn-open").onclick = openFile;
document.getElementById("btn-save").onclick = () => save(false);
document.getElementById("btn-save-as").onclick = () => save(true);
document.getElementById("btn-close").onclick = () => requestClose(state.tabId);
document.getElementById("btn-cut").onclick = () => editCmd("cut");
document.getElementById("btn-copy").onclick = () => editCmd("copy");
document.getElementById("btn-paste").onclick = () => editCmd("paste");
document.getElementById("btn-undo").onclick = () => editCmd("undo");
document.getElementById("btn-redo").onclick = () => editCmd("redo");
document.getElementById("btn-text").onclick = () => setMode("text");
document.getElementById("btn-hex").onclick = () => setMode("hex");
document.getElementById("btn-find").onclick = () => showFind(true);
document.getElementById("btn-find-next").onclick = () => runFind(false);
document.getElementById("btn-goto").onclick = () => showGoto(true);
document.getElementById("btn-snip").onclick = () => api.startSnip();
document.getElementById("btn-record").onclick = () => api.startRecord();
document.getElementById("find-next").onclick = () => runFind(false);
document.getElementById("find-prev").onclick = () => runFind(true);
document.getElementById("find-close").onclick = () => showFind(false);
document.getElementById("goto-go").onclick = runGoto;
document.getElementById("goto-close").onclick = () => showGoto(false);
ui.encoding.onchange = async () => {
  if (!hasDoc()) return;
  const meta = await api.setEncoding(ui.encoding.value);
  applyMeta({ ...state.meta, encoding: meta.encoding, encodingLabel: meta.encodingLabel });
  if (state.meta.path && state.meta.editable && state.mode === "text") {
    ui.editor.value = await api.readText();
    state.dirty = false;
  }
  await render();
};
ui.editor.addEventListener("input", () => {
  state.dirty = true;
  updateEditStatus();
  paintTabs();
});
ui.editor.addEventListener("keyup", updateEditStatus);
ui.editor.addEventListener("click", updateEditStatus);
ui.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runFind(Boolean(e.shiftKey));
  if (e.key === "Escape") showFind(false);
});
ui.gotoInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runGoto();
  if (e.key === "Escape") showGoto(false);
});

document.getElementById("stage").addEventListener("wheel", onWheel, { passive: false });
ui.editor.addEventListener("wheel", onWheel, { passive: false });
window.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
    }
  },
  { passive: false },
);
applyFontSize();
if (ui.stZoom) {
  ui.stZoom.style.cursor = "pointer";
  ui.stZoom.onclick = () => setFontSize(FONT_DEFAULT);
}
ui.vthumb.addEventListener("pointerdown", onThumbPointer);
ui.vscroll.addEventListener("pointerdown", (e) => {
  if (e.target === ui.vthumb) return;
  const rect = ui.vscroll.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / rect.height;
  setIndex(ratio * totalUnits());
  render();
});

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    cycleTab(e.shiftKey);
    return;
  }
  if (e.ctrlKey && !e.altKey && (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0")) {
    e.preventDefault();
    setFontSize(FONT_DEFAULT);
    return;
  }
  if (e.ctrlKey && !e.altKey && (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd")) {
    e.preventDefault();
    setFontSize(state.fontSize + 1);
    return;
  }
  if (e.ctrlKey && !e.altKey && (e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract")) {
    e.preventDefault();
    setFontSize(state.fontSize - 1);
    return;
  }
  if (!hasDoc() || !state.meta.path) return;
  if (state.mode === "text" && state.meta.editable) return;
  if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(e.key) &&
      e.target.tagName !== "INPUT" &&
      e.target.tagName !== "TEXTAREA") {
    e.preventDefault();
    if (e.key === "ArrowDown") setIndex(currentIndex() + 1);
    if (e.key === "ArrowUp") setIndex(currentIndex() - 1);
    if (e.key === "PageDown") setIndex(currentIndex() + state.visible);
    if (e.key === "PageUp") setIndex(currentIndex() - state.visible);
    if (e.key === "Home") setIndex(0);
    if (e.key === "End") setIndex(totalUnits());
    render();
  }
});

window.addEventListener("resize", () => render());
if (ui.tabstrip) {
  ui.tabstrip.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      ui.tabstrip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
}

api.onFileOpened(onOpened);
api.onTabsChanged((data) => {
  tabList = data && Array.isArray(data.tabs) ? data.tabs : [];
  if (data && data.activeId) state.tabId = data.activeId;
  paintTabs();
});
api.onIndexProgress((meta) => {
  if (meta.tabId && state.tabId && meta.tabId !== state.tabId) return;
  applyMeta(meta);
  if (state.mode === "text" && !meta.editable) render();
});
api.onMenu((name) => {
  if (name === "save") save(false);
  if (name === "save-as") save(true);
  if (name === "view-text") setMode("text");
  if (name === "view-hex") setMode("hex");
  if (name === "find") showFind(true);
  if (name === "find-next") runFind(false);
  if (name === "find-prev") runFind(true);
  if (name === "goto") showGoto(true);
  if (name === "delete") deleteSelection();
  if (name === "upper") transformSelection((s) => s.toUpperCase());
  if (name === "lower") transformSelection((s) => s.toLowerCase());
  if (name === "wrap-on") applyWrap(true);
  if (name === "wrap-off") applyWrap(false);
  if (name.startsWith("language:")) {
    state.language = name.slice("language:".length);
    if (ui.stLang) ui.stLang.textContent = LANG_LABELS[state.language] || "纯文本";
  }
  if (name === "close") requestClose(state.tabId);
  if (name === "close-all") requestCloseAll();
  if (name === "snip-hotkey") showHotkeyBox();
  if (name === "record") api.startRecord();
  if (name === "toolbox") window.dispatchEvent(new CustomEvent("editlong-toolbox"));
  if (name.startsWith("toolbox:")) {
    window.dispatchEvent(new CustomEvent("editlong-toolbox", { detail: name.slice(8) }));
  }
  if (name === "about") {
    window.alert(
      "EditLong\n大文件按窗口读取，支持文本/十六进制视图和搜索。\n小于 16MB 的文件可像记事本一样编辑保存。"
    );
  }
});
api.onEncodingChanged(async (meta) => {
  if (meta.tabId && state.tabId && meta.tabId !== state.tabId) return;
  applyMeta(meta);
  if (meta.editable && state.mode === "text" && meta.path) {
    ui.editor.value = await api.readText();
    state.dirty = false;
  }
  await render();
});
api.onError((message) => window.alert(message));
