const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { BrowserWindow, ipcMain, clipboard } = require("electron");

const MAX_BODY = 2 * 1024 * 1024;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

let settingsPath = "";
let httpWin = null;
let seq = 0;
/** @type {(() => import("electron").BrowserWindow | null) | null} */
let getMainWindow = null;
/** @type {import("http").ClientRequest | null} */
let inflight = null;

function requestsFile() {
  return path.join(settingsPath, "http-requests.json");
}

function loadRequests() {
  try {
    const raw = fs.readFileSync(requestsFile(), "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.requests)) return data.requests;
  } catch {
    /* empty */
  }
  return [];
}

function saveRequests(list) {
  fs.mkdirSync(settingsPath, { recursive: true });
  fs.writeFileSync(requestsFile(), JSON.stringify({ requests: list }, null, 2), "utf8");
}

function publicRequest(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name || "未命名请求",
    method: METHODS.includes(r.method) ? r.method : "GET",
    url: r.url || "",
    params: Array.isArray(r.params) ? r.params : [],
    headers: Array.isArray(r.headers) ? r.headers : [],
    bodyType: r.bodyType || "none",
    body: r.body || "",
    authType: r.authType || "none",
    authToken: r.authToken || "",
    authUser: r.authUser || "",
    authPass: r.authPass ? "********" : "",
    hasPass: Boolean(r.authPass),
    insecure: Boolean(r.insecure),
  };
}

function getRequest(id) {
  return loadRequests().find((r) => r.id === id) || null;
}

function kvEnabled(list) {
  return (list || []).filter((x) => x && x.enabled !== false && String(x.key || "").trim());
}

function applyParamsToUrl(rawUrl, params) {
  const text = String(rawUrl || "").trim();
  if (!text) throw new Error("请填写 URL");
  const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : "http://" + text;
  let u;
  try {
    u = new URL(withProto);
  } catch {
    throw new Error("URL 无效");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("只支持 http 和 https");
  }
  const enabled = kvEnabled(params);
  if (enabled.length) {
    u.search = "";
    enabled.forEach((p) => u.searchParams.append(String(p.key).trim(), String(p.value || "")));
  }
  return u;
}

function buildHeaders(payload, hasBody) {
  const headers = {};
  kvEnabled(payload.headers).forEach((h) => {
    headers[String(h.key).trim()] = String(h.value || "");
  });
  const authType = payload.authType || "none";
  if (authType === "bearer" && payload.authToken && !headerHas(headers, "Authorization")) {
    headers.Authorization = "Bearer " + String(payload.authToken).trim();
  }
  if (authType === "basic" && payload.authUser != null && !headerHas(headers, "Authorization")) {
    const pass = String(payload.authPass || "");
    headers.Authorization = "Basic " + Buffer.from(String(payload.authUser) + ":" + pass).toString("base64");
  }
  const bodyType = payload.bodyType || "none";
  if (hasBody && !headerHas(headers, "Content-Type")) {
    if (bodyType === "json") headers["Content-Type"] = "application/json";
    else if (bodyType === "form") headers["Content-Type"] = "application/x-www-form-urlencoded";
    else if (bodyType === "text") headers["Content-Type"] = "text/plain; charset=utf-8";
  }
  return headers;
}

function headerHas(headers, name) {
  const want = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === want);
}

function encodeBody(payload) {
  const type = payload.bodyType || "none";
  if (type === "none" || payload.method === "GET" || payload.method === "HEAD") return null;
  if (type === "form") {
    const u = new URLSearchParams();
    String(payload.body || "")
      .split("\n")
      .forEach((line) => {
        const s = line.trim();
        if (!s) return;
        const i = s.indexOf("=");
        if (i < 0) u.append(s, "");
        else u.append(s.slice(0, i).trim(), s.slice(i + 1));
      });
    return u.toString();
  }
  return payload.body ? String(payload.body) : null;
}

