const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { BrowserWindow, ipcMain, dialog, shell } = require("electron");
const {
  S3Client,
  ListObjectsV2Command,
  ListBucketsCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { createWriteStream } = require("fs");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const PROVIDERS = {
  s3: {
    id: "s3",
    label: "Amazon S3",
    endpoint: "",
    region: "us-east-1",
    forcePathStyle: false,
    hint: "可留空 endpoint，使用官方区域端点",
  },
  oss: {
    id: "oss",
    label: "阿里云 OSS",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    region: "oss-cn-hangzhou",
    forcePathStyle: false,
    hint: "Endpoint 形如 https://oss-cn-hangzhou.aliyuncs.com",
  },
  cos: {
    id: "cos",
    label: "腾讯云 COS",
    endpoint: "https://cos.ap-guangzhou.myqcloud.com",
    region: "ap-guangzhou",
    forcePathStyle: false,
    hint: "Endpoint 形如 https://cos.ap-guangzhou.myqcloud.com",
  },
  bos: {
    id: "bos",
    label: "百度云 BOS",
    endpoint: "https://s3.bj.bcebos.com",
    region: "bj",
    forcePathStyle: true,
    hint: "建议使用 S3 兼容 Endpoint，如 https://s3.bj.bcebos.com",
  },
  b2: {
    id: "b2",
    label: "Backblaze B2",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    region: "us-west-004",
    forcePathStyle: false,
    hint: "Endpoint 在 B2 控制台「S3 Compatible API」中查看",
  },
};

let settingsPath = "";
let storageWin = null;
let seq = 0;

function connectionsFile() {
  return path.join(settingsPath, "storage-connections.json");
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
    provider: c.provider,
    endpoint: c.endpoint || "",
    region: c.region || "",
    accessKeyId: c.accessKeyId || "",
    secretAccessKey: c.secretAccessKey ? "********" : "",
    hasSecret: Boolean(c.secretAccessKey),
    bucket: c.bucket || "",
    forcePathStyle: Boolean(c.forcePathStyle),
  };
}

function getConnection(id) {
  return loadConnections().find((c) => c.id === id) || null;
}

function makeClient(conn) {
  const provider = PROVIDERS[conn.provider] || PROVIDERS.s3;
  const region = conn.region || provider.region || "us-east-1";
  const endpoint = (conn.endpoint || provider.endpoint || "").trim() || undefined;
  const forcePathStyle =
    typeof conn.forcePathStyle === "boolean" ? conn.forcePathStyle : Boolean(provider.forcePathStyle);
  if (!conn.accessKeyId || !conn.secretAccessKey) {
    throw new Error("缺少 Access Key / Secret Key");
  }
  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: {
      accessKeyId: conn.accessKeyId,
      secretAccessKey: conn.secretAccessKey,
    },
  });
}

function normalizePrefix(prefix) {
  if (!prefix) return "";
  let p = String(prefix).replace(/\\/g, "/");
  while (p.startsWith("/")) p = p.slice(1);
  if (p && !p.endsWith("/")) p += "/";
  return p;
}

function joinKey(prefix, name) {
  const p = normalizePrefix(prefix);
  const n = String(name || "").replace(/^\/+/, "");
  return p + n;
}

async function streamToFile(body, dest) {
  const readable =
    body instanceof Readable
      ? body
      : Readable.fromWeb
        ? Readable.fromWeb(body)
        : Readable.from(body);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(readable, createWriteStream(dest));
}

async function listDir(connId, bucket, prefix) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const client = makeClient(conn);
  const Pref = normalizePrefix(prefix);
  const folders = [];
  const files = [];
  let token;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: Pref || undefined,
        Delimiter: "/",
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    (out.CommonPrefixes || []).forEach((cp) => {
      const full = cp.Prefix || "";
      const name = full.slice(Pref.length).replace(/\/$/, "");
      if (name) folders.push({ type: "folder", key: full, name });
    });
    (out.Contents || []).forEach((obj) => {
      if (!obj.Key || obj.Key === Pref) return;
      const name = obj.Key.slice(Pref.length);
      if (!name || name.includes("/")) return;
      files.push({
        type: "file",
        key: obj.Key,
        name,
        size: Number(obj.Size || 0),
        lastModified: obj.LastModified ? new Date(obj.LastModified).toISOString() : "",
        etag: obj.ETag || "",
      });
    });
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  folders.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return { prefix: Pref, folders, files };
}

async function listBuckets(connId) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const client = makeClient(conn);
  try {
    const out = await client.send(new ListBucketsCommand({}));
    return (out.Buckets || []).map((b) => ({
      name: b.Name,
      creationDate: b.CreationDate ? new Date(b.CreationDate).toISOString() : "",
    }));
  } catch (err) {
    if (conn.bucket) {
      return [{ name: conn.bucket, creationDate: "" }];
    }
    throw err;
  }
}

