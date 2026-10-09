const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pin", {
  save: (format, dataUrl) => ipcRenderer.invoke("pin:save", format, dataUrl),
  copy: (dataUrl) => ipcRenderer.invoke("pin:copy", dataUrl),
  close: () => ipcRenderer.send("pin:close"),
  onImage: (cb) => {
    ipcRenderer.on("pin:image", (_e, url) => cb(url));
  },
  onCtrlZoom: (cb) => {
    ipcRenderer.on("pin:ctrl-zoom", (_e, direction) => cb(direction));
  },
});
