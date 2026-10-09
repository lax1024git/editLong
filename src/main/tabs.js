const path = require("path");
const { FileSession } = require("./fileSession");

class TabWorkspace {
  constructor() {
    this.seq = 0;
    this.untitledSeq = 0;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
  }

  active() {
    return this.tabs.get(this.activeId) || null;
  }

  get(id) {
    return this.tabs.get(id) || null;
  }

  findByPath(filePath) {
    const norm = path.normalize(filePath);
    for (const tab of this.tabs.values()) {
      if (tab.session.path && path.normalize(tab.session.path) === norm) return tab;
    }
    return null;
  }

  createUntitled(defaults) {
    const id = "t" + ++this.seq;
    this.untitledSeq += 1;
    const session = new FileSession();
    session.encoding = defaults.encoding || "utf8";
    const tab = {
      id,
      session,
      untitled: true,
      title: "未命名-" + this.untitledSeq,
      language: defaults.language || "plaintext",
      mode: defaults.mode || "text",
      wrap: Boolean(defaults.wrap),
      indexJob: 0,
    };
    this.tabs.set(id, tab);
    this.order.push(id);
    this.activeId = id;
    return tab;
  }

  async createFromPath(filePath, defaults) {
    const existing = this.findByPath(filePath);
    if (existing) {
      this.activeId = existing.id;
      return { tab: existing, reused: true };
    }
    const id = "t" + ++this.seq;
    const session = new FileSession();
    const meta = await session.open(filePath);
    const tab = {
      id,
      session,
      untitled: false,
      title: path.basename(filePath),
      language: defaults.language || "plaintext",
      mode: defaults.mode || "text",
      wrap: Boolean(defaults.wrap),
      indexJob: 0,
    };
    this.tabs.set(id, tab);
    this.order.push(id);
    this.activeId = id;
    return { tab, reused: false, meta };
  }

  activate(id) {
    if (!this.tabs.has(id)) return null;
    this.activeId = id;
    return this.tabs.get(id);
  }

  async close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    tab.indexJob += 1;
    await tab.session.close();
    this.tabs.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.order[idx] || this.order[idx - 1] || this.order[this.order.length - 1] || null;
      this.activeId = next;
    }
    return this.active();
  }

  async closeAll() {
    const ids = this.order.slice();
    for (const id of ids) await this.close(id);
  }

  snapshot(tab) {
    if (!tab) return null;
    const meta = tab.session.meta();
    const untitled = tab.untitled || !meta.path;
    return {
      id: tab.id,
      title: tab.title,
      untitled,
      path: meta.path,
      size: meta.size,
      encoding: meta.encoding,
      encodingLabel: meta.encodingLabel,
      bom: meta.bom,
      editable: untitled ? true : meta.editable,
      indexDone: untitled ? true : meta.indexDone,
      totalLines: meta.totalLines,
      indexedOffset: meta.indexedOffset,
      encodings: meta.encodings,
      language: tab.language,
      wrap: tab.wrap,
      mode: tab.mode,
      active: tab.id === this.activeId,
    };
  }

  list() {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => this.snapshot(this.tabs.get(id))).filter(Boolean),
    };
  }

  markSaved(tab) {
    tab.untitled = !tab.session.path;
    if (tab.session.path) tab.title = path.basename(tab.session.path);
  }
}

module.exports = { TabWorkspace };
