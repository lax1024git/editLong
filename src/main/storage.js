const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { BrowserWindow, ipcMain, dialog, shell, clipboard } = require("electron");
const {
  S3Client,
  ListObjectsV2Command,
  ListBucketsCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  GetBucketLocationCommand,
  HeadBucketCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { createWriteStream } = require("fs");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

/** @type {Map<string, string>} connId:bucket -> region */
const bucketRegionCache = new Map();

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

function clearBucketRegionCache(connId) {
  if (!connId) {
    bucketRegionCache.clear();
    return;
  }
  const prefix = connId + ":";
  for (const key of [...bucketRegionCache.keys()]) {
    if (key.startsWith(prefix)) bucketRegionCache.delete(key);
  }
}

function isOfficialAwsS3(conn) {
  if (conn.provider !== "s3") return false;
  const ep = (conn.endpoint || "").trim().toLowerCase();
  if (!ep) return true;
  // 用户填了官方 AWS 域名时，仍按官方 S3 处理（去掉自定义 endpoint，按桶换区）
  return /(^|\.)amazonaws\.com(\/|$)/.test(ep) || /(^|\.)amazonaws\.com\.cn(\/|$)/.test(ep);
}

function normalizeAwsRegion(loc) {
  if (!loc || loc === "null" || loc === "undefined") return "us-east-1";
  if (loc === "EU") return "eu-west-1";
  return String(loc).trim();
}

function isValidAwsRegion(region) {
  const r = String(region || "");
  if (!r || r === "specific" || r === "endpoint") return false;
  if (r === "us-east-1") return true;
  return /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(r);
}

function cacheBucketRegion(connId, bucket, region) {
  const r = normalizeAwsRegion(region);
  if (!connId || !bucket || !isValidAwsRegion(r)) return null;
  bucketRegionCache.set(connId + ":" + bucket, r);
  return r;
}

/** 从错误文案/响应头解析桶区域；勿匹配 “region specific endpoint” */
function extractRegionFromError(err) {
  if (!err) return null;
  if (err.BucketRegion && isValidAwsRegion(normalizeAwsRegion(err.BucketRegion))) {
    return normalizeAwsRegion(err.BucketRegion);
  }
  const headers =
    (err.$metadata && err.$metadata.httpHeaders) ||
    (err.$response && err.$response.headers) ||
    null;
  if (headers) {
    const br =
      headers["x-amz-bucket-region"] ||
      headers["X-Amz-Bucket-Region"] ||
      headers["x-amz-bucket-region".toLowerCase()];
    if (br && isValidAwsRegion(normalizeAwsRegion(br))) return normalizeAwsRegion(br);
  }
  const text = [err.message, err.Code, err.code, err.name, err.Region, err.region]
    .filter(Boolean)
    .join(" ");
  let m = text.match(/\b([a-z]{2}(?:-[a-z0-9]+)+-\d)\s+location constraint/i);
  if (m && isValidAwsRegion(m[1])) return normalizeAwsRegion(m[1]);
  m = text.match(/IllegalLocationConstraintException[\s\S]*?\b([a-z]{2}(?:-[a-z0-9]+)+-\d)\b/i);
  if (m && isValidAwsRegion(m[1])) return normalizeAwsRegion(m[1]);
  m = text.match(/\b(mx-central-\d|af-south-\d|ap-[a-z0-9]+-\d|eu-[a-z0-9]+-\d|us-[a-z0-9]+-\d|sa-[a-z0-9]+-\d|ca-[a-z0-9]+-\d|me-[a-z0-9]+-\d|il-[a-z0-9]+-\d)\b/i);
  if (m && isValidAwsRegion(m[1])) return normalizeAwsRegion(m[1]);
  return null;
}

function makeClient(conn, opts = {}) {
  const provider = PROVIDERS[conn.provider] || PROVIDERS.s3;
  const region = opts.region || conn.region || provider.region || "us-east-1";
  const customEndpoint = (conn.endpoint || "").trim();
  // 官方 AWS S3：不要带自定义 endpoint，否则跨区桶会报 location constraint 不兼容
  const endpoint = isOfficialAwsS3(conn)
    ? undefined
    : customEndpoint || (provider.endpoint || "").trim() || undefined;
  const forcePathStyle =
    typeof conn.forcePathStyle === "boolean" ? conn.forcePathStyle : Boolean(provider.forcePathStyle);
  if (!conn.accessKeyId || !conn.secretAccessKey) {
    throw new Error("缺少 Access Key / Secret Key");
  }
  const config = {
    region,
    forcePathStyle,
    credentials: {
      accessKeyId: conn.accessKeyId,
      secretAccessKey: conn.secretAccessKey,
    },
  };
  if (endpoint) config.endpoint = endpoint;
  // AWS SDK：跟随区域重定向；opt-in 区域（如 mx-central-1）仍需先解析正确 Region
  if (isOfficialAwsS3(conn)) config.followRegionRedirects = true;
  return new S3Client(config);
}

async function resolveAwsBucketRegion(conn, bucket) {
  if (!bucket) return conn.region || "us-east-1";
  const cacheKey = conn.id + ":" + bucket;
  if (bucketRegionCache.has(cacheKey)) {
    const cached = bucketRegionCache.get(cacheKey);
    if (isValidAwsRegion(cached)) return cached;
    bucketRegionCache.delete(cacheKey);
  }

  const probe = makeClient(conn, { region: "us-east-1" });

  // 1) HeadBucket（AWS 推荐）：响应带 BucketRegion
  try {
    const out = await probe.send(new HeadBucketCommand({ Bucket: bucket }));
    const r = cacheBucketRegion(conn.id, bucket, out.BucketRegion);
    if (r) return r;
  } catch (err) {
    const r = cacheBucketRegion(conn.id, bucket, extractRegionFromError(err));
    if (r) return r;
  }

  // 2) GetBucketLocation
  try {
    const out = await probe.send(new GetBucketLocationCommand({ Bucket: bucket }));
    const r = cacheBucketRegion(conn.id, bucket, normalizeAwsRegion(out.LocationConstraint));
    if (r) return r;
  } catch (err) {
    const r = cacheBucketRegion(conn.id, bucket, extractRegionFromError(err));
    if (r) return r;
  }

  // 不缓存猜测值，避免把错误 Region 钉死；下次可从操作错误里学到
  return conn.region || "us-east-1";
}

async function getClientForBucket(conn, bucket) {
  if (!conn) throw new Error("连接不存在");
  if (!bucket || !isOfficialAwsS3(conn)) return makeClient(conn);
  const region = await resolveAwsBucketRegion(conn, bucket);
  return makeClient(conn, { region });
}

/** 官方 S3：区域不对时从错误里学到真实区域并自动重试一次 */
async function withBucketClient(conn, bucket, run) {
  const client = await getClientForBucket(conn, bucket);
  try {
    return await run(client);
  } catch (err) {
    if (!isOfficialAwsS3(conn) || !bucket) throw err;
    const learned = extractRegionFromError(err);
    if (!learned) throw err;
    const cacheKey = conn.id + ":" + bucket;
    if (bucketRegionCache.get(cacheKey) === learned) throw err;
    cacheBucketRegion(conn.id, bucket, learned);
    const retryClient = makeClient(conn, { region: learned });
    return await run(retryClient);
  }
}

function friendlyS3Error(err) {
  const msg = String(err && (err.message || err) || "未知错误");
  if (/location constraint is incompatible|PermanentRedirect|AuthorizationHeaderMalformed|IllegalLocationConstraintException/i.test(msg)) {
    const region = extractRegionFromError(err);
    return (
      msg +
      "\n提示：该 Bucket 所在区域与当前请求端点不一致" +
      (region ? `（检测到 ${region}）` : "") +
      "。已支持按桶自动切换区域；请重新打开该桶，或把连接 Region 改成桶所在区。"
    );
  }
  if (/specified key does not exist|NoSuchKey/i.test(msg)) {
    return (
      msg +
      "\n提示：部分兼容端点不支持「列出全部 Bucket」。请在连接里填写默认 Bucket，或检查 Endpoint 是否为服务根地址（不要带桶名路径）。"
    );
  }
  if (/NoSuchBucket/i.test(msg)) {
    return msg + "\n提示：Bucket 名称不存在，或当前密钥无权访问。";
  }
  return msg;
}

function encodeObjectKey(key) {
  return String(key || "")
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** 根据连接配置拼出对象的 HTTP 访问地址（公开读才可直接打开） */
async function buildObjectUrl(connId, bucket, key) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  if (!bucket) throw new Error("未选择 Bucket");
  if (!key) throw new Error("未选择对象");
  const objectKey = String(key).replace(/^\/+/, "");
  if (!objectKey) throw new Error("对象路径无效");

  const provider = PROVIDERS[conn.provider] || PROVIDERS.s3;
  const forcePathStyle =
    typeof conn.forcePathStyle === "boolean" ? conn.forcePathStyle : Boolean(provider.forcePathStyle);
  let region = conn.region || provider.region || "us-east-1";
  if (isOfficialAwsS3(conn)) {
    region = await resolveAwsBucketRegion(conn, bucket);
  }

  const encodedKey = encodeObjectKey(objectKey);
  const customEndpoint = (conn.endpoint || "").trim() || (provider.endpoint || "").trim();

  if (isOfficialAwsS3(conn)) {
    if (forcePathStyle) {
      const host = region === "us-east-1" ? "s3.amazonaws.com" : "s3." + region + ".amazonaws.com";
      return "https://" + host + "/" + encodeURIComponent(bucket) + "/" + encodedKey;
    }
    const host =
      region === "us-east-1"
        ? bucket + ".s3.amazonaws.com"
        : bucket + ".s3." + region + ".amazonaws.com";
    return "https://" + host + "/" + encodedKey;
  }

  let base = customEndpoint.replace(/\/+$/, "");
  if (!base) throw new Error("连接未配置 Endpoint，无法生成访问地址");
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;

  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error("Endpoint 无效，无法生成访问地址");
  }

  if (forcePathStyle) {
    return u.protocol + "//" + u.host + "/" + encodeURIComponent(bucket) + "/" + encodedKey;
  }
  if (u.host === bucket || u.host.startsWith(bucket + ".")) {
    return u.protocol + "//" + u.host + "/" + encodedKey;
  }
  return u.protocol + "//" + bucket + "." + u.host + "/" + encodedKey;
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
  const Pref = normalizePrefix(prefix);
  return withBucketClient(conn, bucket, async (client) => {
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
  });
}

