const api = window.storage;

const state = {
  providers: [],
  connections: [],
  connId: null,
  bucket: "",
  prefix: "",
  folders: [],
  files: [],
  selected: new Set(),
  editingId: null,
};

const ui = {
  connList: document.getElementById("conn-list"),
  empty: document.getElementById("empty"),
  table: document.getElementById("file-table"),
  body: document.getElementById("file-body"),
  crumb: document.getElementById("crumb"),
  bucket: document.getElementById("bucket-select"),
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
  checkAll: document.getElementById("check-all"),
};

let ctxTarget = null;
/** @type {{ mode: "mkdir" | "rename", item?: object | null }} */
let nameDialog = { mode: "mkdir", item: null };

function formatSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
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
  } catch {
    return iso;
  }
}

function providerLabel(id) {
  const p = state.providers.find((x) => x.id === id);
  return p ? p.label : id;
}

function setStatus(text) {
  ui.status.textContent = text || "";
}

function refreshToolbar() {
  const ready = Boolean(state.connId && state.bucket);
  document.getElementById("btn-refresh").disabled = !ready;
  document.getElementById("btn-up").disabled = !ready || !state.prefix;
  document.getElementById("btn-mkdir").disabled = !ready;
  document.getElementById("btn-upload").disabled = !ready;
  document.getElementById("btn-download").disabled = !ready || state.selected.size === 0;
  document.getElementById("btn-delete").disabled = !ready || state.selected.size === 0;
  ui.bucket.disabled = !state.connId;
}

async function reloadConnections() {
  state.connections = await api.listConnections();
  paintConnections();
}

function paintConnections() {
  ui.connList.replaceChildren();
  if (!state.connections.length) {
    const tip = document.createElement("div");
    tip.style.cssText = "padding:12px;color:#888;font-size:12px;line-height:1.5";
    tip.textContent = "暂无连接。点击右上角 + 添加 OSS / COS / BOS / S3 / B2。";
    ui.connList.appendChild(tip);
    return;
  }
  state.connections.forEach((c) => {
    const el = document.createElement("div");
    el.className = "conn-item" + (c.id === state.connId ? " active" : "");
    el.innerHTML =
      '<div class="meta"><div class="name"></div><div class="sub"></div></div>' +
      '<div class="ops"><button type="button" data-act="edit" title="编辑">✎</button>' +
      '<button type="button" data-act="del" title="删除">×</button></div>';
    el.querySelector(".name").textContent = c.name;
    el.querySelector(".sub").textContent = providerLabel(c.provider) + (c.bucket ? " · " + c.bucket : "");
    el.addEventListener("click", (e) => {
      if (e.target.closest(".ops")) return;
      openConnection(c.id);
    });
    el.querySelector('[data-act="edit"]').onclick = (e) => {
      e.stopPropagation();
      openDialog(c.id);
    };
    el.querySelector('[data-act="del"]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("删除连接「" + c.name + "」？")) return;
      await api.deleteConnection(c.id);
      if (state.connId === c.id) {
        state.connId = null;
        state.bucket = "";
        state.prefix = "";
        showEmpty();
      }
      await reloadConnections();
    };
    ui.connList.appendChild(el);
  });
}

function showEmpty(msg) {
  ui.empty.classList.remove("hidden");
  ui.table.classList.add("hidden");
  ui.empty.textContent = msg || "请选择左侧连接源，或新建 OSS / COS / BOS / S3 / B2 连接";
  ui.crumb.replaceChildren();
  refreshToolbar();
}

function paintCrumb() {
  ui.crumb.replaceChildren();
  const add = (label, prefix, clickable) => {
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
        state.prefix = prefix;
        refreshList();
      };
      ui.crumb.appendChild(btn);
    } else {
      const span = document.createElement("span");
      span.textContent = label;
      ui.crumb.appendChild(span);
    }
  };
  add(state.bucket || "bucket", "", true);
  const parts = state.prefix.split("/").filter(Boolean);
  let acc = "";
  parts.forEach((part, i) => {
    acc += part + "/";
    add(part, acc, i < parts.length - 1);
  });
}

