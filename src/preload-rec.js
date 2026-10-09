const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rec", {
  state: () => ipcRenderer.invoke("record:state"),
  setAudio: (next) => ipcRenderer.invoke("record:set-audio", next),
  begin: () => ipcRenderer.invoke("record:begin"),
  stop: () => ipcRenderer.send("record:stop"),
  cancel: () => ipcRenderer.send("record:cancel"),
  onState: (cb) => {
    ipcRenderer.on("rec:state", (_e, data) => cb(data));
  },
});
