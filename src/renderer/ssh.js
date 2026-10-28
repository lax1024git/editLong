const api = window.ssh;

const state = {
  connections: [],
  connId: null,
  connected: new Set(),
  remotePath: "/",
  folders: [],
  files: [],
  selected: new Set(),
  editingId: null,
  view: "term",
};

const ui = {
  connList: document.getElementById("conn-list"),
  empty: document.getElementById("empty"),
  table: document.getElementById("file-table"),
  body: document.getElementById("file-body"),
  crumb: document.getElementById("crumb"),
  status: document.getElementById("status-text"),
  progress: document.getElementById("progress"),
  dropHint: document.getElementById("drop-hint"),
  browser: document.getElementById("browser"),
  dlg: document.getElementById("dlg-overlay"),
  dlgMsg: document.getElementById("dlg-msg"),
  mkdirOverlay: document.getElementById("mkdir-overlay"),
  mkdirName: document.getElementById("mkdir-name"),
  mkdirMsg: document.getElementById("mkdir-msg"),
  ctxMenu: document.getElementById("ctx-menu"),
  termCtx: document.getElementById("term-ctx-menu"),
  checkAll: document.getElementById("check-all"),
  term: document.getElementById("term"),
  termEmpty: document.getElementById("term-empty"),
  paneTerm: document.getElementById("pane-term"),
  paneSftp: document.getElementById("pane-sftp"),
};

let ctxTarget = null;
let nameDialog = { mode: "mkdir", item: null };
let term = null;
let fitAddon = null;

function formatSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    p(d.getMonth() + 1) +
    "-" +
    p(d.getDate()) +
    " " +
    p(d.getHours()) +
    ":" +
    p(d.getMinutes())
  );
}

function setStatus(text) {
  ui.status.textContent = text || "";
}

function isOnline() {
  return Boolean(state.connId && state.connected.has(state.connId));
}

function refreshToolbar() {
  const has = Boolean(state.connId);
  const on = isOnline();
  document.getElementById("btn-connect").disabled = !has || on;
  document.getElementById("btn-disconnect").disabled = !on;
  document.getElementById("btn-refresh").disabled = !on;
  document.getElementById("btn-up").disabled = !on || state.remotePath === "/";
  document.getElementById("btn-mkdir").disabled = !on;
  document.getElementById("btn-upload").disabled = !on;
  document.getElementById("btn-download").disabled = !on || state.selected.size === 0;
  document.getElementById("btn-delete").disabled = !on || state.selected.size === 0;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function ensureTerm() {
  if (term) return term;
  const Terminal = window.Terminal;
  const FitAddonNS = window.FitAddon;
  if (!Terminal || !FitAddonNS) {
    setStatus("终端组件未加载");
    return null;
  }
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei Mono", monospace',
    theme: { background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4" },
    scrollback: 5000,
    convertEol: false,
  });
  fitAddon = new FitAddonNS.FitAddon();
  term.loadAddon(fitAddon);
  term.open(ui.term);
  term.onData((data) => {
    if (state.connId && state.connected.has(state.connId)) api.termWrite(state.connId, data);
  });
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    const key = ev.key && ev.key.toLowerCase();
    if ((ev.ctrlKey && ev.shiftKey && key === "c") || (ev.ctrlKey && key === "insert")) {
      copyTerm();
      return false;
    }
    if ((ev.ctrlKey && ev.shiftKey && key === "v") || (ev.shiftKey && key === "insert")) {
      pasteTerm();
      return false;
    }
    return true;
  });
  ui.term.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideContextMenu();
    openTermContextMenu(e.clientX, e.clientY);
  });
  return term;
}

async function copyTerm() {
  if (!term) return;
  const text = term.getSelection ? term.getSelection() : "";
  if (!text) {
    setStatus("没有选中的文本");
    return;
  }
  await api.clipboardWrite(text);
  setStatus("已复制");
}

async function pasteTerm() {
  if (!term || !isOnline()) return;
  const res = await api.clipboardRead();
  const text = res && res.text ? res.text : "";
  if (!text) return;
  api.termWrite(state.connId, text);
}

function hideTermContextMenu() {
  if (ui.termCtx) ui.termCtx.classList.add("hidden");
}