function selKey(item) {
  return item.type + ":" + item.key;
}

function paintRows() {
  ui.body.replaceChildren();
  ui.checkAll.checked = false;
  const rows = [...state.folders, ...state.files];
  if (!rows.length) {
    ui.empty.classList.remove("hidden");
    ui.table.classList.add("hidden");
    ui.empty.textContent = "当前目录为空。可拖入文件/文件夹上传，或点「上传」。";
    return;
  }
  ui.empty.classList.add("hidden");
  ui.table.classList.remove("hidden");
  rows.forEach((item) => {
    const tr = document.createElement("tr");
    tr.className = item.type === "folder" ? "folder" : "file";
    if (state.selected.has(selKey(item))) tr.classList.add("selected");
    tr.dataset.key = selKey(item);
    tr.innerHTML =
      '<td class="col-check"><input type="checkbox" /></td>' +
      '<td><div class="name-cell"><span class="icon"></span><span class="name"></span></div></td>' +
      '<td class="col-size"></td><td class="col-time"></td>';
    tr.querySelector(".icon").textContent = item.type === "folder" ? "📁" : "📄";
    tr.querySelector(".name").textContent = item.name;
    tr.querySelector(".col-size").textContent = item.type === "file" ? formatSize(item.size) : "";
    tr.querySelector(".col-time").textContent = item.type === "file" ? formatTime(item.lastModified) : "";
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
        state.prefix = item.key;
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
}

function openContextMenu(x, y, item) {
  ctxTarget = item;
  const copyBtn = ui.ctxMenu.querySelector('[data-action="copy-url"]');
  const renameBtn = ui.ctxMenu.querySelector('[data-action="rename"]');
  const downloadBtn = ui.ctxMenu.querySelector('[data-action="download"]');
  const deleteBtn = ui.ctxMenu.querySelector('[data-action="delete"]');
  copyBtn.disabled = item.type !== "file";
  renameBtn.disabled = false;
  downloadBtn.disabled = false;
  deleteBtn.disabled = false;
  const pad = 6;
  ui.ctxMenu.style.left = x + "px";
  ui.ctxMenu.style.top = y + "px";
  ui.ctxMenu.classList.remove("hidden");
  const rect = ui.ctxMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - pad);
  const top = Math.min(y, window.innerHeight - rect.height - pad);
  ui.ctxMenu.style.left = Math.max(pad, left) + "px";
  ui.ctxMenu.style.top = Math.max(pad, top) + "px";
}

async function copyAccessUrl(item) {
  const target = item || selectedItems().find((i) => i.type === "file");
  if (!target || target.type !== "file") {
    setStatus("请选择文件后再复制访问地址");
    return;
  }
  if (!state.connId || !state.bucket) return;
  const res = await api.copyObjectUrl({
    connId: state.connId,
    bucket: state.bucket,
    key: target.key,
  });
  if (!res.ok) {
    alert(res.error || "复制失败");
    return;
  }
  setStatus("已复制访问地址：" + res.url);
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

async function openConnection(id) {
  state.connId = id;
  state.prefix = "";
  state.selected.clear();
  paintConnections();
  setStatus("加载 Bucket…");
  const res = await api.listBuckets(id);
  ui.bucket.replaceChildren();
  if (!res.ok) {
    setStatus(res.error || "加载失败");
    showEmpty("无法列出 Bucket：\n" + (res.error || ""));
    refreshToolbar();
    return;
  }
  const conn = state.connections.find((c) => c.id === id);
  let buckets = res.buckets || [];
  if (!buckets.length && conn && conn.bucket) {
    buckets = [{ name: conn.bucket }];
  }
  if (!buckets.length) {
    showEmpty("该账号下没有 Bucket，请在连接里填写默认 Bucket 或到云控制台创建。");
    refreshToolbar();
    return;
  }
  buckets.forEach((b) => {
    const opt = document.createElement("option");
    opt.value = b.name;
    opt.textContent = b.name;
    ui.bucket.appendChild(opt);
  });
  state.bucket = (conn && conn.bucket && buckets.some((b) => b.name === conn.bucket)
    ? conn.bucket
    : buckets[0].name);
  ui.bucket.value = state.bucket;
  await refreshList();
}

async function refreshList() {
  if (!state.connId || !state.bucket) return;
  setStatus("加载中…");
  document.getElementById("btn-refresh").disabled = true;
  const res = await api.list({ connId: state.connId, bucket: state.bucket, prefix: state.prefix });
  if (!res.ok) {
    setStatus(res.error || "列出失败");
    showEmpty(res.error || "列出失败");
    refreshToolbar();
    return;
  }
  state.prefix = res.prefix || "";
  state.folders = res.folders || [];
  state.files = res.files || [];
  state.selected.clear();
  paintCrumb();
  paintRows();
  setStatus(
    state.bucket +
      (state.prefix ? "/" + state.prefix.replace(/\/$/, "") : "") +
      " · " +
      state.folders.length +
      " 文件夹 · " +
      state.files.length +
      " 文件",
  );
  refreshToolbar();
}

function openDialog(id) {
  state.editingId = id || null;
  document.getElementById("dlg-title").textContent = id ? "编辑连接" : "新建连接";
  ui.dlgMsg.textContent = "";
  ui.dlgMsg.className = "msg";
  const fill = async () => {
    const provSel = document.getElementById("f-provider");
    provSel.replaceChildren();
    state.providers.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      provSel.appendChild(opt);
    });
    let data = {
      name: "",
      provider: "oss",
      endpoint: "",
      region: "",
      accessKeyId: "",
      secretAccessKey: "",
      bucket: "",
      forcePathStyle: false,
    };
    if (id) {
      const c = await api.getConnection(id);
      if (c) data = c;
    }
    document.getElementById("f-name").value = data.name || "";
    document.getElementById("f-provider").value = data.provider || "oss";
    applyProviderDefaults(false);
    document.getElementById("f-endpoint").value = data.endpoint || document.getElementById("f-endpoint").value;
    document.getElementById("f-region").value = data.region || document.getElementById("f-region").value;
    document.getElementById("f-ak").value = data.accessKeyId || "";
    document.getElementById("f-sk").value = data.hasSecret || data.secretAccessKey ? "********" : "";
    document.getElementById("f-bucket").value = data.bucket || "";
    document.getElementById("f-pathstyle").checked = Boolean(data.forcePathStyle);
  };
  fill().then(() => ui.dlg.classList.remove("hidden"));
}