function sendOnce(targetUrl, method, headers, body, insecure) {
  return new Promise((resolve, reject) => {
    const lib = targetUrl.protocol === "https:" ? https : http;
    const opts = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers,
      timeout: 30000,
    };
    if (targetUrl.protocol === "https:") {
      opts.rejectUnauthorized = !insecure;
    }
    const req = lib.request(opts, (res) => {
      const chunks = [];
      let total = 0;
      let truncated = false;
      res.on("data", (c) => {
        total += c.length;
        if (chunks.length && total > MAX_BODY) {
          truncated = true;
          return;
        }
        if (total > MAX_BODY) {
          truncated = true;
          chunks.push(c.subarray(0, Math.max(0, MAX_BODY - (total - c.length))));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        inflight = null;
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage || "",
          headers: res.headers,
          buffer: Buffer.concat(chunks),
          truncated,
          location: res.headers.location,
        });
      });
    });
    inflight = req;
    req.on("error", (err) => {
      inflight = null;
      reject(err);
    });
    req.on("timeout", () => {
      req.destroy(new Error("请求超时"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function sendHttp(payload) {
  const method = METHODS.includes(payload.method) ? payload.method : "GET";
  let current = applyParamsToUrl(payload.url, payload.params);
  let body = encodeBody({ ...payload, method });
  const insecure = Boolean(payload.insecure);
  const started = Date.now();
  let hops = 0;
  let sendMethod = method;
  let sendBody = body;

  while (hops < 6) {
    const headers = buildHeaders(payload, Boolean(sendBody));
    if (sendBody) {
      headers["Content-Length"] = Buffer.byteLength(sendBody);
    }
    const res = await sendOnce(current, sendMethod, headers, sendBody, insecure);
    const code = res.status;
    const loc = res.location;
    const redirect = loc && [301, 302, 303, 307, 308].includes(code);
    if (!redirect || hops >= 5) {
      const text = res.buffer.toString("utf8");
      return {
        ok: true,
        status: code,
        statusText: res.statusText,
        headers: flattenHeaders(res.headers),
        body: text,
        truncated: res.truncated,
        time: Date.now() - started,
        size: res.buffer.length,
        url: current.toString(),
      };
    }
    hops += 1;
    current = new URL(loc, current);
    if (code === 303 || ((code === 301 || code === 302) && sendMethod !== "GET" && sendMethod !== "HEAD")) {
      sendMethod = "GET";
      sendBody = null;
    }
  }
  throw new Error("重定向次数过多");
}

function flattenHeaders(headers) {
  const out = [];
  Object.keys(headers || {}).forEach((k) => {
    const v = headers[k];
    if (Array.isArray(v)) v.forEach((item) => out.push({ key: k, value: String(item) }));
    else if (v != null) out.push({ key: k, value: String(v) });
  });
  return out;
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || "请求失败");
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return "无法解析主机名";
  if (/ECONNREFUSED/i.test(msg)) return "连接被拒绝";
  if (/ETIMEDOUT|timeout|超时/i.test(msg)) return "请求超时";
  if (/CERT|unable to verify/i.test(msg)) return "证书校验失败，可勾选「忽略证书错误」后重试";
  return msg;
}

function createHttpWindow() {
  if (httpWin && !httpWin.isDestroyed()) {
    if (httpWin.isMinimized()) httpWin.restore();
    httpWin.show();
    httpWin.focus();
    return httpWin;
  }
  const parent = typeof getMainWindow === "function" ? getMainWindow() : null;
  const parentOk = parent && !parent.isDestroyed();
  const iconPath = path.join(__dirname, "..", "..", "build", "icon.ico");
  httpWin = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 540,
    title: "HTTP 请求 - EditLong",
    backgroundColor: "#f3f3f3",
    show: false,
    parent: parentOk ? parent : undefined,
    modal: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload-http.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  httpWin.once("ready-to-show", () => httpWin.show());
  httpWin.loadFile(path.join(__dirname, "..", "renderer", "http.html"));
  httpWin.on("closed", () => {
    httpWin = null;
    if (inflight) {
      try {
        inflight.destroy();
      } catch {
        /* ignore */
      }
      inflight = null;
    }
  });
  return httpWin;
}

function closeHttpWindow() {
  if (httpWin && !httpWin.isDestroyed()) httpWin.close();
  httpWin = null;
}

function registerHttp(app, opts = {}) {
  settingsPath = app.getPath("userData");
  getMainWindow = typeof opts.getMainWindow === "function" ? opts.getMainWindow : null;

  ipcMain.handle("http:list", () => loadRequests().map(publicRequest));
  ipcMain.handle("http:get", (_e, id) => {
    const r = getRequest(id);
    if (!r) return null;
    return { ...publicRequest(r), authPass: r.authPass || "" };
  });
  ipcMain.handle("http:save", (_e, payload) => {
    const list = loadRequests();
    let item = list.find((r) => r.id === payload.id);
    const keepPass = payload.authPass === "********" || payload.authPass == null;
    const next = {
      name: String(payload.name || "未命名请求").trim(),
      method: METHODS.includes(payload.method) ? payload.method : "GET",
      url: String(payload.url || "").trim(),
      params: Array.isArray(payload.params) ? payload.params : [],
      headers: Array.isArray(payload.headers) ? payload.headers : [],
      bodyType: payload.bodyType || "none",
      body: String(payload.body || ""),
      authType: payload.authType || "none",
      authToken: String(payload.authToken || ""),
      authUser: String(payload.authUser || ""),
      insecure: Boolean(payload.insecure),
    };
    if (item) {
      Object.assign(item, next);
      if (!keepPass) item.authPass = String(payload.authPass || "");
    } else {
      item = {
        id: "h" + Date.now() + "-" + ++seq,
        authPass: keepPass ? "" : String(payload.authPass || ""),
        ...next,
      };
      list.push(item);
    }
    saveRequests(list);
    return publicRequest(item);
  });
  ipcMain.handle("http:rename", (_e, { id, name }) => {
    const list = loadRequests();
    const item = list.find((r) => r.id === id);
    if (!item) return { ok: false, error: "请求不存在" };
    const title = String(name || "").trim();
    if (!title) return { ok: false, error: "标题不能为空" };
    item.name = title;
    saveRequests(list);
    return { ok: true, request: publicRequest(item) };
  });
  ipcMain.handle("http:delete", (_e, id) => {
    saveRequests(loadRequests().filter((r) => r.id !== id));
    return { ok: true };
  });
  ipcMain.handle("http:send", async (_e, payload) => {
    try {
      return await sendHttp(payload || {});
    } catch (err) {
      return { ok: false, error: friendlyError(err), time: 0 };
    }
  });
  ipcMain.handle("http:abort", () => {
    if (inflight) {
      try {
        inflight.destroy(new Error("已取消"));
      } catch {
        /* ignore */
      }
      inflight = null;
    }
    return { ok: true };
  });
  ipcMain.handle("http:copy", (_e, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });
  ipcMain.handle("http:open-window", () => {
    createHttpWindow();
    return true;
  });

  return { open: createHttpWindow, close: closeHttpWindow };
}

module.exports = { registerHttp, createHttpWindow, closeHttpWindow };