function openTermContextMenu(x, y) {
  if (!ui.termCtx) return;
  const copyBtn = ui.termCtx.querySelector('[data-action="copy"]');
  const pasteBtn = ui.termCtx.querySelector('[data-action="paste"]');
  const hasSel = Boolean(term && term.hasSelection && term.hasSelection());
  copyBtn.disabled = !hasSel;
  pasteBtn.disabled = !isOnline();
  const pad = 6;
  ui.termCtx.style.left = x + "px";
  ui.termCtx.style.top = y + "px";
  ui.termCtx.classList.remove("hidden");
  const rect = ui.termCtx.getBoundingClientRect();
  ui.termCtx.style.left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad)) + "px";
  ui.termCtx.style.top = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad)) + "px";
}

function fitTerm() {
  if (!term || !fitAddon || ui.term.classList.contains("hidden")) return;
  try {
    fitAddon.fit();
    if (state.connId && state.connected.has(state.connId)) {
      api.termResize({ connId: state.connId, cols: term.cols, rows: term.rows });
    }
  } catch {
    /* ignore */
  }
}

function showTerm() {
  ui.termEmpty.classList.add("hidden");
  ui.term.classList.remove("hidden");
  ensureTerm();
  requestAnimationFrame(fitTerm);
}

async function reloadConnections() {
  state.connections = await api.listConnections();
  state.connections.forEach((c) => {
    if (c.connected) state.connected.add(c.id);
  });
  paintConnections();
}

function paintConnections() {
  ui.connList.replaceChildren();
  if (!state.connections.length) {
    const tip = document.createElement("div");
    tip.style.cssText = "padding:12px;color:#888;font-size:12px;line-height:1.5";
    tip.textContent = "暂无主机。点击右上角 + 添加 SSH 连接。";
    ui.connList.appendChild(tip);
    return;
  }
  state.connections.forEach((c) => {
    const el = document.createElement("div");
    const online = state.connected.has(c.id);
    el.className =
      "conn-item" +
      (c.id === state.connId ? " active" : "") +
      (online ? " online" : "");
    el.innerHTML =
      '<span class="dot"></span><div class="meta"><div class="name"></div><div class="sub"></div></div>' +
      '<div class="ops"><button type="button" data-act="edit" title="编辑">✎</button>' +
      '<button type="button" data-act="del" title="删除">×</button></div>';
    el.querySelector(".name").textContent = c.name;
    el.querySelector(".sub").textContent = c.username + "@" + c.host + ":" + c.port;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".ops")) return;
      selectConnection(c.id);
    });
    el.querySelector('[data-act="edit"]').onclick = (e) => {
      e.stopPropagation();
      openDialog(c.id);
    };
    el.querySelector('[data-act="del"]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("删除主机「" + c.name + "」？")) return;
      await api.deleteConnection(c.id);
      state.connected.delete(c.id);
      if (state.connId === c.id) {
        state.connId = null;
        showSftpEmpty("请选择左侧主机");
      }
      await reloadConnections();
      refreshToolbar();
    };
    ui.connList.appendChild(el);
  });
}

function showSftpEmpty(msg) {
  ui.empty.classList.remove("hidden");
  ui.table.classList.add("hidden");
  ui.empty.textContent = msg || "连接后可浏览远程文件";
  ui.crumb.replaceChildren();
  refreshToolbar();
}

function paintCrumb() {
  ui.crumb.replaceChildren();
  const parts = String(state.remotePath || "/")
    .split("/")
    .filter(Boolean);
  const add = (label, p, clickable) => {
    if (ui.crumb.childElementCount) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      ui.crumb.appendChild(sep);
    }
    if (clickable) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.onclick = () => {
        state.remotePath = p;
        refreshList();
      };
      ui.crumb.appendChild(btn);
    } else {
      const span = document.createElement("span");
      span.textContent = label;
      ui.crumb.appendChild(span);
    }
  };
  add("/", "/", parts.length > 0);
  let acc = "";
  parts.forEach((part, i) => {
    acc += "/" + part;
    add(part, acc, i < parts.length - 1);
  });
}

function selKey(item) {
  return item.type + ":" + item.path;
}

