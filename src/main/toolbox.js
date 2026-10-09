const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { dialog } = require("electron");
const des = require("./des");

const AES_SALT = Buffer.from("EditLongToolboxAES1");
const AES_ITER = 100000;

function aesKey(password) {
  return crypto.pbkdf2Sync(String(password || ""), AES_SALT, AES_ITER, 32, "sha256");
}

function desKey(password) {
  return crypto.createHash("md5").update(String(password || "")).digest().subarray(0, 8);
}

function encryptAes(text, password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey(password), iv);
  const enc = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptAes(payload, password) {
  const buf = Buffer.from(String(payload).trim(), "base64");
  if (buf.length < 28) throw new Error("AES 密文无效");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey(password), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function encryptDes(text, password) {
  return des.encrypt(text, desKey(password)).toString("base64");
}

function decryptDes(payload, password) {
  const buf = Buffer.from(String(payload).trim(), "base64");
  return des.decrypt(buf, desKey(password));
}

function digest(algo, text) {
  return crypto.createHash(algo).update(String(text), "utf8").digest("hex");
}

async function runCrypto({ action, mode, text, password, hashAlgo }) {
  try {
    if (mode === "aes") {
      const out = action === "decrypt" ? decryptAes(text, password) : encryptAes(text, password);
      return { ok: true, text: out };
    }
    if (mode === "des") {
      const out = action === "decrypt" ? decryptDes(text, password) : encryptDes(text, password);
      return { ok: true, text: out };
    }
    if (mode === "md5") {
      if (action === "decrypt") return { ok: false, error: "MD5 不可逆" };
      return { ok: true, text: digest("md5", text) };
    }
    if (mode === "base64") {
      if (action === "decrypt") {
        return { ok: true, text: Buffer.from(String(text).trim(), "base64").toString("utf8") };
      }
      return { ok: true, text: Buffer.from(String(text), "utf8").toString("base64") };
    }
    if (mode === "hash") {
      if (action === "decrypt") return { ok: false, error: "Hash 不可逆" };
      const algo = hashAlgo === "sha1" ? "sha1" : hashAlgo === "sha512" ? "sha512" : "sha256";
      return { ok: true, text: digest(algo, text) };
    }
    return { ok: false, error: "未知算法" };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function registerToolboxIpc(ipcMain, getWindow) {
  ipcMain.handle("toolbox:crypto", (_e, payload) => runCrypto(payload));
  ipcMain.handle("toolbox:pick-dir", async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: "选择导出目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("toolbox:write-file", async (_e, { dir, name, data }) => {
    if (!dir || !name) throw new Error("缺少导出路径");
    const dest = path.join(dir, path.basename(name));
    await fs.writeFile(dest, Buffer.from(data));
    const stat = await fs.stat(dest);
    return { path: dest, size: stat.size };
  });
}

module.exports = { registerToolboxIpc, runCrypto };
