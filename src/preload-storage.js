const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("storage", {
  providers: () => ipcRenderer.invoke("storage:providers"),
  listConnections: () => ipcRenderer.invoke("storage:list-connections"),
  getConnection: (id) => ipcRenderer.invoke("storage:get-connection", id),
  saveConnection: (payload) => ipcRenderer.invoke("storage:save-connection", payload),
  deleteConnection: (id) => ipcRenderer.invoke("storage:delete-connection", id),
  testConnection: (id) => ipcRenderer.invoke("storage:test-connection", id),
  listBuckets: (connId) => ipcRenderer.invoke("storage:list-buckets", connId),
  list: (payload) => ipcRenderer.invoke("storage:list", payload),
  mkdir: (payload) => ipcRenderer.invoke("storage:mkdir", payload),
  remove: (payload) => ipcRenderer.invoke("storage:delete", payload),
  pickUpload: (payload) => ipcRenderer.invoke("storage:pick-upload", payload),
  uploadPaths: (payload) => ipcRenderer.invoke("storage:upload-paths", payload),
  download: (payload) => ipcRenderer.invoke("storage:download", payload),
  reveal: (filePath) => ipcRenderer.invoke("storage:reveal", filePath),
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
  onProgress: (cb) => {
    ipcRenderer.on("storage:progress", (_e, data) => cb(data));
  },
});
