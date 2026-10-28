const api = window.httpapi;

const state = {
  list: [],
  id: null,
  sending: false,
  lastBody: "",
};

function emptyKv() {
  return { enabled: true, key: "", value: "" };
}

function kvFrom(list) {
  const rows = Array.isArray(list) ? list.map((x) => ({
    enabled: x.enabled !== false,
    key: x.key || "",
    value: x.value || "",
  })) : [];
  if (!rows.length || rows[rows.length - 1].key) rows.push(emptyKv());
  return rows;
}

const form = {
  name: "",
  method: "GET",
  url: "",
  params: [emptyKv()],
  headers: [emptyKv()],
  bodyType: "none",
  body: "",
  authType: "none",
  authToken: "",
  authUser: "",
  authPass: "",
  insecure: false,
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  $("status-text").textContent = text || "";
}

function paintList() {
  const box = $("req-list");
  box.replaceChildren();
  if (!state.list.length) {
    const tip = document.createElement("div");
    tip.style.cssText = "padding:12px;color:#888;font-size:12px;line-height:1.5";
    tip.textContent = "暂无保存的请求。编辑右侧后点「保存」，或点 + 新建。";
    box.appendChild(tip);
    return;
  }
  state.list.forEach((r) => {
    const el = document.createElement("div");
    el.className = "req-item" + (r.id === state.id ? " active" : "");
    el.innerHTML =
      '<span class="method-tag"></span><div class="meta"><div class="name"></div><div class="sub"></div></div>' +
      '<div class="ops"><button type="button" data-act="rename" title="改标题">✎</button>' +
      '<button type="button" data-act="del" title="删除">×</button></div>';
    el.querySelector(".method-tag").textContent = r.method;
    el.querySelector(".method-tag").classList.add(r.method);
    el.querySelector(".name").textContent = r.name;
    el.querySelector(".sub").textContent = r.url || "";
    el.addEventListener("click", (e) => {
      if (e.target.closest(".ops") || e.target.closest("input.rename")) return;
      loadSaved(r.id);
    });
    el.querySelector(".name").ondblclick = (e) => {
      e.stopPropagation();
      startRename(el, r);
    };
    el.querySelector('[data-act="rename"]').onclick = (e) => {
      e.stopPropagation();
      startRename(el, r);
    };
    el.querySelector('[data-act="del"]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("删除请求「" + r.name + "」？")) return;
      await api.remove(r.id);
      if (state.id === r.id) {
        state.id = null;
        resetForm();
      }
      await reloadList();
    };
    box.appendChild(el);
  });
}

function paintKv(tbodyId, rows) {
  const tbody = $(tbodyId);
  tbody.replaceChildren();
  rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td class="col-on"><input type="checkbox" /></td>' +
      '<td><input type="text" data-f="key" /></td>' +
      '<td><input type="text" data-f="value" /></td>' +
      '<td class="col-del"><button class="del" type="button">×</button></td>';
    const on = tr.querySelector('input[type="checkbox"]');
    on.checked = row.enabled !== false;
    on.onchange = () => {
      rows[i].enabled = on.checked;
    };
    tr.querySelector('[data-f="key"]').value = row.key;
    tr.querySelector('[data-f="value"]').value = row.value;
    tr.querySelector('[data-f="key"]').oninput = (e) => {
      rows[i].key = e.target.value;
      ensureTrailing(rows, tbodyId);
    };
    tr.querySelector('[data-f="value"]').oninput = (e) => {
      rows[i].value = e.target.value;
    };
    tr.querySelector(".del").onclick = () => {
      if (rows.length <= 1) {
        rows[0] = emptyKv();
      } else {
        rows.splice(i, 1);
      }
      paintKv(tbodyId, rows);
    };
    tbody.appendChild(tr);
  });
}

function ensureTrailing(rows, tbodyId) {
  if (!rows.length || rows[rows.length - 1].key) {
    rows.push(emptyKv());
    paintKv(tbodyId, rows);
  }
}

