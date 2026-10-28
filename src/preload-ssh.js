const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("ssh", {
  listConnections: () => ipcRenderer.invoke("ssh:list-connections"),
  getConnection: (id) => ipcRenderer.invoke("ssh:get-connection", id),
  saveConnection: (payload) => ipcRenderer.invoke("ssh:save-connection", payload),
  duplicateConnection: (id) => ipcRenderer.invoke("ssh:duplicate-connection", id),
  reorderConnections: (ids) => ipcRenderer.invoke("ssh:reorder-connections", ids),
  deleteConnection: (id) => ipcRenderer.invoke("ssh:delete-connection", id),
  pickKey: () => ipcRenderer.invoke("ssh:pick-key"),
  connect: (id) => ipcRenderer.invoke("ssh:connect", id),
  disconnect: (id) => ipcRenderer.invoke("ssh:disconnect", id),
  testConnection: (id) => ipcRenderer.invoke("ssh:test-connection", id),
  list: (payload) => ipcRenderer.invoke("ssh:list", payload),
  mkdir: (payload) => ipcRenderer.invoke("ssh:mkdir", payload),
  rename: (payload) => ipcRenderer.invoke("ssh:rename", payload),
  remove: (payload) => ipcRenderer.invoke("ssh:delete", payload),
  termOpen: (payload) => ipcRenderer.invoke("ssh:term-open", payload),
  termResize: (payload) => ipcRenderer.invoke("ssh:term-resize", payload),
  termWrite: (connId, data) => ipcRenderer.send("ssh:term-write", { connId, data }),
  pickUpload: (payload) => ipcRenderer.invoke("ssh:pick-upload", payload),
  uploadPaths: (payload) => ipcRenderer.invoke("ssh:upload-paths", payload),
  download: (payload) => ipcRenderer.invoke("ssh:download", payload),
  reveal: (filePath) => ipcRenderer.invoke("ssh:reveal", filePath),
  clipboardWrite: (text) => ipcRenderer.invoke("ssh:clipboard-write", text),
  clipboardRead: () => ipcRenderer.invoke("ssh:clipboard-read"),
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === "function") {
        return webUtils.getPathForFile(file);
      }
    } catch {
      /* fall through */
    }
    return file && file.path ? file.path : "";
  },
  onTermData: (cb) => {
    ipcRenderer.on("ssh:term-data", (_e, data) => cb(data));
  },
  onTermExit: (cb) => {
    ipcRenderer.on("ssh:term-exit", (_e, data) => cb(data));
  },
  onDisconnected: (cb) => {
    ipcRenderer.on("ssh:disconnected", (_e, data) => cb(data));
  },
  onProgress: (cb) => {
    ipcRenderer.on("ssh:progress", (_e, data) => cb(data));
  },
});