async function probeBucket(conn, bucket) {
  await withBucketClient(conn, bucket, async (client) => {
    await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: 1,
      }),
    );
  });
  return true;
}

async function listBuckets(connId) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const client = makeClient(conn);
  try {
    const out = await client.send(new ListBucketsCommand({}));
    return (out.Buckets || []).map((b) => {
      if (b.Name && b.BucketRegion) {
        cacheBucketRegion(conn.id, b.Name, b.BucketRegion);
      }
      return {
        name: b.Name,
        creationDate: b.CreationDate ? new Date(b.CreationDate).toISOString() : "",
        region: b.BucketRegion ? normalizeAwsRegion(b.BucketRegion) : "",
      };
    });
  } catch (err) {
    // 兼容端点常不支持 ListBuckets；若配置了默认桶则探测后直接用
    if (conn.bucket) {
      try {
        await probeBucket(conn, conn.bucket);
        return [{ name: conn.bucket, creationDate: "", region: "" }];
      } catch (probeErr) {
        throw new Error(friendlyS3Error(probeErr));
      }
    }
    throw new Error(friendlyS3Error(err));
  }
}

async function uploadFile(connId, bucket, key, localPath, onProgress) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const stat = await fsp.stat(localPath);
  return withBucketClient(conn, bucket, async (client) => {
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
  });
}