async function uploadFile(connId, bucket, key, localPath, onProgress) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const client = makeClient(conn);
  const stat = await fsp.stat(localPath);
  const body = fs.createReadStream(localPath);
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentLength: stat.size,
    },
  });
  upload.on("httpUploadProgress", (p) => {
    if (onProgress && p.total) onProgress({ loaded: p.loaded || 0, total: p.total });
  });
  await upload.done();
  return { key, size: stat.size };
}

async function downloadObject(connId, bucket, key, destPath) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const client = makeClient(conn);
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await streamToFile(out.Body, destPath);
  const stat = await fsp.stat(destPath);
  return { path: destPath, size: stat.size };
}

async function deleteKeys(connId, bucket, keys) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const client = makeClient(conn);
  const list = (keys || []).filter(Boolean);
  if (!list.length) return { deleted: 0 };
  if (list.length === 1) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: list[0] }));
    return { deleted: 1 };
  }
  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: list.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  return { deleted: list.length };
}

async function createFolder(connId, bucket, prefix) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const client = makeClient(conn);
  const key = normalizePrefix(prefix);
  if (!key) throw new Error("文件夹名无效");
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.alloc(0),
    }),
  );
  return { key };
}

async function collectPrefixKeys(client, bucket, prefix) {
  const Pref = normalizePrefix(prefix);
  const keys = [];
  let token;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: Pref,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    (out.Contents || []).forEach((o) => {
      if (o.Key) keys.push(o.Key);
    });
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteFolder(connId, bucket, prefix) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const client = makeClient(conn);
  const keys = await collectPrefixKeys(client, bucket, prefix);
  if (!keys.length) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: normalizePrefix(prefix) }));
    return { deleted: 1 };
  }
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
  return { deleted: keys.length };
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

function sendToStorage(channel, payload) {
  if (storageWin && !storageWin.isDestroyed()) {
    storageWin.webContents.send(channel, payload);
  }
}

function createStorageWindow() {
  if (storageWin && !storageWin.isDestroyed()) {
    storageWin.show();
    storageWin.focus();
    return storageWin;
  }
  storageWin = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    title: "对象存储 - EditLong",
    backgroundColor: "#f3f3f3",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload-storage.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  storageWin.once("ready-to-show", () => storageWin.show());
  storageWin.loadFile(path.join(__dirname, "..", "renderer", "storage.html"));
  storageWin.on("closed", () => {
    storageWin = null;
  });
  return storageWin;
}

