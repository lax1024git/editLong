const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("httpapi", {
  list: () => ipcRenderer.invoke("http:list"),
  get: (id) => ipcRenderer.invoke("http:get", id),
  save: (payload) => ipcRenderer.invoke("http:save", payload),
  rename: (payload) => ipcRenderer.invoke("http:rename", payload),
  remove: (id) => ipcRenderer.invoke("http:delete", id),
  send: (payload) => ipcRenderer.invoke("http:send", payload),
  abort: () => ipcRenderer.invoke("http:abort"),
  copy: (text) => ipcRenderer.invoke("http:copy", text),
});
