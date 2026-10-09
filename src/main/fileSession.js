const fs = require("fs/promises");
const { Buffer } = require("buffer");
const iconv = require("iconv-lite");

const INDEX_STRIDE = 1024;
const SCAN_CHUNK = 8 * 1024 * 1024;
const EDIT_LIMIT = 16 * 1024 * 1024;
const SEARCH_CHUNK = 4 * 1024 * 1024;

const ENCODINGS = {
  utf8: { label: "UTF-8", iconv: "utf8", wide: false },
  gbk: { label: "GBK", iconv: "gbk", wide: false },
  gb18030: { label: "GB18030", iconv: "gb18030", wide: false },
  latin1: { label: "Latin-1", iconv: "latin1", wide: false },
  "utf16-le": { label: "UTF-16 LE", iconv: "utf16-le", wide: true },
};

function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "utf8", bom: 3 };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: "utf16-le", bom: 2 };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: "utf16-be", bom: 2 };
  }
  return { encoding: "utf8", bom: 0 };
}

function parseHexQuery(text) {
  const hex = String(text).replace(/[^0-9a-fA-F]/g, "");
  if (!hex.length) {
    throw new Error("请输入十六进制字节，例如 48 65 6C 6C 6F");
  }
  if (hex.length % 2 !== 0) {
    throw new Error("十六进制长度必须为偶数");
  }
  return Buffer.from(hex, "hex");
}

function countNewlines(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n += 1;
  return n;
}

function countNewlinesWide(buf, startOffset, bom) {
  let n = 0;
  const start = startOffset % 2 === bom % 2 ? 0 : 1;
  for (let i = start; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x00) n += 1;
  }
  return n;
}

function asciiIndexOfCI(haystack, needle, start) {
  const nlen = needle.length;
  const hlen = haystack.length;
  outer: for (let i = start; i <= hlen - nlen; i++) {
    for (let j = 0; j < nlen; j++) {
      let a = haystack[i + j];
      let b = needle[j];
      if (a >= 65 && a <= 90) a += 32;
      if (b >= 65 && b <= 90) b += 32;
      if (a !== b) continue outer;
    }
    return i;
  }
  return -1;
}

class FileSession {
  constructor() {
    this.reset();
  }

  reset() {
    this.handle = null;
    this.path = null;
    this.size = 0;
    this.encoding = "utf8";
    this.bom = 0;
    this.index = {
      entries: [{ line: 0, offset: 0 }],
      stride: INDEX_STRIDE,
      totalLines: 1,
      indexedOffset: 0,
      done: false,
    };
    this.indexAbort = false;
    this.lineCursor = { line: 0, offset: 0 };
  }

  async close() {
    this.indexAbort = true;
    if (this.handle) {
      try {
        await this.handle.close();
      } catch {
        /* ignore */
      }
    }
    this.reset();
  }

  async open(filePath) {
    await this.close();
    this.indexAbort = false;
    this.handle = await fs.open(filePath, "r");
    const stat = await this.handle.stat();
    this.path = filePath;
    this.size = stat.size;
    const headLen = Math.min(4, this.size);
    if (headLen) {
      const head = Buffer.alloc(headLen);
      await this.handle.read(head, 0, headLen, 0);
      const detected = detectEncoding(head);
      this.encoding = detected.encoding === "utf16-be" ? "utf8" : detected.encoding;
      this.bom = detected.bom;
    }
    this.index.entries = [{ line: 0, offset: this.bom }];
    this.lineCursor = { line: 0, offset: this.bom };
    if (this.size === 0) {
      this.index.totalLines = 1;
      this.index.done = true;
      this.index.indexedOffset = 0;
    }
    return this.meta();
  }

  meta() {
    const enc = ENCODINGS[this.encoding] || ENCODINGS.utf8;
    return {
      path: this.path,
      size: this.size,
      encoding: this.encoding,
      encodingLabel: enc.label,
      bom: this.bom,
      editable: this.size <= EDIT_LIMIT,
      indexDone: this.index.done,
      totalLines: this.index.totalLines,
      indexedOffset: this.index.indexedOffset,
      encodings: Object.entries(ENCODINGS).map(([id, v]) => ({
        id,
        label: v.label,
      })),
    };
  }

  setEncoding(encoding) {
    if (!ENCODINGS[encoding]) {
      throw new Error("不支持的编码");
    }
    this.encoding = encoding;
    return this.meta();
  }

  async readBytes(offset, length) {
    if (!this.handle) throw new Error("未打开文件");
    if (offset < 0) offset = 0;
    if (offset >= this.size) return Buffer.alloc(0);
    const len = Math.min(length, this.size - offset);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await this.handle.read(buf, 0, len, offset);
    return buf.subarray(0, bytesRead);
  }