function startRename(el, r) {
  const meta = el.querySelector(".meta");
  const nameEl = el.querySelector(".name");
  if (!meta || el.querySelector("input.rename")) return;
  nameEl.classList.add("editing");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename";
  input.maxLength = 80;
  input.value = r.name || "";
  meta.insertBefore(input, nameEl);
  input.focus();
  input.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    input.remove();
    nameEl.classList.remove("editing");
    if (!ok || !title || title === r.name) return;
    const res = await api.rename({ id: r.id, name: title });
    if (!res.ok) {
      setStatus(res.error || "改名失败");
      return;
    }
    if (state.id === r.id) {
      form.name = title;
      $("req-name").value = title;
    }
    await reloadList();
    setStatus("已更新标题");
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

function applyFormToUi() {
  $("req-name").value = form.name;
  $("method").value = form.method;
  $("url").value = form.url;
  $("insecure").checked = form.insecure;
  $("body").value = form.body;
  $("auth-type").value = form.authType;
  $("auth-token").value = form.authToken;
  $("auth-user").value = form.authUser;
  $("auth-pass").value = form.authPass;
  document.querySelectorAll('input[name="body-type"]').forEach((el) => {
    el.checked = el.value === form.bodyType;
  });
  paintKv("params-body", form.params);
  paintKv("headers-body", form.headers);
  toggleAuth();
  toggleBody();
}

function readForm() {
  form.name = $("req-name").value.trim();
  form.method = $("method").value;
  form.url = $("url").value.trim();
  form.insecure = $("insecure").checked;
  form.body = $("body").value;
  form.authType = $("auth-type").value;
  form.authToken = $("auth-token").value;
  form.authUser = $("auth-user").value;
  form.authPass = $("auth-pass").value;
  const bt = document.querySelector('input[name="body-type"]:checked');
  form.bodyType = bt ? bt.value : "none";
}

function payload() {
  readForm();
  return {
    id: state.id || undefined,
    name: form.name || guessName(),
    method: form.method,
    url: form.url,
    params: form.params.filter((p) => p.key || p.value),
    headers: form.headers.filter((p) => p.key || p.value),
    bodyType: form.bodyType,
    body: form.body,
    authType: form.authType,
    authToken: form.authToken,
    authUser: form.authUser,
    authPass: form.authPass,
    insecure: form.insecure,
  };
}

function guessName() {
  try {
    const u = new URL(/^https?:/i.test(form.url) ? form.url : "http://" + form.url);
    return form.method + " " + u.host + u.pathname;
  } catch {
    return form.method + " 请求";
  }
}

function resetForm() {
  form.name = "";
  form.method = "GET";
  form.url = "";
  form.params = [emptyKv()];
  form.headers = [emptyKv()];
  form.bodyType = "none";
  form.body = "";
  form.authType = "none";
  form.authToken = "";
  form.authUser = "";
  form.authPass = "";
  form.insecure = false;
  applyFormToUi();
  clearResponse();
}

function clearResponse() {
  state.lastBody = "";
  $("resp-body").textContent = "";
  $("resp-headers").replaceChildren();
  $("resp-meta").textContent = "";
  $("resp-meta").className = "";
  $("btn-copy-body").disabled = true;
  $("btn-pretty").disabled = true;
}

async function reloadList() {
  state.list = await api.list();
  paintList();
}

async function loadSaved(id) {
  const r = await api.get(id);
  if (!r) return;
  state.id = r.id;
  form.name = r.name || "";
  form.method = r.method || "GET";
  form.url = r.url || "";
  form.params = kvFrom(r.params);
  form.headers = kvFrom(r.headers);
  form.bodyType = r.bodyType || "none";
  form.body = r.body || "";
  form.authType = r.authType || "none";
  form.authToken = r.authToken || "";
  form.authUser = r.authUser || "";
  form.authPass = r.authPass || "";
  form.insecure = Boolean(r.insecure);
  applyFormToUi();
  paintList();
  setStatus("");
}

function toggleAuth() {
  const t = $("auth-type").value;
  $("auth-token-row").classList.toggle("hidden", t !== "bearer");
  $("auth-user-row").classList.toggle("hidden", t !== "basic");
  $("auth-pass-row").classList.toggle("hidden", t !== "basic");
}

function toggleBody() {
  const t = document.querySelector('input[name="body-type"]:checked');
  $("body").disabled = !t || t.value === "none";
}

function setReqTab(id) {
  document.querySelectorAll("#req-tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== id));
}

function setRespTab(id) {
  document.querySelectorAll("#resp-tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.rtab === id));
  $("resp-body").classList.toggle("hidden", id !== "body");
  $("resp-headers").classList.toggle("hidden", id !== "headers");
}

function showResponse(res) {
  if (!res.ok) {
    $("resp-meta").textContent = res.error || "失败";
    $("resp-meta").className = "err";
    $("resp-body").textContent = res.error || "";
    state.lastBody = "";
    $("btn-copy-body").disabled = true;
    $("btn-pretty").disabled = true;
    return;
  }
  const cls = res.status >= 200 && res.status < 400 ? "ok" : "err";
  $("resp-meta").className = cls;
  $("resp-meta").textContent =
    res.status +
    " " +
    (res.statusText || "") +
    " · " +
    res.time +
    " ms · " +
    formatSize(res.size) +
    (res.truncated ? "（已截断）" : "");
  state.lastBody = res.body || "";
  $("resp-body").textContent = state.lastBody;
  $("btn-copy-body").disabled = !state.lastBody;
  $("btn-pretty").disabled = !state.lastBody;
  const box = $("resp-headers");
  box.replaceChildren();
  (res.headers || []).forEach((h) => {
    const row = document.createElement("div");
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = h.key;
    const v = document.createElement("span");
    v.textContent = h.value;
    row.append(k, v);
    box.appendChild(row);
  });
}

function formatSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

async function doSend() {
  if (state.sending) {
    await api.abort();
    state.sending = false;
    $("btn-send").textContent = "发送";
    setStatus("已取消");
    return;
  }
  readForm();
  if (!form.url) {
    setStatus("请填写 URL");
    return;
  }
  state.sending = true;
  $("btn-send").textContent = "取消";
  setStatus("发送中…");
  const res = await api.send(payload());
  state.sending = false;
  $("btn-send").textContent = "发送";
  if (!res.ok) setStatus(res.error || "失败");
  else setStatus("完成");
  showResponse(res);
  setRespTab("body");
}

async function doSave() {
  const saved = await api.save(payload());
  state.id = saved.id;
  $("req-name").value = saved.name;
  form.name = saved.name;
  await reloadList();
  setStatus("已保存");
}

function prettyJson() {
  if (!state.lastBody) return;
  try {
    $("resp-body").textContent = JSON.stringify(JSON.parse(state.lastBody), null, 2);
  } catch {
    setStatus("不是有效 JSON");
  }
}

function bind() {
  $("btn-new").onclick = () => {
    state.id = null;
    resetForm();
    paintList();
    $("req-name").focus();
  };
  $("req-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSave();
    }
  });
  $("btn-send").onclick = doSend;
  $("btn-save").onclick = doSave;
  $("btn-copy-body").onclick = async () => {
    await api.copy($("resp-body").textContent || state.lastBody);
    setStatus("已复制正文");
  };
  $("btn-pretty").onclick = prettyJson;
  $("auth-type").onchange = toggleAuth;
  document.querySelectorAll('input[name="body-type"]').forEach((el) => {
    el.onchange = toggleBody;
  });
  document.querySelectorAll("#req-tabs .tab").forEach((b) => {
    b.onclick = () => setReqTab(b.dataset.tab);
  });
  document.querySelectorAll("#resp-tabs .tab").forEach((b) => {
    b.onclick = () => setRespTab(b.dataset.rtab);
  });
  $("url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSend();
    }
  });
}

async function init() {
  bind();
  applyFormToUi();
  await reloadList();
}

init();