function paintRows() {
  ui.body.replaceChildren();
  ui.checkAll.checked = false;
  const rows = [...state.folders, ...state.files];
  if (!rows.length) {
    showSftpEmpty("当前目录为空。可拖入文件/文件夹上传，或点「上传」。");
    ui.empty.classList.remove("hidden");
    return;
  }
  ui.empty.classList.add("hidden");
  ui.table.classList.remove("hidden");
  rows.forEach((item) => {
    const tr = document.createElement("tr");
    tr.className = item.type === "folder" ? "folder" : "file";
    if (state.selected.has(selKey(item))) tr.classList.add("selected");
    tr.innerHTML =
      '<td class="col-check"><input type="checkbox" /></td>' +
      '<td><div class="name-cell"><span class="icon"></span><span class="name"></span></div></td>' +
      '<td class="col-size"></td><td class="col-time"></td>';
    tr.querySelector(".icon").textContent = item.type === "folder" ? "📁" : "📄";
    tr.querySelector(".name").textContent = item.name;
    tr.querySelector(".col-size").textContent = item.type === "file" ? formatSize(item.size) : "";
    tr.querySelector(".col-time").textContent = item.type === "file" ? formatTime(item.mtime) : "";
    const cb = tr.querySelector('input[type="checkbox"]');
    cb.checked = state.selected.has(selKey(item));
    cb.onclick = (e) => {
      e.stopPropagation();
      toggleSelect(item, cb.checked);
    };
    tr.onclick = (e) => {
      if (e.target.closest("input")) return;
      if (e.ctrlKey || e.metaKey) {
        toggleSelect(item, !state.selected.has(selKey(item)));
      } else {
        state.selected.clear();
        state.selected.add(selKey(item));
        paintRows();
        refreshToolbar();
      }
    };
    tr.ondblclick = () => {
      if (item.type === "folder") {
        state.remotePath = item.path;
        state.selected.clear();
        refreshList();
      } else {
        state.selected.clear();
        state.selected.add(selKey(item));
        doDownload();
      }
    };
    tr.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.selected.has(selKey(item))) {
        state.selected.clear();
        state.selected.add(selKey(item));
        paintRows();
        refreshToolbar();
      }
      openContextMenu(e.clientX, e.clientY, item);
    };
    ui.body.appendChild(tr);
  });
  refreshToolbar();
}

function hideContextMenu() {
  ctxTarget = null;
  ui.ctxMenu.classList.add("hidden");
  hideTermContextMenu();
}

function openContextMenu(x, y, item) {
  ctxTarget = item;
  const pad = 6;
  ui.ctxMenu.style.left = x + "px";
  ui.ctxMenu.style.top = y + "px";
  ui.ctxMenu.classList.remove("hidden");
  const rect = ui.ctxMenu.getBoundingClientRect();
  ui.ctxMenu.style.left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad)) + "px";
  ui.ctxMenu.style.top = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad)) + "px";
}

function toggleSelect(item, on) {
  const k = selKey(item);
  if (on) state.selected.add(k);
  else state.selected.delete(k);
  paintRows();
  refreshToolbar();
}

function selectedItems() {
  const map = new Map();
  [...state.folders, ...state.files].forEach((it) => map.set(selKey(it), it));
  return [...state.selected].map((k) => map.get(k)).filter(Boolean);
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".view-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  ui.paneTerm.classList.toggle("hidden", view !== "term");
  ui.paneSftp.classList.toggle("hidden", view !== "sftp");
  if (view === "term") requestAnimationFrame(fitTerm);
}

function selectConnection(id) {
  state.connId = id;
  paintConnections();
  refreshToolbar();
  const c = state.connections.find((x) => x.id === id);
  if (c) setStatus(c.username + "@" + c.host);
  if (state.connected.has(id)) {
    showTerm();
    refreshList();
  } else {
    ui.termEmpty.classList.remove("hidden");
    ui.term.classList.add("hidden");
    ui.termEmpty.textContent = "点击「连接」打开终端与 SFTP";
    showSftpEmpty("尚未连接");
  }
}

async function doConnect() {
  if (!state.connId) return;
  setStatus("正在连接…");
  document.getElementById("btn-connect").disabled = true;
  const res = await api.connect(state.connId);
  if (!res.ok) {
    setStatus(res.error || "连接失败");
    alert(res.error || "连接失败");
    refreshToolbar();
    return;
  }
  state.connected.add(state.connId);
  state.remotePath = res.cwd || "/";
  paintConnections();
  showTerm();
  ensureTerm();
  fitTerm();
  const termRes = await api.termOpen({
    connId: state.connId,
    cols: term ? term.cols : 80,
    rows: term ? term.rows : 24,
  });
  if (!termRes.ok) setStatus(termRes.error || "终端打开失败");
  else setStatus("已连接");
  await refreshList();
  refreshToolbar();
}

async function doDisconnect() {
  if (!state.connId) return;
  await api.disconnect(state.connId);
  onDisconnected(state.connId);
}

