const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { BrowserWindow, ipcMain, dialog, shell, clipboard } = require("electron");
const { Client } = require("ssh2");

let settingsPath = "";
let sshWin = null;
let seq = 0;
/** @type {(() => import("electron").BrowserWindow | null) | null} */
let getMainWindow = null;

/** @type {Map<string, { client: import("ssh2").Client, sftp: import("ssh2").SFTPWrapper, shell: import("ssh2").ClientChannel | null, cwd: string }>} */
const sessions = new Map();

function connectionsFile() {
  return path.join(settingsPath, "ssh-connections.json");
}

function loadConnections() {
  try {
    const raw = fs.readFileSync(connectionsFile(), "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.connections)) return data.connections;
  } catch {
    /* empty */
  }
  return [];
}

function saveConnections(list) {
  fs.mkdirSync(settingsPath, { recursive: true });
  fs.writeFileSync(connectionsFile(), JSON.stringify({ connections: list }, null, 2), "utf8");
}

function publicConnection(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    host: c.host || "",
    port: Number(c.port) || 22,
    username: c.username || "",
    auth: c.auth === "key" ? "key" : "password",
    hasPassword: Boolean(c.password),
    hasPassphrase: Boolean(c.passphrase),
    privateKeyPath: c.privateKeyPath || "",
    connected: sessions.has(c.id),
  };
}

function getConnection(id) {
  return loadConnections().find((c) => c.id === id) || null;
}

function uniqueCopyName(list, name) {
  const base = String(name || "未命名主机").replace(/\s*副本(\s*\d+)?$/, "") + " 副本";
  const names = new Set(list.map((c) => c.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(base + " " + n)) n += 1;
  return base + " " + n;
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || "未知错误");
  if (/authentication methods failed|All configured authentication/i.test(msg)) {
    return "认证失败，请检查用户名、密码或私钥";
  }
  if (/timed out|Timeout/i.test(msg)) return "连接超时";
  if (/ECONNREFUSED/i.test(msg)) return "连接被拒绝，请检查主机与端口";
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return "无法解析主机名";
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) return "网络不可达";
  if (/passphrase/i.test(msg)) return "私钥口令不正确";
  if (/Encrypted private key/i.test(msg)) return "私钥已加密，请填写口令";
  if (/Cannot parse privateKey/i.test(msg)) return "无法解析私钥文件";
  return msg;
}

function joinRemote(base, name) {
  const b = String(base || "/").replace(/\/+$/, "") || "";
  const n = String(name || "").replace(/^\/+/, "");
  if (!n) return b || "/";
  if (!b || b === "/") return "/" + n;
  return b + "/" + n;
}

function parentRemote(p) {
  const s = String(p || "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  if (i <= 0) return "/";
  return s.slice(0, i);
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

function isDirAttrs(attrs) {
  return Boolean(attrs && (attrs.mode & 0o170000) === 0o040000);
}

function requireSession(id) {
  const s = sessions.get(id);
  if (!s || !s.sftp) throw new Error("尚未连接");
  return s;
}

function buildConnectOpts(conf) {
  const opts = {
    host: String(conf.host || "").trim(),
    port: Number(conf.port) || 22,
    username: String(conf.username || "").trim(),
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    tryKeyboard: true,
  };
  if (!opts.host) throw new Error("请填写主机");
  if (!opts.username) throw new Error("请填写用户名");
  if (conf.auth === "key") {
    const keyPath = String(conf.privateKeyPath || "").trim();
    if (!keyPath) throw new Error("请选择私钥文件");
    if (!fs.existsSync(keyPath)) throw new Error("私钥文件不存在");
    opts.privateKey = fs.readFileSync(keyPath);
    if (conf.passphrase) opts.passphrase = String(conf.passphrase);
  } else {
    opts.password = String(conf.password || "");
  }
  return opts;
}

function sendToWin(channel, payload) {
  if (sshWin && !sshWin.isDestroyed()) {
    sshWin.webContents.send(channel, payload);
  }
}

function destroySession(id) {
  const s = sessions.get(id);
  sessions.delete(id);
  if (!s) return;
  try {
    if (s.shell) s.shell.end();
  } catch {
    /* ignore */
  }
  try {
    s.client.end();
  } catch {
    /* ignore */
  }
}

function connectSession(id) {
  const conf = getConnection(id);
  if (!conf) return Promise.reject(new Error("连接不存在"));
  if (sessions.has(id)) {
    return Promise.resolve({ ok: true, cwd: sessions.get(id).cwd, reused: true });
  }
  const opts = buildConnectOpts(conf);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    client.on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
      const answers = (prompts || []).map((p) => (p.echo === false ? String(conf.password || "") : ""));
      finish(answers);
    });
    client.on("ready", () => {
      client.sftp((err, sftp) => {
        if (err) return fail(err);
        const finishReady = (cwd) => {
          if (settled) return;
          settled = true;
          sessions.set(id, { client, sftp, shell: null, cwd: cwd || "/" });
          client.on("close", () => {
            sessions.delete(id);
            sendToWin("ssh:disconnected", { connId: id });
          });
          resolve({ ok: true, cwd: cwd || "/" });
        };
        sftp.realpath(".", (e2, abs) => {
          if (e2) finishReady("/");
          else finishReady(abs || "/");
        });
      });
    });
    client.on("error", fail);
    try {
      client.connect(opts);
    } catch (err) {
      fail(err);
    }
  });
}

