const path = require("path");
const { FileSession } = require("./fileSession");

class TabWorkspace {
  constructor() {
    this.seq = 0;
    this.untitledSeq = 0;
    this.tabs = new Map();
    /** @type {string[]} global order across windows (stable for move) */
    this.order = [];
    /** @type {Map<string, string|null>} windowId -> active tab id */
    this.activeByWindow = new Map();
  }

  active(windowId) {
    if (windowId != null) return this.activeFor(windowId);
    // legacy: first non-empty window's active
    for (const id of this.activeByWindow.values()) {
      if (id && this.tabs.has(id)) return this.tabs.get(id);
    }
    return null;
  }

  activeFor(windowId) {
    if (windowId == null) return null;
    const id = this.activeByWindow.get(windowId);
    return (id && this.tabs.get(id)) || null;
  }

  getActiveId(windowId) {
    return this.activeByWindow.get(windowId) || null;
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

  tabsOf(windowId) {
    return this.order
      .map((id) => this.tabs.get(id))
      .filter((t) => t && t.windowId === windowId);
  }

  isEmpty(windowId) {
    return this.tabsOf(windowId).length === 0;
  }

  ensureWindow(windowId) {
    if (windowId == null) return;
    if (!this.activeByWindow.has(windowId)) this.activeByWindow.set(windowId, null);
  }

  removeWindow(windowId) {
    this.activeByWindow.delete(windowId);
  }

  createUntitled(defaults, windowId) {
    this.ensureWindow(windowId);
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
      windowId: windowId || null,
    };
    this.tabs.set(id, tab);
    this.order.push(id);
    if (windowId != null) this.activeByWindow.set(windowId, id);
    return tab;
  }

  async createFromPath(filePath, defaults, windowId) {
    this.ensureWindow(windowId);
    const existing = this.findByPath(filePath);
    if (existing) {
      if (windowId != null && existing.windowId === windowId) {
        this.activeByWindow.set(windowId, existing.id);
      }
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
      windowId: windowId || null,
    };
    this.tabs.set(id, tab);
    this.order.push(id);
    if (windowId != null) this.activeByWindow.set(windowId, id);
    return { tab, reused: false, meta };
  }

  activate(id, windowId) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    const wid = windowId != null ? windowId : tab.windowId;
    if (wid != null && tab.windowId !== wid) return null;
    if (wid != null) this.activeByWindow.set(wid, id);
    return tab;
  }

  /**
   * Move tab to another window (or reorder within window). Does not close session.
   * @returns {{ tab, fromWindowId, toWindowId } | null}
   */
  setWindowId(tabId, toWindowId, index) {
    const tab = this.tabs.get(tabId);
    if (!tab || toWindowId == null) return null;
    this.ensureWindow(toWindowId);
    const fromWindowId = tab.windowId;
    const fromIdx = this.order.indexOf(tabId);
    if (fromIdx >= 0) this.order.splice(fromIdx, 1);

    const destTabs = this.order.filter((id) => {
      const t = this.tabs.get(id);
      return t && t.windowId === toWindowId;
    });
    let insertAt;
    if (typeof index === "number" && index >= 0 && index <= destTabs.length) {
      if (index >= destTabs.length) {
        const last = destTabs[destTabs.length - 1];
        insertAt = last ? this.order.indexOf(last) + 1 : this.order.length;
      } else {
        insertAt = this.order.indexOf(destTabs[index]);
        if (insertAt < 0) insertAt = this.order.length;
      }
    } else {
      insertAt = this.order.length;
    }
    this.order.splice(insertAt, 0, tabId);
    tab.windowId = toWindowId;

    if (fromWindowId != null && this.activeByWindow.get(fromWindowId) === tabId) {
      const remaining = this.tabsOf(fromWindowId);
      this.activeByWindow.set(
        fromWindowId,
        remaining.length ? remaining[remaining.length - 1].id : null,
      );
    }
    this.activeByWindow.set(toWindowId, tabId);
    return { tab, fromWindowId, toWindowId };
  }

  async close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    const windowId = tab.windowId;
    tab.indexJob += 1;
    await tab.session.close();
    this.tabs.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    if (windowId != null && this.activeByWindow.get(windowId) === id) {
      const siblings = this.tabsOf(windowId);
      const next = siblings[0] || null;
      this.activeByWindow.set(windowId, next ? next.id : null);
      return next;
    }
    return windowId != null ? this.activeFor(windowId) : null;
  }

  async closeAllInWindow(windowId) {
    const ids = this.tabsOf(windowId).map((t) => t.id);
    for (const id of ids) await this.close(id);
    this.removeWindow(windowId);
  }

  async closeAll() {
    const ids = this.order.slice();
    for (const id of ids) await this.close(id);
    this.activeByWindow.clear();
  }

  snapshot(tab, windowId) {
    if (!tab) return null;
    const meta = tab.session.meta();
    const untitled = tab.untitled || !meta.path;
    const activeId = windowId != null ? this.activeByWindow.get(windowId) : null;
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
      windowId: tab.windowId,
      active: tab.id === activeId,
    };
  }

  listForWindow(windowId) {
    this.ensureWindow(windowId);
    const tabs = this.tabsOf(windowId).map((t) => this.snapshot(t, windowId)).filter(Boolean);
    return {
      activeId: this.activeByWindow.get(windowId) || null,
      windowId,
      tabs,
    };
  }

  list() {
    return {
      activeId: null,
      tabs: this.order.map((id) => {
        const tab = this.tabs.get(id);
        return tab ? this.snapshot(tab, tab.windowId) : null;
      }).filter(Boolean),
    };
  }

  markSaved(tab) {
    tab.untitled = !tab.session.path;
    if (tab.session.path) tab.title = path.basename(tab.session.path);
  }
}

module.exports = { TabWorkspace };
