const tbx = (() => {
  const overlay = document.getElementById("tbx-overlay");
  const panel = document.getElementById("tbx-panel");
  const jsonEditor = document.getElementById("tbx-json");
  const jsonMsg = document.getElementById("tbx-json-msg");
  const tsInput = document.getElementById("tbx-ts");
  const dtInput = document.getElementById("tbx-dt");
  const tzSelect = document.getElementById("tbx-tz");
  const unitSelect = document.getElementById("tbx-unit");
  const timeMsg = document.getElementById("tbx-time-msg");
  const imgListEl = document.getElementById("tbx-img-list");
  const imgDrop = document.getElementById("tbx-img-drop");
  const imgMsg = document.getElementById("tbx-img-msg");
  const plainEl = document.getElementById("tbx-plain");
  const cipherEl = document.getElementById("tbx-cipher");
  const cryptoMode = document.getElementById("tbx-crypto-mode");
  const cryptoKey = document.getElementById("tbx-crypto-key");
  const hashAlgo = document.getElementById("tbx-hash-algo");
  const cryptoMsg = document.getElementById("tbx-crypto-msg");
  const imgFile = document.getElementById("tbx-img-file");

  const ZONES = [
    { id: "Asia/Shanghai", label: "中国 (Asia/Shanghai, UTC+8)" },
    { id: "UTC", label: "UTC" },
    { id: "America/New_York", label: "纽约 (America/New_York)" },
    { id: "America/Los_Angeles", label: "洛杉矶 (America/Los_Angeles)" },
    { id: "Europe/London", label: "伦敦 (Europe/London)" },
    { id: "Europe/Paris", label: "巴黎 (Europe/Paris)" },
    { id: "Asia/Tokyo", label: "东京 (Asia/Tokyo)" },
    { id: "Asia/Singapore", label: "新加坡 (Asia/Singapore)" },
    { id: "Australia/Sydney", label: "悉尼 (Australia/Sydney)" },
  ];

  const images = [];
  let pickingDir = false;
  let lastUnit = "s";

  function isOpen() {
    return overlay && !overlay.classList.contains("hidden");
  }

  function formatInZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const g = (t) => parts.find((p) => p.type === t).value;
    return g("year") + "-" + g("month") + "-" + g("day") + " " + g("hour") + ":" + g("minute") + ":" + g("second");
  }

  function wallToUtcMs(str) {
    const m = String(str)
      .trim()
      .replace("T", " ")
      .match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  function parseInZone(str, timeZone) {
    const want = wallToUtcMs(str);
    if (want == null) throw new Error("日期时间格式应为 YYYY-MM-DD HH:mm:ss");
    const guess = want;
    const shown = formatInZone(new Date(guess), timeZone);
    const delta = wallToUtcMs(shown) - want;
    return new Date(guess - delta);
  }

  function fillZones() {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    tzSelect.replaceChildren();
    const seen = new Set();
    const add = (id, label) => {
      if (seen.has(id)) return;
      seen.add(id);
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      tzSelect.appendChild(opt);
    };
    if (!ZONES.some((z) => z.id === local)) add(local, "本机 (" + local + ")");
    ZONES.forEach((z) => add(z.id, z.label));
    tzSelect.value = ZONES.some((z) => z.id === local) ? local : tzSelect.options[0].value;
  }

  function nowFill() {
    const unit = unitSelect.value;
    const ms = Date.now();
    tsInput.value = unit === "ms" ? String(ms) : String(Math.floor(ms / 1000));
    dtInput.value = formatInZone(new Date(ms), tzSelect.value);
    lastUnit = unit;
    setMsg(timeMsg, "", true);
  }

  function tsToDt() {
    try {
      const raw = tsInput.value.trim();
      if (!raw) throw new Error("请填写时间戳");
      let n = Number(raw);
      if (!Number.isFinite(n)) throw new Error("时间戳无效");
      if (unitSelect.value === "s") n *= 1000;
      dtInput.value = formatInZone(new Date(n), tzSelect.value);
      setMsg(timeMsg, "", true);
    } catch (err) {
      setMsg(timeMsg, err.message, false);
    }
  }

  function dtToTs() {
    try {
      const date = parseInZone(dtInput.value, tzSelect.value);
      const ms = date.getTime();
      tsInput.value = unitSelect.value === "ms" ? String(ms) : String(Math.floor(ms / 1000));
      setMsg(timeMsg, "", true);
    } catch (err) {
      setMsg(timeMsg, err.message, false);
    }
  }

  function onUnitChange() {
    const raw = tsInput.value.trim();
    const n = Number(raw);
    if (raw && Number.isFinite(n)) {
      const ms = lastUnit === "ms" ? n : n * 1000;
      tsInput.value = unitSelect.value === "ms" ? String(ms) : String(Math.floor(ms / 1000));
    }
    lastUnit = unitSelect.value;
  }

  function onTzChange() {
    if (tsInput.value.trim()) tsToDt();
  }

  function stripJsonc(text) {
    let out = "";
    let i = 0;
    let inStr = false;
    let quote = "";
    while (i < text.length) {
      const c = text[i];
      if (inStr) {
        out += c;
        if (c === "\\") {
          out += text[i + 1] || "";
          i += 2;
          continue;
        }
        if (c === quote) inStr = false;
        i += 1;
        continue;
      }
      if (c === '"') {
        inStr = true;
        quote = c;
        out += c;
        i += 1;
        continue;
      }
      if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i += 1;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
        i += 2;
        continue;
      }
      out += c;
      i += 1;
    }
    return out.replace(/,\s*([}\]])/g, "$1");
  }

  function parseFlexible(text) {
    const stripped = stripJsonc(text.trim());
    let value = JSON.parse(stripped);
    if (typeof value === "string") {
      try {
        value = JSON.parse(stripJsonc(value));
      } catch {
        /* keep string */
      }
    }
    return value;
  }

  function setMsg(el, text, ok) {
    el.textContent = text || "";
    el.classList.toggle("ok", Boolean(ok && text));
  }

  function jsonFormat() {
    try {
      const value = parseFlexible(jsonEditor.value);
      jsonEditor.value = JSON.stringify(value, null, 2);
      setMsg(jsonMsg, "已格式化", true);
    } catch (err) {
      setMsg(jsonMsg, "校验失败：" + err.message, false);
    }
  }

  function jsonMinify() {
    try {
      const value = parseFlexible(jsonEditor.value);
      jsonEditor.value = JSON.stringify(value);
      setMsg(jsonMsg, "已压缩", true);
    } catch (err) {
      setMsg(jsonMsg, "压缩失败：" + err.message, false);
    }
  }

  function jsonEscape() {
    jsonEditor.value = JSON.stringify(jsonEditor.value);
    setMsg(jsonMsg, "已转义", true);
  }

  function jsonUnescape() {
    try {
      const v = JSON.parse(jsonEditor.value.trim());
      if (typeof v !== "string") throw new Error("需要 JSON 字符串字面量");
      jsonEditor.value = v;
      setMsg(jsonMsg, "已去转义", true);
    } catch (err) {
      setMsg(jsonMsg, "去转义失败：" + err.message, false);
    }
  }

  function unicodeToChinese() {
    jsonEditor.value = jsonEditor.value.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
    setMsg(jsonMsg, "已转换为中文", true);
  }

  function chineseToUnicode() {
    jsonEditor.value = Array.from(jsonEditor.value)
      .map((ch) => {
        const c = ch.codePointAt(0);
        if (c <= 127) return ch;
        if (c > 0xffff) {
          const hi = Math.floor((c - 0x10000) / 0x400) + 0xd800;
          const lo = ((c - 0x10000) % 0x400) + 0xdc00;
          return "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
        }
        return "\\u" + c.toString(16).padStart(4, "0");
      })
      .join("");
    setMsg(jsonMsg, "已转换为 Unicode", true);
  }

  function copyText(value) {
    navigator.clipboard.writeText(value || "").catch(() => {
      const ta = document.createElement("textarea");
      ta.value = value || "";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    });
  }

  function renderImages() {
    imgListEl.replaceChildren();
    images.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "img-item";
      const name = document.createElement("span");
      name.textContent = item.status || item.file.name;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "移除";
      rm.onclick = () => {
        images.splice(idx, 1);
        renderImages();
      };
      row.append(name, rm);
      imgListEl.appendChild(row);
    });
  }

  function addImageFiles(fileList) {
    Array.from(fileList || []).forEach((file) => {
      if (!file.type || !file.type.startsWith("image/")) return;
      images.push({ file, status: "" });
    });
    renderImages();
  }

  function sizeMode() {
    return document.querySelector('input[name="tbx-size-mode"]:checked')?.value || "orig";
  }

  function computeSize(w, h) {
    const mode = sizeMode();
    if (mode === "orig") return { w, h };
    if (mode === "max") {
      const mw = Number(document.getElementById("tbx-max-w").value) || 0;
      const mh = Number(document.getElementById("tbx-max-h").value) || 0;
      let scale = 1;
      if (mw > 0) scale = Math.min(scale, mw / w);
      if (mh > 0) scale = Math.min(scale, mh / h);
      return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
    }
    if (mode === "exact") {
      let tw = Number(document.getElementById("tbx-exact-w").value) || w;
      let th = Number(document.getElementById("tbx-exact-h").value) || h;
      if (document.getElementById("tbx-keep-ratio").checked) {
        const scale = Math.min(tw / w, th / h);
        tw = Math.max(1, Math.round(w * scale));
        th = Math.max(1, Math.round(h * scale));
      }
      return { w: tw, h: th };
    }
    const pct = Number(document.getElementById("tbx-scale").value) || 100;
    const s = Math.min(200, Math.max(5, pct)) / 100;
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  async function convertOne(item, format, quality) {
    const bitmap = await createImageBitmap(item.file);
    const size = computeSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, size.w, size.h);
    bitmap.close();
    const mime = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
    const q = format === "png" ? undefined : quality;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, q));
    if (!blob) throw new Error("转换失败");
    const buf = new Uint8Array(await blob.arrayBuffer());
    const base = item.file.name.replace(/\.[^.]+$/, "") || "image";
    const ext = format === "png" ? ".png" : format === "webp" ? ".webp" : ".jpg";
    return { name: base + ext, data: buf, w: size.w, h: size.h, size: buf.length };
  }

  async function convertImages() {
    if (!images.length) {
      setMsg(imgMsg, "请先添加图片", false);
      return;
    }
    pickingDir = true;
    const dir = await window.editlong.toolboxPickDir();
    pickingDir = false;
    if (!dir) return;
    const format = document.getElementById("tbx-img-format").value;
    const quality = Number(document.getElementById("tbx-img-quality").value) / 100;
    for (let i = 0; i < images.length; i++) {
      try {
        imgMsg.textContent = "转换中 " + (i + 1) + "/" + images.length;
        const out = await convertOne(images[i], format, quality);
        const written = await window.editlong.toolboxWriteFile({
          dir,
          name: out.name,
          data: out.data,
        });
        images[i].status =
          images[i].file.name +
          " → " +
          out.w +
          "×" +
          out.h +
          "  " +
          Math.round(written.size / 1024) +
          " KB";
      } catch (err) {
        images[i].status = images[i].file.name + " 失败：" + err.message;
      }
      renderImages();
    }
    setMsg(imgMsg, "完成，已导出到 " + dir, true);
  }

  function syncCryptoUi() {
    const mode = cryptoMode.value;
    const needKey = mode === "aes" || mode === "des";
    const reversible = mode === "aes" || mode === "des" || mode === "base64";
    cryptoKey.parentElement.style.display = needKey ? "" : "none";
    hashAlgo.parentElement.style.display = mode === "hash" ? "" : "none";
    document.getElementById("tbx-decrypt").disabled = !reversible;
    document.getElementById("tbx-encrypt").textContent =
      mode === "md5" || mode === "hash" ? "生成" : "加密 →";
  }

  async function runCrypto(action) {
    const result = await window.editlong.toolboxCrypto({
      action,
      mode: cryptoMode.value,
      text: action === "decrypt" ? cipherEl.value : plainEl.value,
      password: cryptoKey.value,
      hashAlgo: hashAlgo.value,
    });
    if (!result.ok) {
      setMsg(cryptoMsg, result.error, false);
      return;
    }
    if (action === "decrypt") plainEl.value = result.text;
    else cipherEl.value = result.text;
    setMsg(cryptoMsg, "完成", true);
  }

  function show(tab) {
    overlay.classList.remove("hidden");
    if (tab) setTab(tab);
    else setTab(sessionStorage.getItem("editlong.toolbox.tab") || "time");
    if ((sessionStorage.getItem("editlong.toolbox.tab") || "time") === "time" || tab === "time") {
      if (!tsInput.value && !dtInput.value) nowFill();
    }
  }

  function hide() {
    overlay.classList.add("hidden");
  }

  function setTab(id) {
    sessionStorage.setItem("editlong.toolbox.tab", id);
    document.querySelectorAll(".tbx-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === id);
    });
    document.querySelectorAll(".tbx-page").forEach((page) => {
      page.classList.toggle("active", page.dataset.page === id);
    });
    if (id === "time" && !tsInput.value && !dtInput.value) nowFill();
  }

  function bind() {
    fillZones();
    syncCryptoUi();
    overlay.addEventListener("mousedown", (e) => {
      if (pickingDir) return;
      if (e.target === overlay) hide();
    });
    panel.addEventListener("mousedown", (e) => e.stopPropagation());
    document.getElementById("tbx-close").onclick = hide;
    document.querySelectorAll(".tbx-tab").forEach((btn) => {
      btn.onclick = () => setTab(btn.dataset.tab);
    });
    document.getElementById("tbx-ts2dt").onclick = tsToDt;
    document.getElementById("tbx-dt2ts").onclick = dtToTs;
    document.getElementById("tbx-now").onclick = nowFill;
    document.getElementById("tbx-copy-ts").onclick = () => copyText(tsInput.value);
    document.getElementById("tbx-copy-dt").onclick = () => copyText(dtInput.value);
    unitSelect.onchange = onUnitChange;
    tzSelect.onchange = onTzChange;

    document.getElementById("tbx-json-format").onclick = jsonFormat;
    document.getElementById("tbx-json-minify").onclick = jsonMinify;
    document.getElementById("tbx-json-escape").onclick = jsonEscape;
    document.getElementById("tbx-json-unescape").onclick = jsonUnescape;
    document.getElementById("tbx-json-u2c").onclick = unicodeToChinese;
    document.getElementById("tbx-json-c2u").onclick = chineseToUnicode;
    document.getElementById("tbx-json-copy").onclick = () => {
      copyText(jsonEditor.value);
      setMsg(jsonMsg, "已复制", true);
    };
    document.getElementById("tbx-json-clear").onclick = () => {
      jsonEditor.value = "";
      setMsg(jsonMsg, "", true);
    };

    imgDrop.addEventListener("click", () => imgFile.click());
    imgFile.addEventListener("change", () => {
      addImageFiles(imgFile.files);
      imgFile.value = "";
    });
    ["dragenter", "dragover"].forEach((ev) => {
      imgDrop.addEventListener(ev, (e) => {
        e.preventDefault();
        imgDrop.classList.add("drag");
      });
    });
    imgDrop.addEventListener("dragleave", () => imgDrop.classList.remove("drag"));
    imgDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      imgDrop.classList.remove("drag");
      addImageFiles(e.dataTransfer.files);
    });
    document.getElementById("tbx-img-clear").onclick = () => {
      images.length = 0;
      renderImages();
    };
    document.getElementById("tbx-img-run").onclick = convertImages;

    cryptoMode.onchange = syncCryptoUi;
    document.getElementById("tbx-encrypt").onclick = () => runCrypto("encrypt");
    document.getElementById("tbx-decrypt").onclick = () => runCrypto("decrypt");
    document.getElementById("tbx-crypto-swap").onclick = () => {
      const a = plainEl.value;
      plainEl.value = cipherEl.value;
      cipherEl.value = a;
    };
    document.getElementById("tbx-crypto-clear").onclick = () => {
      plainEl.value = "";
      cipherEl.value = "";
    };
    document.getElementById("tbx-copy-plain").onclick = () => copyText(plainEl.value);
    document.getElementById("tbx-copy-cipher").onclick = () => copyText(cipherEl.value);
    document.getElementById("btn-toolbox").onclick = () => show();
    window.addEventListener("editlong-toolbox", (e) => show(e.detail || undefined));

    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && isOpen()) {
          e.preventDefault();
          e.stopPropagation();
          hide();
        }
      },
      true
    );
  }

  bind();
  return { show, hide, setTab, isOpen };
})();