function applyProviderDefaults(overwrite) {
  const id = document.getElementById("f-provider").value;
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  document.getElementById("f-hint").textContent = p.hint || "";
  if (overwrite || !document.getElementById("f-endpoint").value) {
    document.getElementById("f-endpoint").value = p.endpoint || "";
  }
  if (overwrite || !document.getElementById("f-region").value) {
    document.getElementById("f-region").value = p.region || "";
  }
  if (overwrite) document.getElementById("f-pathstyle").checked = Boolean(p.forcePathStyle);
}

function closeDialog() {
  ui.dlg.classList.add("hidden");
  state.editingId = null;
}

async function saveDialog() {
  const payload = {
    id: state.editingId || undefined,
    name: document.getElementById("f-name").value.trim() || "未命名连接",
    provider: document.getElementById("f-provider").value,
    endpoint: document.getElementById("f-endpoint").value.trim(),
    region: document.getElementById("f-region").value.trim(),
    accessKeyId: document.getElementById("f-ak").value.trim(),
    secretAccessKey: document.getElementById("f-sk").value,
    bucket: document.getElementById("f-bucket").value.trim(),
    forcePathStyle: document.getElementById("f-pathstyle").checked,
  };
  if (!payload.accessKeyId) {
    ui.dlgMsg.textContent = "请填写 Access Key";
    ui.dlgMsg.className = "msg err";
    return;
  }
  const saved = await api.saveConnection(payload);
  await reloadConnections();
  closeDialog();
  if (saved && saved.id) await openConnection(saved.id);
}

