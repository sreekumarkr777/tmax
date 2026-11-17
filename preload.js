// The only bridge between the UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sb', {
  createSession: (opts) => ipcRenderer.invoke('session:create', opts),
  listSessions: () => ipcRenderer.invoke('session:list'),
  write: (id, data) => ipcRenderer.send('session:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
  kill: (id) => ipcRenderer.invoke('session:kill', id),
  reveal: (id) => ipcRenderer.invoke('session:reveal', id),
  gitInfo: (cwd) => ipcRenderer.invoke('git:info', cwd),
  setVoice: (on) => ipcRenderer.invoke('voice:set', on),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  platform: process.platform,

  onData: (cb) => ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),
  onUpdate: (cb) => ipcRenderer.on('session:update', (_e, s) => cb(s)),
  onFocusSession: (cb) => ipcRenderer.on('session:focus', (_e, id) => cb(id)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action, arg) => cb(action, arg)),
  onWindowFocus: (cb) => ipcRenderer.on('window:focus', () => cb()),
});
