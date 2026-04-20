const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Version & updates
  getVersion:        ()      => ipcRenderer.invoke('get-version'),
  checkForUpdates:   ()      => ipcRenderer.invoke('check-for-updates'),
  installUpdate:     (data)  => ipcRenderer.invoke('install-update', data),
  onUpdateAvailable: (cb)    => ipcRenderer.on('update-available',  (_, d) => cb(d)),
  onUpdateProgress:  (cb)    => ipcRenderer.on('update-progress',   (_, p) => cb(p)),
  onUpdateStatus:    (cb)    => ipcRenderer.on('update-status',     (_, d) => cb(d)),

  // Credential profiles
  listProfiles:   ()        => ipcRenderer.invoke('list-profiles'),
  saveProfile:    (profile) => ipcRenderer.invoke('save-profile', profile),
  getProfile:     (id)      => ipcRenderer.invoke('get-profile', id),
  deleteProfile:  (id)      => ipcRenderer.invoke('delete-profile', id),

  // File I/O
  openSpreadsheet: ()               => ipcRenderer.invoke('open-spreadsheet'),
  saveFlow:        (data)           => ipcRenderer.invoke('save-flow', data),
  loadFlow:        ()               => ipcRenderer.invoke('load-flow'),
  saveLog:         (data)           => ipcRenderer.invoke('save-log', data),
  saveScript:      (data)           => ipcRenderer.invoke('save-script', data),
  getUserData:     ()               => ipcRenderer.invoke('get-userdata'),
  openExternal:    (url)            => ipcRenderer.invoke('open-external', url),
});