async function testDialog() {
  const payload = {
    id: state.editingId || undefined,
    name: document.getElementById("f-name").value.trim() || "测试连接",
    provider: document.getElementById("f-provider").value,
    endpoint: document.getElementById("f-endpoint").value.trim(),
    region: document.getElementById("f-region").value.trim(),
    accessKeyId: document.getElementById("f-ak").value.trim(),
    secretAccessKey: document.getElementById("f-sk").value,
    bucket: document.getElementById("f-bucket").value.trim(),
    forcePathStyle: document.getElementById("f-pathstyle").checked,
  };
  const saved = await api.saveConnection(payload);
  state.editingId = saved.id;
  ui.dlgMsg.textContent = "测试中…";
  ui.dlgMsg.className = "msg";
  const res = await api.testConnection(saved.id);
  if (res.ok) {
    ui.dlgMsg.textContent = "连接成功，可见 " + res.buckets + " 个 Bucket";
    ui.dlgMsg.className = "msg ok";
  } else {
    ui.dlgMsg.textContent = res.error || "连接失败";
    ui.dlgMsg.className = "msg err";
  }
  await reloadConnections();
}

async function doUpload(paths) {
  if (!state.connId || !state.bucket) return;
  let res;
  if (paths && paths.length) {
    res = await api.uploadPaths({
      connId: state.connId,
      bucket: state.bucket,
      prefix: state.prefix,
      paths,
    });
  } else {
    res = await api.pickUpload({
      connId: state.connId,
      bucket: state.bucket,
      prefix: state.prefix,
    });
  }
  if (!res.ok) {
    setStatus(res.error || "上传失败");
    alert(res.error || "上传失败");
    return;
  }
  if (res.cancelled) return;
  await refreshList();
  setStatus("上传完成：" + (res.uploaded || 0) + " 个对象");
}