  async readText(maxBytes = EDIT_LIMIT) {
    if (!this.handle) throw new Error("未打开文件");
    if (this.size > maxBytes) {
      throw new Error("文件过大，无法整份载入编辑");
    }
    const buf = await this.readBytes(this.bom, this.size - this.bom);
    return this.decode(buf);
  }

  decode(buf) {
    const enc = ENCODINGS[this.encoding] || ENCODINGS.utf8;
    return iconv.decode(buf, enc.iconv);
  }

  encode(text) {
    const enc = ENCODINGS[this.encoding] || ENCODINGS.utf8;
    return iconv.encode(text, enc.iconv);
  }

  async saveText(filePath, text) {
    const body = this.encode(text);
    let out = body;
    if (this.encoding === "utf8" && this.bom === 3) {
      out = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
    } else if (this.encoding === "utf16-le" && this.bom === 2) {
      out = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
    }
    await fs.writeFile(filePath, out);
    await this.open(filePath);
    return this.meta();
  }

  wide() {
    return Boolean(ENCODINGS[this.encoding]?.wide);
  }

  async buildIndex(onProgress) {
    if (!this.handle || this.size === 0) {
      this.index.done = true;
      return this.meta();
    }
    const wide = this.wide();
    const newline = wide ? null : 0x0a;
    let offset = this.bom;
    let line = 0;
    const buf = Buffer.alloc(SCAN_CHUNK);
    const entries = [{ line: 0, offset: this.bom }];

    while (offset < this.size && !this.indexAbort) {
      const want = Math.min(SCAN_CHUNK, this.size - offset);
      const { bytesRead } = await this.handle.read(buf, 0, want, offset);
      if (!bytesRead) break;

      if (wide) {
        const start = offset % 2 === this.bom % 2 ? 0 : 1;
        for (let i = start; i + 1 < bytesRead; i += 2) {
          if (buf[i] === 0x0a && buf[i + 1] === 0x00) {
            line += 1;
            if (line % INDEX_STRIDE === 0) {
              entries.push({ line, offset: offset + i + 2 });
            }
          }
        }
      } else {
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === newline) {
            line += 1;
            if (line % INDEX_STRIDE === 0) {
              entries.push({ line, offset: offset + i + 1 });
            }
          }
        }
      }