function onDisconnected(id) {
  state.connected.delete(id);
  if (state.connId === id) {
    if (term) term.reset();
    ui.term.classList.add("hidden");
    ui.termEmpty.classList.remove("hidden");
    ui.termEmpty.textContent = "已断开";
    showSftpEmpty("已断开");
    setStatus("已断开");
  }
  paintConnections();
  refreshToolbar();
}

async function refreshList() {
  if (!isOnline()) return;
  setStatus("加载中…");
  const res = await api.list({ connId: state.connId, remotePath: state.remotePath });
  if (!res.ok) {
    setStatus(res.error || "列出失败");
    showSftpEmpty(res.error || "列出失败");
    return;
  }
  state.remotePath = res.path || "/";
  state.folders = res.folders || [];
  state.files = res.files || [];
  state.selected.clear();
  paintCrumb();
  paintRows();
  setStatus(
    state.remotePath +
      " · " +
      state.folders.length +
      " 文件夹 · " +
      state.files.length +
      " 文件",
  );
  refreshToolbar();
}

function toggleAuthRows() {
  const key = document.getElementById("f-auth").value === "key";
  document.getElementById("row-pass").classList.toggle("hidden", key);
  document.getElementById("row-key").classList.toggle("hidden", !key);
  document.getElementById("row-phrase").classList.toggle("hidden", !key);
}

function openDialog(id) {
  state.editingId = id || null;
  document.getElementById("dlg-title").textContent = id ? "编辑主机" : "新建主机";
  ui.dlgMsg.textContent = "";
  ui.dlgMsg.className = "msg";
  const fill = async () => {
    let data = {
      name: "",
      host: "",
      port: 22,
      username: "",
      auth: "password",
      password: "",
      passphrase: "",
      privateKeyPath: "",
    };
    if (id) {
      const c = await api.getConnection(id);
      if (c) data = c;
    }
    document.getElementById("f-name").value = data.name || "";
    document.getElementById("f-host").value = data.host || "";
    document.getElementById("f-port").value = data.port || 22;
    document.getElementById("f-user").value = data.username || "";
    document.getElementById("f-auth").value = data.auth || "password";
    document.getElementById("f-pass").value = data.password || "";
    document.getElementById("f-key").value = data.privateKeyPath || "";
    document.getElementById("f-phrase").value = data.passphrase || "";
    toggleAuthRows();
  };
  fill().then(() => ui.dlg.classList.remove("hidden"));
}

function closeDialog() {
  ui.dlg.classList.add("hidden");
  state.editingId = null;
}

function dialogPayload() {
  return {
    id: state.editingId || undefined,
    name: document.getElementById("f-name").value.trim() || "未命名主机",
    host: document.getElementById("f-host").value.trim(),
    port: Number(document.getElementById("f-port").value) || 22,
    username: document.getElementById("f-user").value.trim(),
    auth: document.getElementById("f-auth").value,
    password: document.getElementById("f-pass").value,
    privateKeyPath: document.getElementById("f-key").value.trim(),
    passphrase: document.getElementById("f-phrase").value,
  };
}

async function saveDialog() {
  const payload = dialogPayload();
  if (!payload.host) {
    ui.dlgMsg.textContent = "请填写主机";
    ui.dlgMsg.className = "msg err";
    return;
  }
  if (!payload.username) {
    ui.dlgMsg.textContent = "请填写用户名";
    ui.dlgMsg.className = "msg err";
    return;
  }
  const saved = await api.saveConnection(payload);
  await reloadConnections();
  closeDialog();
  if (saved && saved.id) selectConnection(saved.id);
}

async function testDialog() {
  const payload = dialogPayload();
  const saved = await api.saveConnection(payload);
  state.editingId = saved.id;
  ui.dlgMsg.textContent = "测试中…";
  ui.dlgMsg.className = "msg";
  const res = await api.testConnection(saved.id);
  if (res.ok) {
    ui.dlgMsg.textContent = "连接成功，远程目录 " + (res.cwd || "/");
    ui.dlgMsg.className = "msg ok";
  } else {
    ui.dlgMsg.textContent = res.error || "连接失败";
    ui.dlgMsg.className = "msg err";
  }
  await reloadConnections();
}

async function doUpload(paths) {
  if (!isOnline()) return;
  let res;
  if (paths && paths.length) {
    res = await api.uploadPaths({
      connId: state.connId,
      remotePath: state.remotePath,
      paths,
    });
  } else {
    res = await api.pickUpload({ connId: state.connId, remotePath: state.remotePath });
  }
  if (!res.ok) {
    setStatus(res.error || "上传失败");
    alert(res.error || "上传失败");
    return;
  }
  if (res.cancelled) return;
  await refreshList();
  setStatus("上传完成：" + (res.uploaded || 0) + " 个文件");
}