function listDir(sftp, remotePath) {
  return sftpCall(sftp, "readdir", remotePath).then((list) => {
    const folders = [];
    const files = [];
    for (const entry of list || []) {
      const name = entry.filename;
      if (!name || name === "." || name === "..") continue;
      const item = {
        name,
        path: joinRemote(remotePath, name),
        size: entry.attrs && entry.attrs.size != null ? entry.attrs.size : 0,
        mtime: entry.attrs && entry.attrs.mtime ? entry.attrs.mtime * 1000 : 0,
        type: isDirAttrs(entry.attrs) ? "folder" : "file",
      };
      if (item.type === "folder") folders.push(item);
      else files.push(item);
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return { path: remotePath, folders, files };
  });
}

async function rmdirRecursive(sftp, remotePath) {
  const list = await sftpCall(sftp, "readdir", remotePath);
  for (const entry of list || []) {
    const name = entry.filename;
    if (!name || name === "." || name === "..") continue;
    const full = joinRemote(remotePath, name);
    if (isDirAttrs(entry.attrs)) await rmdirRecursive(sftp, full);
    else await sftpCall(sftp, "unlink", full);
  }
  await sftpCall(sftp, "rmdir", remotePath);
}

async function collectRemoteFiles(sftp, remotePath, relBase) {
  const out = [];
  const list = await sftpCall(sftp, "readdir", remotePath);
  for (const entry of list || []) {
    const name = entry.filename;
    if (!name || name === "." || name === "..") continue;
    const full = joinRemote(remotePath, name);
    const rel = relBase ? relBase + "/" + name : name;
    if (isDirAttrs(entry.attrs)) {
      const nested = await collectRemoteFiles(sftp, full, rel);
      out.push(...nested);
    } else {
      out.push({ remotePath: full, relative: rel, name });
    }
  }
  return out;
}

async function walkLocalDir(dir) {
  const out = [];
  async function walk(current, rel) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      const r = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) await walk(full, r);
      else if (ent.isFile()) out.push({ localPath: full, relative: r.replace(/\\/g, "/") });
    }
  }
  await walk(dir, "");
  return out;
}

function openShell(id, cols, rows) {
  const s = requireSession(id);
  if (s.shell) {
    try {
      s.shell.setWindow(rows || 24, cols || 80, 0, 0);
    } catch {
      /* ignore */
    }
    return Promise.resolve({ ok: true, reused: true });
  }
  return new Promise((resolve, reject) => {
    s.client.shell({ term: "xterm-256color", cols: cols || 80, rows: rows || 24 }, (err, stream) => {
      if (err) return reject(err);
      s.shell = stream;
      stream.on("data", (chunk) => {
        sendToWin("ssh:term-data", {
          connId: id,
          data: Buffer.from(chunk).toString("base64"),
        });
      });
      stream.on("close", () => {
        s.shell = null;
        sendToWin("ssh:term-exit", { connId: id });
      });
      resolve({ ok: true });
    });
  });
}

