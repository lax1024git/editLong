const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("videoEditor", {
  pick: (kind) => ipcRenderer.invoke("video:pick", kind),
  probe: (filePath) => ipcRenderer.invoke("video:probe", filePath),
  toMediaUrl: (filePath) => ipcRenderer.invoke("video:to-media-url", filePath),
  filmstrip: (payload) => ipcRenderer.invoke("video:filmstrip", payload),
  run: (payload) => ipcRenderer.invoke("video:run", payload),
  reveal: (filePath) => ipcRenderer.invoke("video:reveal", filePath),
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("video:progress", handler);
    return () => ipcRenderer.removeListener("video:progress", handler);
  },
});
