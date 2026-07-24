const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayHub', {
  getStore: () => ipcRenderer.invoke('relay-store-get'),
  setStore: (key, value) => ipcRenderer.invoke('relay-store-set', key, value),
  getOpenMode: () => ipcRenderer.invoke('relay-open-mode-get'),
  setOpenMode: mode => ipcRenderer.invoke('relay-open-mode-set', mode),
  openSidePanel: () => ipcRenderer.invoke('relay-open-sidepanel'),
  copyText: text => ipcRenderer.invoke('relay-copy-text', text),
  fetch: payload => ipcRenderer.invoke('relay-fetch', payload),
  cancelFetch: id => ipcRenderer.invoke('relay-fetch-cancel', id),
  openSiteLogin: payload => ipcRenderer.invoke('relay-open-site-login', payload),
  readSiteTokens: (siteUrl, siteType) => ipcRenderer.invoke('relay-read-site-tokens', siteUrl, siteType),
  openExternal: url => ipcRenderer.invoke('relay-open-external', url),
  onStoreData: callback => {
    ipcRenderer.on('relay-store-data', (_event, data) => callback(data));
  },
  onOpenModeData: callback => {
    ipcRenderer.on('relay-open-mode-data', (_event, mode) => callback(mode));
  }
});