async function doDownload() {
  const items = selectedItems();
  if (!items.length) return;
  const res = await api.download({
    connId: state.connId,
    items: items.map((it) => ({ type: it.type, path: it.path, name: it.name })),
  });
  if (!res.ok) {
    alert(res.error || "下载失败");
    return;
  }
  if (res.cancelled) return;
  setStatus("已下载 " + (res.paths || []).length + " 个文件");
  if (res.paths && res.paths[0]) api.reveal(res.paths[0]);
}

async function doDelete() {
  const items = selectedItems();
  if (!items.length) return;
  if (!confirm("确定删除选中的 " + items.length + " 项？文件夹将递归删除。")) return;
  const res = await api.remove({
    connId: state.connId,
    items: items.map((it) => ({ type: it.type, path: it.path })),
  });
  if (!res.ok) {
    alert(res.error || "删除失败");
    return;
  }
  await refreshList();
}

function closeMkdirDialog() {
  ui.mkdirOverlay.classList.add("hidden");
  ui.mkdirMsg.textContent = "";
  ui.mkdirMsg.className = "msg";
  ui.mkdirName.value = "";
  nameDialog = { mode: "mkdir", item: null };
}

function openNameDialog(opts) {
  nameDialog = { mode: opts.mode || "mkdir", item: opts.item || null };
  document.getElementById("mkdir-title").textContent = opts.title || "新建文件夹";
  document.getElementById("mkdir-label-text").textContent = opts.label || "文件夹名称";
  document.getElementById("mkdir-ok").textContent = opts.okText || "确定";
  ui.mkdirName.placeholder = opts.placeholder || "";
  ui.mkdirMsg.textContent = "";
  ui.mkdirMsg.className = "msg";
  ui.mkdirName.value = opts.value || "";
  ui.mkdirOverlay.classList.remove("hidden");
  setTimeout(() => {
    ui.mkdirName.focus();
    ui.mkdirName.select();
  }, 0);
}

async function submitMkdir() {
  const raw = (ui.mkdirName.value || "").trim();
  if (!raw) {
    ui.mkdirMsg.textContent = "请输入名称";
    ui.mkdirMsg.className = "msg err";
    return;
  }
  if (/[\\/]/.test(raw) || raw.includes("..")) {
    ui.mkdirMsg.textContent = "名称不能包含 /、\\ 或 ..";
    ui.mkdirMsg.className = "msg err";
    return;
  }
  const parent = state.remotePath === "/" ? "" : state.remotePath;
  const full = (parent || "") + "/" + raw;

  if (nameDialog.mode === "rename" && nameDialog.item) {
    const item = nameDialog.item;
    if (raw === item.name) {
      closeMkdirDialog();
      return;
    }
    const dest = (item.path.replace(/\/[^/]+$/, "") || "") + "/" + raw;
    ui.mkdirMsg.textContent = "正在重命名…";
    const res = await api.rename({ connId: state.connId, fromPath: item.path, toPath: dest.replace(/^\/?/, "/") });
    if (!res.ok) {
      ui.mkdirMsg.textContent = res.error || "重命名失败";
      ui.mkdirMsg.className = "msg err";
      return;
    }
    closeMkdirDialog();
    await refreshList();
    return;
  }

  ui.mkdirMsg.textContent = "正在创建…";
  const res = await api.mkdir({ connId: state.connId, remotePath: full.replace(/^\/?/, "/") });
  if (!res.ok) {
    ui.mkdirMsg.textContent = res.error || "创建失败";
    ui.mkdirMsg.className = "msg err";
    return;
  }
  closeMkdirDialog();
  await refreshList();
}

function bindDragDrop() {
  let dragDepth = 0;
  ui.browser.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (!isOnline()) return;
    dragDepth += 1;
    ui.browser.classList.add("dragover");
    ui.dropHint.classList.remove("hidden");
  });
  ui.browser.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  ui.browser.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      ui.browser.classList.remove("dragover");
      ui.dropHint.classList.add("hidden");
    }
  });
  ui.browser.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    ui.browser.classList.remove("dragover");
    ui.dropHint.classList.add("hidden");
    if (!isOnline()) return;
    const files = [...(e.dataTransfer.files || [])];
    const paths = files.map((f) => api.getPathForFile(f)).filter(Boolean);
    if (!paths.length) {
      alert("未能获取本地路径。请使用「上传」按钮。");
      return;
    }
    await doUpload(paths);
  });
}