async function doDownload() {
  const items = selectedItems();
  if (!items.length) return;
  const res = await api.download({
    connId: state.connId,
    bucket: state.bucket,
    items: items.map((it) => ({
      type: it.type,
      key: it.key,
      name: it.name,
    })),
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
  if (!confirm("确定删除选中的 " + items.length + " 项？文件夹将删除其下全部对象。")) return;
  const keys = items.filter((i) => i.type === "file").map((i) => i.key);
  const folders = items.filter((i) => i.type === "folder").map((i) => i.key);
  const res = await api.remove({
    connId: state.connId,
    bucket: state.bucket,
    keys,
    folders,
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
  if (!state.connId || !state.bucket) return;
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

function openMkdirDialog() {
  openNameDialog({
    mode: "mkdir",
    title: "新建文件夹",
    label: "文件夹名称",
    placeholder: "例如 docs",
    okText: "创建",
    value: "",
  });
}

function openRenameDialog(item) {
  if (!item) return;
  const baseName = String(item.name || "").replace(/\/$/, "");
  openNameDialog({
    mode: "rename",
    item,
    title: item.type === "folder" ? "重命名文件夹" : "重命名文件",
    label: "新名称",
    placeholder: baseName,
    okText: "重命名",
    value: baseName,
  });
}

async function submitMkdir() {
  const raw = (ui.mkdirName.value || "").trim();
  if (!raw) {
    ui.mkdirMsg.textContent = "请输入名称";
    ui.mkdirMsg.className = "msg err";
    ui.mkdirName.focus();
    return;
  }
  if (/[\\/]/.test(raw) || raw.includes("..")) {
    ui.mkdirMsg.textContent = "名称不能包含 /、\\ 或 ..";
    ui.mkdirMsg.className = "msg err";
    return;
  }
  const name = raw.replace(/^\/+|\/+$/g, "");
  if (!name) {
    ui.mkdirMsg.textContent = "名称无效";
    ui.mkdirMsg.className = "msg err";
    return;
  }

  if (nameDialog.mode === "rename" && nameDialog.item) {
    const item = nameDialog.item;
    if (name === String(item.name || "").replace(/\/$/, "")) {
      closeMkdirDialog();
      return;
    }
    ui.mkdirMsg.textContent = "正在重命名…";
    ui.mkdirMsg.className = "msg";
    const res = await api.rename({
      connId: state.connId,
      bucket: state.bucket,
      key: item.key,
      newName: name,
      type: item.type,
    });
    if (!res.ok) {
      ui.mkdirMsg.textContent = res.error || "重命名失败";
      ui.mkdirMsg.className = "msg err";
      return;
    }
    closeMkdirDialog();
    state.selected.clear();
    await refreshList();
    setStatus("已重命名为 " + name);
    return;
  }

  const prefix = (state.prefix || "") + name + "/";
  ui.mkdirMsg.textContent = "正在创建…";
  ui.mkdirMsg.className = "msg";
  const res = await api.mkdir({ connId: state.connId, bucket: state.bucket, prefix });
  if (!res.ok) {
    ui.mkdirMsg.textContent = res.error || "创建失败";
    ui.mkdirMsg.className = "msg err";
    return;
  }
  closeMkdirDialog();
  await refreshList();
  setStatus("已创建文件夹 " + name);
}

async function doMkdir() {
  openMkdirDialog();
}

function bindDragDrop() {
  let dragDepth = 0;
  ui.browser.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (!state.connId || !state.bucket) return;
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
    if (!state.connId || !state.bucket) return;
    const files = [...(e.dataTransfer.files || [])];
    const paths = files.map((f) => api.getPathForFile(f)).filter(Boolean);
    if (!paths.length) {
      alert("未能获取本地路径。请使用「上传」按钮选择文件或文件夹。");
      return;
    }
    await doUpload(paths);
  });
}

function bind() {
  document.getElementById("btn-add").onclick = () => openDialog(null);
  document.getElementById("btn-refresh").onclick = () => refreshList();
  document.getElementById("btn-up").onclick = () => {
    if (!state.prefix) return;
    const parts = state.prefix.split("/").filter(Boolean);
    parts.pop();
    state.prefix = parts.length ? parts.join("/") + "/" : "";
    refreshList();
  };
  document.getElementById("btn-mkdir").onclick = doMkdir;
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
  ui.ctxMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    const item = ctxTarget;
    hideContextMenu();
    if (action === "copy-url") await copyAccessUrl(item);
    else if (action === "rename") openRenameDialog(item);
    else if (action === "download") await doDownload();
    else if (action === "delete") await doDelete();
  });
  document.addEventListener("click", (e) => {
    if (!ui.ctxMenu.classList.contains("hidden") && !ui.ctxMenu.contains(e.target)) {
      hideContextMenu();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("resize", hideContextMenu);
  ui.browser.addEventListener("scroll", hideContextMenu, true);
  ui.bucket.onchange = () => {
    state.bucket = ui.bucket.value;
    state.prefix = "";
    refreshList();
  };
  ui.checkAll.onchange = () => {
    state.selected.clear();
    if (ui.checkAll.checked) {
      [...state.folders, ...state.files].forEach((it) => state.selected.add(selKey(it)));
    }
    paintRows();
    refreshToolbar();
  };
  document.getElementById("f-provider").onchange = () => applyProviderDefaults(true);
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
    const extra =
      p.fileTotal && p.fileLoaded != null
        ? "（当前 " + formatSize(p.fileLoaded) + " / " + formatSize(p.fileTotal) + "）"
        : "";
    ui.progress.textContent =
      (p.phase === "upload" ? "上传" : "下载") +
      " " +
      (p.name || "") +
      "  " +
      (p.loaded || 0) +
      "/" +
      (p.total || 0) +
      extra;
  });
  bindDragDrop();
}

async function init() {
  state.providers = await api.providers();
  bind();
  await reloadConnections();
  refreshToolbar();
}

init();
