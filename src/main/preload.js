/**
 * VibeLauncher v2 — Preload Script
 * 
 * Expose window.vibe API pour les nouvelles fonctionnalités.
 * Mode transitoire: nodeIntegration=true, contextIsolation=false
 * Le code existant utilise encore require('electron') directement,
 * le nouveau code utilise window.vibe.*
 */
const { ipcRenderer } = require('electron');

const vibeAPI = {
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
  },
  auth: {
    login: () => ipcRenderer.invoke('ms-login'),
    logout: () => ipcRenderer.invoke('ms-logout'),
    getAccount: () => ipcRenderer.invoke('ms-get-account'),
  },
  settings: {
    save: (s) => ipcRenderer.invoke('save-settings-async', s),
    load: () => ipcRenderer.invoke('load-settings-async'),
    getMinecraftDir: () => ipcRenderer.invoke('get-minecraft-dir'),
    browseDirectory: () => ipcRenderer.invoke('browse-directory'),
  },
  launch: {
    start: (opts) => ipcRenderer.send('launch-minecraft', opts),
  },
  themes: {
    save: (t) => ipcRenderer.invoke('save-theme-async', t),
    load: () => ipcRenderer.invoke('load-theme-async'),
  },
  wallpaper: {
    save: (wp) => ipcRenderer.invoke('save-wallpaper-async', wp),
    load: () => ipcRenderer.invoke('load-wallpaper-async'),
  },
  lang: {
    save: (l) => ipcRenderer.invoke('save-lang-async', l),
    load: () => ipcRenderer.invoke('load-lang-async'),
  },
  utils: {
    openPath: (p) => ipcRenderer.send('open-path', p),
    openUrl: (url) => ipcRenderer.send('open-url', url),
    /** Ouvre le puzzle Chess.com dans une fenêtre du launcher */
    openChessWindow: () => ipcRenderer.send('open-chess-window'),
  },
  platform: process.platform,
};

window.vibe = vibeAPI;