function bind() {
  document.getElementById("btn-add").onclick = () => openDialog(null);
  document.getElementById("btn-connect").onclick = doConnect;
  document.getElementById("btn-disconnect").onclick = doDisconnect;
  document.getElementById("btn-refresh").onclick = () => refreshList();
  document.getElementById("btn-up").onclick = () => {
    if (state.remotePath === "/") return;
    const parts = state.remotePath.split("/").filter(Boolean);
    parts.pop();
    state.remotePath = parts.length ? "/" + parts.join("/") : "/";
    refreshList();
  };
  document.getElementById("btn-mkdir").onclick = () =>
    openNameDialog({
      mode: "mkdir",
      title: "新建文件夹",
      label: "文件夹名称",
      placeholder: "例如 logs",
      okText: "创建",
    });
  document.getElementById("mkdir-ok").onclick = () => submitMkdir();
  document.getElementById("mkdir-cancel").onclick = closeMkdirDialog;
  ui.mkdirOverlay.addEventListener("click", (e) => {
    if (e.target === ui.mkdirOverlay) closeMkdirDialog();
  });
  ui.mkdirName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitMkdir();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMkdirDialog();
    }
  });
  document.getElementById("btn-upload").onclick = () => doUpload();
  document.getElementById("btn-download").onclick = doDownload;
  document.getElementById("btn-delete").onclick = doDelete;
  document.querySelectorAll(".view-tab").forEach((btn) => {
    btn.onclick = () => setView(btn.dataset.view);
  });
  ui.ctxMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const item = ctxTarget;
    hideContextMenu();
    if (action === "rename") {
      openNameDialog({
        mode: "rename",
        item,
        title: "重命名",
        label: "新名称",
        value: item && item.name,
        okText: "重命名",
      });
    } else if (action === "download") await doDownload();
    else if (action === "delete") await doDelete();
  });
  ui.termCtx.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    hideTermContextMenu();
    if (action === "copy") await copyTerm();
    else if (action === "paste") await pasteTerm();
  });
  document.addEventListener("click", (e) => {
    if (!ui.ctxMenu.classList.contains("hidden") && !ui.ctxMenu.contains(e.target)) hideContextMenu();
    if (ui.termCtx && !ui.termCtx.classList.contains("hidden") && !ui.termCtx.contains(e.target)) {
      hideTermContextMenu();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("resize", () => {
    hideContextMenu();
    fitTerm();
  });
  ui.checkAll.onchange = () => {
    state.selected.clear();
    if (ui.checkAll.checked) {
      [...state.folders, ...state.files].forEach((it) => state.selected.add(selKey(it)));
    }
    paintRows();
    refreshToolbar();
  };
  document.getElementById("f-auth").onchange = toggleAuthRows;
  document.getElementById("btn-pick-key").onclick = async () => {
    const res = await api.pickKey();
    if (res && res.path) document.getElementById("f-key").value = res.path;
  };
  document.getElementById("dlg-cancel").onclick = closeDialog;
  document.getElementById("dlg-save").onclick = saveDialog;
  document.getElementById("dlg-test").onclick = testDialog;
  ui.dlg.addEventListener("mousedown", (e) => {
    if (e.target === ui.dlg) closeDialog();
  });
  api.onProgress((p) => {
    if (!p || p.phase === "done") {
      ui.progress.classList.add("hidden");
      return;
    }
    ui.progress.classList.remove("hidden");
    if (p.phase === "error") {
      ui.progress.textContent = "失败：" + (p.error || "");
      return;
    }
    ui.progress.textContent =
      (p.phase === "upload" ? "上传" : "下载") +
      " " +
      (p.name || "") +
      "  " +
      (p.loaded || 0) +
      "/" +
      (p.total || 0);
  });
  api.onTermData((p) => {
    if (!p || p.connId !== state.connId || !term) return;
    term.write(b64ToBytes(p.data));
  });
  api.onTermExit((p) => {
    if (p && p.connId === state.connId) setStatus("远程 Shell 已结束");
  });
  api.onDisconnected((p) => {
    if (p && p.connId) onDisconnected(p.connId);
  });
  bindDragDrop();
}

async function init() {
  bind();
  await reloadConnections();
  refreshToolbar();
}

init();
