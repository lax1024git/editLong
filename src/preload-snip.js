const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("snip", {
  done: (payload) => ipcRenderer.send("snip:done", payload),
  cancel: () => ipcRenderer.send("snip:cancel"),
  onBackground: (cb) => {
    ipcRenderer.on("snip:bg", (_e, url) => cb(url));
  },
});
