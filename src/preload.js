const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("editlong", {
  openDialog: () => ipcRenderer.invoke("dialog:open"),
  meta: () => ipcRenderer.invoke("file:meta"),
  setEncoding: (encoding) => ipcRenderer.invoke("file:set-encoding", encoding),
  readLines: (startLine, count) =>
    ipcRenderer.invoke("file:read-lines", startLine, count),
  readBytes: (offset, length) =>
    ipcRenderer.invoke("file:read-bytes", offset, length),
  readText: () => ipcRenderer.invoke("file:read-text"),
  find: (opts) => ipcRenderer.invoke("file:find", opts),
  saveText: (payload) => ipcRenderer.invoke("file:save-text", payload),
  offsetToLine: (offset) => ipcRenderer.invoke("file:offset-to-line", offset),
  setMode: (mode) => ipcRenderer.invoke("ui:set-mode", mode),
  newFile: () => ipcRenderer.invoke("file:new"),
  closeFile: (id) => ipcRenderer.invoke("file:close", id),
  activateTab: (id) => ipcRenderer.invoke("tabs:activate", id),
  closeAllTabs: () => ipcRenderer.invoke("tabs:close-all"),
  onTabsChanged: (cb) => {
    ipcRenderer.on("tabs-changed", (_e, data) => cb(data));
  },
  onFileOpened: (cb) => {
    ipcRenderer.on("file-opened", (_e, meta) => cb(meta));
  },
  onIndexProgress: (cb) => {
    ipcRenderer.on("index-progress", (_e, meta) => cb(meta));
  },
  onMenu: (cb) => {
    ipcRenderer.on("menu", (_e, name) => cb(name));
  },
  onError: (cb) => {
    ipcRenderer.on("app-error", (_e, message) => cb(message));
  },
  onEncodingChanged: (cb) => {
    ipcRenderer.on("encoding-changed", (_e, meta) => cb(meta));
  },
  toolboxCrypto: (payload) => ipcRenderer.invoke("toolbox:crypto", payload),
  toolboxPickDir: () => ipcRenderer.invoke("toolbox:pick-dir"),
  toolboxWriteFile: (payload) => ipcRenderer.invoke("toolbox:write-file", payload),
  getSnipShortcut: () => ipcRenderer.invoke("snip:get-shortcut"),
  setSnipShortcut: (accelerator) => ipcRenderer.invoke("snip:set-shortcut", accelerator),
  startSnip: () => ipcRenderer.invoke("snip:start"),
  startRecord: () => ipcRenderer.invoke("record:start"),
});