      offset += bytesRead;
      this.index.entries = entries;
      this.index.indexedOffset = offset;
      this.index.totalLines = line + 1;
      if (onProgress) onProgress(this.meta());
    }

    if (!this.indexAbort) {
      this.index.entries = entries;
      this.index.totalLines = this.size === this.bom ? 1 : line + 1;
      this.index.indexedOffset = this.size;
      this.index.done = true;
    }
    return this.meta();
  }

  async offsetOfLine(targetLine) {
    if (targetLine <= 0) return this.bom;
    const { entries, stride } = this.index;
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].line <= targetLine) lo = mid + 1;
      else hi = mid - 1;
    }
    const base = entries[Math.max(0, hi)];
    if (base.line === targetLine) return base.offset;

    const wide = this.wide();
    let line = base.line;
    let offset = base.offset;
    const remaining = Math.min(stride + 8, targetLine - line + 2);
    const guess = remaining * 256;
    const cap = Math.max(64 * 1024, guess);
    while (line < targetLine && offset < this.size) {
      const buf = await this.readBytes(offset, cap);
      if (!buf.length) break;
      if (wide) {
        const start = offset % 2 === this.bom % 2 ? 0 : 1;
        for (let i = start; i + 1 < buf.length; i += 2) {
          if (buf[i] === 0x0a && buf[i + 1] === 0x00) {
            line += 1;
            if (line === targetLine) return offset + i + 2;
          }
        }
        offset += buf.length;
      } else {
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === 0x0a) {
            line += 1;
            if (line === targetLine) return offset + i + 1;
          }
        }
        offset += buf.length;
      }
    }
    return offset;
  }

  async readLines(startLine, count) {
    if (!this.handle) throw new Error("未打开文件");
    startLine = Math.max(0, startLine | 0);
    count = Math.max(1, Math.min(200, count | 0));
    const startOffset = await this.offsetOfLine(startLine);
    const wide = this.wide();
    const maxRead = 2 * 1024 * 1024;
    let buf = Buffer.alloc(0);
    while (buf.length < maxRead && startOffset + buf.length < this.size) {
      const more = await this.readBytes(
        startOffset + buf.length,
        Math.min(256 * 1024, maxRead - buf.length, this.size - startOffset - buf.length)
      );
      if (!more.length) break;
      buf = Buffer.concat([buf, more]);
      const found = wide
        ? countNewlinesWide(buf, startOffset, this.bom)
        : countNewlines(buf);
      if (found >= count) break;
      if (startOffset + buf.length >= this.size) break;
    }

    const lines = [];
    let lineStart = 0;
    let lineNo = startLine;
    let consumed = 0;

    const pushLine = (end, nlBytes) => {
      let slice = buf.subarray(lineStart, end);
      if (!wide && slice.length && slice[slice.length - 1] === 0x0d) {
        slice = slice.subarray(0, slice.length - 1);
      }
      if (wide && slice.length >= 2 && slice[slice.length - 2] === 0x0d && slice[slice.length - 1] === 0x00) {
        slice = slice.subarray(0, slice.length - 2);
      }
      lines.push({
        line: lineNo,
        offset: startOffset + lineStart,
        text: this.decode(slice),
      });
      lineNo += 1;
      lineStart = end + nlBytes;
      consumed = lineStart;
    };

    if (wide) {
      const align = startOffset % 2 === this.bom % 2 ? 0 : 1;
      for (let i = align; i + 1 < buf.length && lines.length < count; i += 2) {
        if (buf[i] === 0x0a && buf[i + 1] === 0x00) {
          pushLine(i, 2);
        }
      }
    } else {
      for (let i = 0; i < buf.length && lines.length < count; i++) {
        if (buf[i] === 0x0a) pushLine(i, 1);
      }
    }

    if (lines.length < count && startOffset + buf.length >= this.size && lineStart <= buf.length) {
      const slice = buf.subarray(lineStart);
      lines.push({
        line: lineNo,
        offset: startOffset + lineStart,
        text: this.decode(slice),
      });
      consumed = buf.length;
    }

    this.lineCursor = {
      line: startLine,
      offset: startOffset,
    };

    return {
      lines,
      startOffset,
      nextOffset: startOffset + consumed,
      totalLines: this.index.totalLines,
      indexDone: this.index.done,
    };
  }

  async findNext({ query, isHex, fromOffset, caseSensitive, reverse }) {
    if (!this.handle) throw new Error("未打开文件");
    const needle = isHex ? parseHexQuery(query) : this.encode(query);
    if (!needle.length) return { found: false };

    const ci = !isHex && !caseSensitive;
    let offset = Math.max(0, fromOffset | 0);
    if (reverse) {
      return this.findPrev(needle, offset, ci);
    }

    const overlap = needle.length - 1;
    while (offset < this.size) {
      const buf = await this.readBytes(offset, SEARCH_CHUNK);
      if (!buf.length) break;
      const idx = ci ? asciiIndexOfCI(buf, needle, 0) : buf.indexOf(needle);
      if (idx !== -1) {
        const matchOffset = offset + idx;
        const preview = await this.readBytes(matchOffset, Math.min(80, this.size - matchOffset));
        const line = await this.offsetToLine(matchOffset);
        return {
          found: true,
          offset: matchOffset,
          length: needle.length,
          line,
          preview: this.decode(preview),
        };
      }
      if (buf.length < SEARCH_CHUNK) break;
      offset += SEARCH_CHUNK - overlap;
    }
    return { found: false };
  }

  async findPrev(needle, fromOffset, ci) {
    const overlap = needle.length - 1;
    let end = Math.min(this.size, Math.max(0, fromOffset));
    while (end > 0) {
      const start = Math.max(0, end - SEARCH_CHUNK);
      const buf = await this.readBytes(start, end - start);
      let idx = -1;
      if (ci) {
        let from = 0;
        while (true) {
          const next = asciiIndexOfCI(buf, needle, from);
          if (next === -1) break;
          idx = next;
          from = next + 1;
        }
      } else {
        idx = buf.lastIndexOf(needle);
      }
      if (idx !== -1) {
        const matchOffset = start + idx;
        if (matchOffset < fromOffset) {
          const preview = await this.readBytes(matchOffset, Math.min(80, this.size - matchOffset));
          const line = await this.offsetToLine(matchOffset);
          return {
            found: true,
            offset: matchOffset,
            length: needle.length,
            line,
            preview: this.decode(preview),
          };
        }
      }
      if (start === 0) break;
      end = start + overlap;
    }
    return { found: false };
  }

  lineAtOffset(offset) {
    const { entries } = this.index;
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].offset <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return entries[Math.max(0, hi)];
  }

  async offsetToLine(offset) {
    const base = this.lineAtOffset(offset);
    if (base.offset === offset) return base.line;
    const wide = this.wide();
    let line = base.line;
    let pos = base.offset;
    const buf = await this.readBytes(pos, Math.min(offset - pos + 4, 2 * 1024 * 1024));
    const limit = Math.min(buf.length, offset - pos);
    if (wide) {
      const start = pos % 2 === this.bom % 2 ? 0 : 1;
      for (let i = start; i + 1 < limit; i += 2) {
        if (buf[i] === 0x0a && buf[i + 1] === 0x00) line += 1;
      }
    } else {
      for (let i = 0; i < limit; i++) {
        if (buf[i] === 0x0a) line += 1;
      }
    }
    return line;
  }
}

module.exports = {
  FileSession,
  ENCODINGS,
  EDIT_LIMIT,
};