async function downloadObject(connId, bucket, key, destPath) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  return withBucketClient(conn, bucket, async (client) => {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await streamToFile(out.Body, destPath);
    const stat = await fsp.stat(destPath);
    return { path: destPath, size: stat.size };
  });
}

async function deleteKeys(connId, bucket, keys) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const list = (keys || []).filter(Boolean);
  if (!list.length) return { deleted: 0 };
  return withBucketClient(conn, bucket, async (client) => {
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
  });
}

async function createFolder(connId, bucket, prefix) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  const key = normalizePrefix(prefix);
  if (!key) throw new Error("文件夹名无效");
  return withBucketClient(conn, bucket, async (client) => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.alloc(0),
      }),
    );
    return { key };
  });
}

function parentPrefixOfKey(key, isFolder) {
  const raw = String(key || "").replace(/^\/+/, "");
  if (isFolder) {
    const p = normalizePrefix(raw);
    const parts = p.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? parts.join("/") + "/" : "";
  }
  const idx = raw.lastIndexOf("/");
  return idx >= 0 ? raw.slice(0, idx + 1) : "";
}

function encodeCopySource(bucket, key) {
  return [bucket, ...String(key).split("/")]
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function objectExists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = err && err.$metadata && err.$metadata.httpStatusCode;
    const name = String((err && (err.name || err.Code || err.code)) || "");
    if (status === 404 || /NotFound|NoSuchKey/i.test(name)) return false;
    throw err;
  }
}

async function copyThenDelete(client, bucket, fromKey, toKey) {
  if (fromKey === toKey) return;
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: toKey,
      CopySource: encodeCopySource(bucket, fromKey),
      MetadataDirective: "COPY",
    }),
  );
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
}