function registerStorage(app) {
  settingsPath = app.getPath("userData");

  ipcMain.handle("storage:providers", () => Object.values(PROVIDERS));
  ipcMain.handle("storage:list-connections", () => loadConnections().map(publicConnection));
  ipcMain.handle("storage:get-connection", (_e, id) => {
    const c = getConnection(id);
    if (!c) return null;
    return { ...publicConnection(c), secretAccessKey: c.secretAccessKey || "" };
  });
  ipcMain.handle("storage:save-connection", (_e, payload) => {
    const list = loadConnections();
    const provider = PROVIDERS[payload.provider] ? payload.provider : "s3";
    let item = list.find((c) => c.id === payload.id);
    const keepSecret =
      payload.secretAccessKey === "********" || payload.secretAccessKey === "" || payload.secretAccessKey == null;
    if (item) {
      item.name = String(payload.name || item.name || "未命名").trim();
      item.provider = provider;
      item.endpoint = String(payload.endpoint || "").trim();
      item.region = String(payload.region || "").trim();
      item.accessKeyId = String(payload.accessKeyId || "").trim();
      if (!keepSecret) item.secretAccessKey = String(payload.secretAccessKey || "");
      item.bucket = String(payload.bucket || "").trim();
      item.forcePathStyle = Boolean(payload.forcePathStyle);
    } else {
      item = {
        id: "c" + Date.now() + "-" + ++seq,
        name: String(payload.name || "未命名连接").trim(),
        provider,
        endpoint: String(payload.endpoint || "").trim(),
        region: String(payload.region || "").trim(),
        accessKeyId: String(payload.accessKeyId || "").trim(),
        secretAccessKey: keepSecret ? "" : String(payload.secretAccessKey || ""),
        bucket: String(payload.bucket || "").trim(),
        forcePathStyle: Boolean(payload.forcePathStyle),
      };
      list.push(item);
    }
    saveConnections(list);
    return publicConnection(item);
  });
  ipcMain.handle("storage:delete-connection", (_e, id) => {
    const list = loadConnections().filter((c) => c.id !== id);
    saveConnections(list);
    return { ok: true };
  });
  ipcMain.handle("storage:test-connection", async (_e, id) => {
    try {
      const buckets = await listBuckets(id);
      return { ok: true, buckets: buckets.length };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle("storage:list-buckets", async (_e, connId) => {
    try {
      return { ok: true, buckets: await listBuckets(connId) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle("storage:list", async (_e, { connId, bucket, prefix }) => {
    try {
      const data = await listDir(connId, bucket, prefix);
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle("storage:mkdir", async (_e, { connId, bucket, prefix }) => {
    try {
      return { ok: true, ...(await createFolder(connId, bucket, prefix)) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle("storage:delete", async (_e, { connId, bucket, keys, folders }) => {
    try {
      let deleted = 0;
      if (keys && keys.length) {
        deleted += (await deleteKeys(connId, bucket, keys)).deleted;
      }
      for (const folder of folders || []) {
        deleted += (await deleteFolder(connId, bucket, folder)).deleted;
      }
      return { ok: true, deleted };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle("storage:pick-upload", async (_e, { connId, bucket, prefix }) => {
    const win = storageWin || BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: "选择要上传的文件或文件夹",
      properties: ["openFile", "openDirectory", "multiSelections"],
    });
    if (result.canceled || !result.filePaths.length) return { ok: true, cancelled: true };
    return uploadPaths(connId, bucket, prefix, result.filePaths);
  });
  ipcMain.handle("storage:upload-paths", async (_e, { connId, bucket, prefix, paths }) => {
    return uploadPaths(connId, bucket, prefix, paths || []);
  });
  ipcMain.handle("storage:download", async (_e, { connId, bucket, items }) => {
    try {
      const win = storageWin || BrowserWindow.getFocusedWindow();
      const list = items || [];
      if (!list.length) return { ok: false, error: "未选择对象" };

      if (list.length === 1 && list[0].type === "file") {
        const item = list[0];
        const result = await dialog.showSaveDialog(win, {
          title: "另存为",
          defaultPath: item.name || path.basename(item.key),
        });
        if (result.canceled || !result.filePath) return { ok: true, cancelled: true };
        sendToStorage("storage:progress", { phase: "download", name: item.name, loaded: 0, total: 1 });
        await downloadObject(connId, bucket, item.key, result.filePath);
        sendToStorage("storage:progress", { phase: "done" });
        return { ok: true, paths: [result.filePath] };
      }

      const result = await dialog.showOpenDialog(win, {
        title: "选择保存目录",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: true, cancelled: true };
      const destRoot = result.filePaths[0];
      const saved = [];
      const conn = getConnection(connId);
      const client = makeClient(conn);

      for (const item of list) {
        if (item.type === "file") {
          const dest = path.join(destRoot, item.name || path.basename(item.key));
          sendToStorage("storage:progress", { phase: "download", name: item.name, loaded: 0, total: 1 });
          await downloadObject(connId, bucket, item.key, dest);
          saved.push(dest);
        } else {
          const folderPrefix = normalizePrefix(item.key || item.prefix);
          const keys = await collectPrefixKeys(client, bucket, folderPrefix);
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key.endsWith("/") && keys.length > 1) continue;
            const rel = key.slice(folderPrefix.length);
            if (!rel) continue;
            const dest = path.join(destRoot, item.name || "folder", ...rel.split("/"));
            sendToStorage("storage:progress", {
              phase: "download",
              name: rel,
              loaded: i,
              total: keys.length,
            });
            await downloadObject(connId, bucket, key, dest);
            saved.push(dest);
          }
        }
      }
      sendToStorage("storage:progress", { phase: "done" });
      return { ok: true, paths: saved };
    } catch (err) {
      sendToStorage("storage:progress", { phase: "error", error: String(err.message || err) });
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle("storage:reveal", (_e, filePath) => {
    if (filePath) shell.showItemInFolder(filePath);
  });
  ipcMain.handle("storage:open-window", () => {
    createStorageWindow();
    return true;
  });

  async function uploadPaths(connId, bucket, prefix, paths) {
    try {
      if (!paths.length) return { ok: true, cancelled: true };
      const base = normalizePrefix(prefix);
      const jobs = [];
      for (const p of paths) {
        const st = await fsp.stat(p);
        if (st.isFile()) {
          jobs.push({ localPath: p, key: joinKey(base, path.basename(p)) });
        } else if (st.isDirectory()) {
          const files = await walkLocalDir(p);
          const rootName = path.basename(p);
          files.forEach((f) => {
            jobs.push({ localPath: f.localPath, key: joinKey(base, rootName + "/" + f.relative) });
          });
        }
      }
      let done = 0;
      for (const job of jobs) {
        sendToStorage("storage:progress", {
          phase: "upload",
          name: job.key,
          loaded: done,
          total: jobs.length,
        });
        await uploadFile(connId, bucket, job.key, job.localPath, (p) => {
          sendToStorage("storage:progress", {
            phase: "upload",
            name: job.key,
            loaded: done,
            total: jobs.length,
            fileLoaded: p.loaded,
            fileTotal: p.total,
          });
        });
        done += 1;
      }
      sendToStorage("storage:progress", { phase: "done", loaded: done, total: jobs.length });
      return { ok: true, uploaded: done };
    } catch (err) {
      sendToStorage("storage:progress", { phase: "error", error: String(err.message || err) });
      return { ok: false, error: String(err.message || err) };
    }
  }

  return { open: createStorageWindow, PROVIDERS };
}

module.exports = { registerStorage, createStorageWindow, PROVIDERS };