function createSshWindow() {
  if (sshWin && !sshWin.isDestroyed()) {
    if (sshWin.isMinimized()) sshWin.restore();
    sshWin.show();
    sshWin.focus();
    return sshWin;
  }
  const parent = typeof getMainWindow === "function" ? getMainWindow() : null;
  const parentOk = parent && !parent.isDestroyed();
  const iconPath = path.join(__dirname, "..", "..", "build", "icon.ico");
  sshWin = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: "远程连接 SSH/SFTP - EditLong",
    backgroundColor: "#f3f3f3",
    show: false,
    parent: parentOk ? parent : undefined,
    modal: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload-ssh.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  sshWin.once("ready-to-show", () => sshWin.show());
  sshWin.loadFile(path.join(__dirname, "..", "renderer", "ssh.html"));
  sshWin.on("closed", () => {
    sshWin = null;
    for (const id of [...sessions.keys()]) destroySession(id);
  });
  return sshWin;
}

function closeSshWindow() {
  if (sshWin && !sshWin.isDestroyed()) sshWin.close();
  sshWin = null;
  for (const id of [...sessions.keys()]) destroySession(id);
}

function registerSsh(app, opts = {}) {
  settingsPath = app.getPath("userData");
  getMainWindow = typeof opts.getMainWindow === "function" ? opts.getMainWindow : null;

  ipcMain.handle("ssh:list-connections", () => loadConnections().map(publicConnection));
  ipcMain.handle("ssh:get-connection", (_e, id) => {
    const c = getConnection(id);
    if (!c) return null;
    return {
      ...publicConnection(c),
      password: c.password ? "********" : "",
      passphrase: c.passphrase ? "********" : "",
    };
  });
  ipcMain.handle("ssh:save-connection", (_e, payload) => {
    const list = loadConnections();
    let item = list.find((c) => c.id === payload.id);
    const keepPassword = payload.password === "********" || payload.password == null;
    const keepPassphrase = payload.passphrase === "********" || payload.passphrase == null;
    const next = {
      name: String(payload.name || "未命名主机").trim(),
      host: String(payload.host || "").trim(),
      port: Number(payload.port) || 22,
      username: String(payload.username || "").trim(),
      auth: payload.auth === "key" ? "key" : "password",
      privateKeyPath: String(payload.privateKeyPath || "").trim(),
    };
    if (item) {
      Object.assign(item, next);
      if (!keepPassword) item.password = String(payload.password || "");
      if (!keepPassphrase) item.passphrase = String(payload.passphrase || "");
    } else {
      item = {
        id: "s" + Date.now() + "-" + ++seq,
        password: keepPassword ? "" : String(payload.password || ""),
        passphrase: keepPassphrase ? "" : String(payload.passphrase || ""),
        ...next,
      };
      list.push(item);
    }
    saveConnections(list);
    return publicConnection(item);
  });
  ipcMain.handle("ssh:duplicate-connection", (_e, id) => {
    const list = loadConnections();
    const src = list.find((c) => c.id === id);
    if (!src) return { ok: false, error: "连接不存在" };
    const copy = {
      ...JSON.parse(JSON.stringify(src)),
      id: "s" + Date.now() + "-" + ++seq,
      name: uniqueCopyName(list, src.name),
    };
    const idx = list.findIndex((c) => c.id === id);
    list.splice(idx < 0 ? list.length : idx + 1, 0, copy);
    saveConnections(list);
    return { ok: true, connection: publicConnection(copy) };
  });
  ipcMain.handle("ssh:reorder-connections", (_e, ids) => {
    const list = loadConnections();
    const map = new Map(list.map((c) => [c.id, c]));
    const ordered = [];
    (ids || []).forEach((id) => {
      if (map.has(id)) {
        ordered.push(map.get(id));
        map.delete(id);
      }
    });
    map.forEach((c) => ordered.push(c));
    saveConnections(ordered);
    return { ok: true };
  });
  ipcMain.handle("ssh:delete-connection", (_e, id) => {
    destroySession(id);
    saveConnections(loadConnections().filter((c) => c.id !== id));
    return { ok: true };
  });
  ipcMain.handle("ssh:pick-key", async () => {
    const win = sshWin || BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: "选择私钥文件",
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: true, cancelled: true };
    return { ok: true, path: result.filePaths[0] };
  });
  ipcMain.handle("ssh:connect", async (_e, id) => {
    try {
      const data = await connectSession(id);
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });
  ipcMain.handle("ssh:disconnect", (_e, id) => {
    destroySession(id);
    sendToWin("ssh:disconnected", { connId: id });
    return { ok: true };
  });
  ipcMain.handle("ssh:test-connection", async (_e, id) => {
    const existed = sessions.has(id);
    try {
      const data = await connectSession(id);
      if (!existed) destroySession(id);
      return { ok: true, cwd: data.cwd };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });
  ipcMain.handle("ssh:list", async (_e, { connId, remotePath }) => {
    try {
      const s = requireSession(connId);
      const target = String(remotePath || s.cwd || "/");
      const data = await listDir(s.sftp, target);
      s.cwd = data.path;
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });
  ipcMain.handle("ssh:mkdir", async (_e, { connId, remotePath }) => {
    try {
      const s = requireSession(connId);
      await sftpCall(s.sftp, "mkdir", remotePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });
  ipcMain.handle("ssh:rename", async (_e, { connId, fromPath, toPath }) => {
    try {
      const s = requireSession(connId);
      await sftpCall(s.sftp, "rename", fromPath, toPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });
  ipcMain.handle("ssh:delete", async (_e, { connId, items }) => {
    try {
      const s = requireSession(connId);
      for (const item of items || []) {
        if (item.type === "folder") await rmdirRecursive(s.sftp, item.path);
        else await sftpCall(s.sftp, "unlink", item.path);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });
  ipcMain.handle("ssh:term-open", async (_e, { connId, cols, rows }) => {
    try {
      await connectSession(connId);
      await openShell(connId, cols, rows);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });
  ipcMain.handle("ssh:term-resize", (_e, { connId, cols, rows }) => {
    const s = sessions.get(connId);
    if (s && s.shell) {
      try {
        s.shell.setWindow(rows || 24, cols || 80, 0, 0);
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  });
  ipcMain.on("ssh:term-write", (_e, { connId, data }) => {
    const s = sessions.get(connId);
    if (s && s.shell && data != null) s.shell.write(data);
  });
  ipcMain.handle("ssh:pick-upload", async (_e, { connId, remotePath }) => {
    const win = sshWin || BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: "选择要上传的文件或文件夹",
      properties: ["openFile", "openDirectory", "multiSelections"],
    });
    if (result.canceled || !result.filePaths.length) return { ok: true, cancelled: true };
    return uploadPaths(connId, remotePath, result.filePaths);
  });
  ipcMain.handle("ssh:upload-paths", async (_e, { connId, remotePath, paths }) => {
    return uploadPaths(connId, remotePath, paths || []);
  });
  ipcMain.handle("ssh:download", async (_e, { connId, items }) => {
    try {
      const s = requireSession(connId);
      const win = sshWin || BrowserWindow.getFocusedWindow();
      const list = items || [];
      if (!list.length) return { ok: false, error: "未选择文件" };

      if (list.length === 1 && list[0].type === "file") {
        const item = list[0];
        const result = await dialog.showSaveDialog(win, {
          title: "另存为",
          defaultPath: item.name || path.basename(item.path),
        });
        if (result.canceled || !result.filePath) return { ok: true, cancelled: true };
        sendToWin("ssh:progress", { phase: "download", name: item.name, loaded: 0, total: 1 });
        await sftpCall(s.sftp, "fastGet", item.path, result.filePath);
        sendToWin("ssh:progress", { phase: "done" });
        return { ok: true, paths: [result.filePath] };
      }

      const result = await dialog.showOpenDialog(win, {
        title: "选择保存目录",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: true, cancelled: true };
      const destRoot = result.filePaths[0];
      const saved = [];
      const jobs = [];
      for (const item of list) {
        if (item.type === "file") {
          jobs.push({
            remotePath: item.path,
            dest: path.join(destRoot, item.name || path.basename(item.path)),
            name: item.name,
          });
        } else {
          const files = await collectRemoteFiles(s.sftp, item.path, item.name || path.posix.basename(item.path));
          for (const f of files) {
            jobs.push({
              remotePath: f.remotePath,
              dest: path.join(destRoot, ...f.relative.split("/")),
              name: f.relative,
            });
          }
        }
      }
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        sendToWin("ssh:progress", {
          phase: "download",
          name: job.name,
          loaded: i,
          total: jobs.length,
        });
        await fsp.mkdir(path.dirname(job.dest), { recursive: true });
        await sftpCall(s.sftp, "fastGet", job.remotePath, job.dest);
        saved.push(job.dest);
      }
      sendToWin("ssh:progress", { phase: "done", loaded: jobs.length, total: jobs.length });
      return { ok: true, paths: saved };
    } catch (err) {
      const msg = friendlyError(err);
      sendToWin("ssh:progress", { phase: "error", error: msg });
      return { ok: false, error: msg };
    }
  });
  ipcMain.handle("ssh:reveal", (_e, filePath) => {
    if (filePath) shell.showItemInFolder(filePath);
  });
  ipcMain.handle("ssh:clipboard-write", (_e, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });
  ipcMain.handle("ssh:clipboard-read", () => {
    return { ok: true, text: clipboard.readText() || "" };
  });
  ipcMain.handle("ssh:open-window", () => {
    createSshWindow();
    return true;
  });

  async function uploadPaths(connId, remotePath, paths) {
    try {
      if (!paths.length) return { ok: true, cancelled: true };
      const s = requireSession(connId);
      const base = String(remotePath || s.cwd || "/");
      const jobs = [];
      for (const p of paths) {
        const st = await fsp.stat(p);
        if (st.isFile()) {
          jobs.push({ localPath: p, remotePath: joinRemote(base, path.basename(p)) });
        } else if (st.isDirectory()) {
          const files = await walkLocalDir(p);
          const rootName = path.basename(p);
          for (const f of files) {
            jobs.push({
              localPath: f.localPath,
              remotePath: joinRemote(base, rootName + "/" + f.relative),
            });
          }
        }
      }
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        sendToWin("ssh:progress", {
          phase: "upload",
          name: job.remotePath,
          loaded: i,
          total: jobs.length,
        });
        const dir = parentRemote(job.remotePath);
        if (dir && dir !== "/") {
          await ensureRemoteDir(s.sftp, dir);
        }
        await sftpCall(s.sftp, "fastPut", job.localPath, job.remotePath);
      }
      sendToWin("ssh:progress", { phase: "done", loaded: jobs.length, total: jobs.length });
      return { ok: true, uploaded: jobs.length };
    } catch (err) {
      const msg = friendlyError(err);
      sendToWin("ssh:progress", { phase: "error", error: msg });
      return { ok: false, error: msg };
    }
  }

  async function ensureRemoteDir(sftp, remotePath) {
    const parts = String(remotePath || "")
      .split("/")
      .filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc += "/" + part;
      try {
        const stat = await sftpCall(sftp, "stat", acc);
        if (!isDirAttrs(stat)) throw new Error(acc + " 已存在且不是目录");
      } catch (err) {
        if (err && err.message && /已存在/.test(err.message)) throw err;
        try {
          await sftpCall(sftp, "mkdir", acc);
        } catch (mkErr) {
          try {
            const stat = await sftpCall(sftp, "stat", acc);
            if (!isDirAttrs(stat)) throw mkErr;
          } catch {
            throw mkErr;
          }
        }
      }
    }
  }

  return { open: createSshWindow, close: closeSshWindow };
}

module.exports = { registerSsh, createSshWindow, closeSshWindow };