/** 同目录重命名文件或文件夹（S3 无 Copy + Delete 实现） */
async function renameObject(connId, bucket, fromKey, newName, type) {
  const conn = getConnection(connId);
  if (!conn) throw new Error("连接不存在");
  if (!bucket || !fromKey) throw new Error("缺少对象路径");
  const isFolder = type === "folder" || /\/$/.test(fromKey);
  const name = String(newName || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\\/g, "/");
  if (!name || name.includes("..") || name.includes("/")) {
    throw new Error("名称无效：不能包含 /、\\ 或 ..");
  }
  const parent = parentPrefixOfKey(fromKey, isFolder);
  const toKey = isFolder ? normalizePrefix(parent + name) : parent + name;
  const fromNorm = isFolder ? normalizePrefix(fromKey) : String(fromKey).replace(/^\/+/, "");
  if (fromNorm === toKey) return { fromKey: fromNorm, toKey, renamed: 0 };

  return withBucketClient(conn, bucket, async (client) => {
    if (isFolder) {
      if (await objectExists(client, bucket, toKey)) {
        throw new Error("目标文件夹已存在");
      }
      // 目标前缀下已有对象也视为冲突
      const destProbe = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: toKey, MaxKeys: 1 }),
      );
      if ((destProbe.Contents || []).length || (destProbe.CommonPrefixes || []).length) {
        throw new Error("目标文件夹已存在");
      }
      const keys = await collectPrefixKeys(client, bucket, fromNorm);
      if (!keys.length) {
        // 仅有空文件夹占位
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: toKey, Body: Buffer.alloc(0) }),
        );
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromNorm }));
        } catch {
          /* ignore */
        }
        return { fromKey: fromNorm, toKey, renamed: 1 };
      }
      let renamed = 0;
      for (const key of keys) {
        const rel = key.slice(fromNorm.length);
        const dest = toKey + rel;
        await copyThenDelete(client, bucket, key, dest);
        renamed += 1;
      }
      return { fromKey: fromNorm, toKey, renamed };
    }

    if (await objectExists(client, bucket, toKey)) {
      throw new Error("目标文件名已存在");
    }
    await copyThenDelete(client, bucket, fromNorm, toKey);
    return { fromKey: fromNorm, toKey, renamed: 1 };
  });
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
  return withBucketClient(conn, bucket, async (client) => {
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
  });
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
    clearBucketRegionCache(item.id);
    return publicConnection(item);
  });
  ipcMain.handle("storage:delete-connection", (_e, id) => {
    const list = loadConnections().filter((c) => c.id !== id);
    saveConnections(list);
    clearBucketRegionCache(id);
    return { ok: true };
  });
  ipcMain.handle("storage:test-connection", async (_e, id) => {
    try {
      const buckets = await listBuckets(id);
      return { ok: true, buckets: buckets.length };
    } catch (err) {
      return { ok: false, error: friendlyS3Error(err) };
    }
  });
  ipcMain.handle("storage:list-buckets", async (_e, connId) => {
    try {
      return { ok: true, buckets: await listBuckets(connId) };
    } catch (err) {
      return { ok: false, error: friendlyS3Error(err) };
    }
  });
  ipcMain.handle("storage:list", async (_e, { connId, bucket, prefix }) => {
    try {
      const data = await listDir(connId, bucket, prefix);
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: friendlyS3Error(err) };
    }
  });
  ipcMain.handle("storage:mkdir", async (_e, { connId, bucket, prefix }) => {
    try {
      return { ok: true, ...(await createFolder(connId, bucket, prefix)) };
    } catch (err) {
      return { ok: false, error: friendlyS3Error(err) };
    }
  });
  ipcMain.handle("storage:object-url", async (_e, { connId, bucket, key }) => {
    try {
      const url = await buildObjectUrl(connId, bucket, key);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle("storage:copy-object-url", async (_e, { connId, bucket, key }) => {
    try {
      const url = await buildObjectUrl(connId, bucket, key);
      clipboard.writeText(url);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle("storage:rename", async (_e, { connId, bucket, key, newName, type }) => {
    try {
      const data = await renameObject(connId, bucket, key, newName, type);
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: friendlyS3Error(err) };
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
      return { ok: false, error: friendlyS3Error(err) };
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
      if (!conn) throw new Error("连接不存在");

      for (const item of list) {
        if (item.type === "file") {
          const dest = path.join(destRoot, item.name || path.basename(item.key));
          sendToStorage("storage:progress", { phase: "download", name: item.name, loaded: 0, total: 1 });
          await downloadObject(connId, bucket, item.key, dest);
          saved.push(dest);
        } else {
          const folderPrefix = normalizePrefix(item.key || item.prefix);
          const keys = await withBucketClient(conn, bucket, (client) =>
            collectPrefixKeys(client, bucket, folderPrefix),
          );
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
      const msg = friendlyS3Error(err);
      sendToStorage("storage:progress", { phase: "error", error: msg });
      return { ok: false, error: msg };
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
      const msg = friendlyS3Error(err);
      sendToStorage("storage:progress", { phase: "error", error: msg });
      return { ok: false, error: msg };
    }
  }

  return { open: createStorageWindow, PROVIDERS };
}

module.exports = { registerStorage, createStorageWindow, PROVIDERS };
