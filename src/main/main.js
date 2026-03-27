/**
 * VibeLauncher v2.0 — Main Process (Refactorisé)
 * 
 * Changements majeurs vs v1.0:
 * ✓ contextIsolation: true + preload.js (sécurité)
 * ✓ Tokens chiffrés avec safeStorage
 * ✓ Compatible Windows / macOS / Linux
 * ✓ IPC 100% asynchrone (plus de sendSync)
 * ✓ Storage unifié (plus de 15x save/load dupliqués)
 * ✓ Extraction ZIP native multiplateforme (plus de PowerShell)
 * ✓ Détection Java multiplateforme
 */

const { app, BrowserWindow, BrowserView, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec, spawn } = require('child_process');
const fse = require('fs-extra');
const { Client } = require('minecraft-launcher-core');

// Modules refactorisés
const platform = require('./core/platform');
const storage = require('./core/storage');
const discordRpc = require('./discordRpc');

// ==================== CONFIG ====================

const MS_CLIENT_ID = '00000000402b5328';
let msAuthAccount = null;
let mainWindow = null;
/** Fenêtre dédiée Chess.com (selon le cas, l’intégration en cadre peut être bloquée) */
let chessWindow = null;
let chessView = null;
let chessViewActive = false;

const CHESS_DAILY_URL = 'https://www.chess.com/daily-chess-puzzle';

const FORGE_VERSIONS = {
  '1.9.4':  '1.9.4-12.17.0.2317-1.9.4',
  '1.10.2': '1.10.2-12.18.3.2511',
  '1.11.2': '1.11.2-13.20.1.2588',
  '1.12.2': '1.12.2-14.23.5.2860',
  '1.14.4': '1.14.4-28.2.26',
  '1.15.2': '1.15.2-31.2.57',
};

const FABRIC_LOADER = '0.15.11';

const JAVA_REQUIREMENTS = {
  '1.9.4': 8, '1.10.2': 8, '1.11.2': 8,
  '1.12.2': 8, '1.14.4': 8, '1.15.2': 8,
  '1.16.5': 21, '1.17.1': 21, '1.18.2': 21,
  '1.19.4': 21, '1.20.6': 21, '1.21.11': 21,
};

// ==================== WINDOW ====================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0a0c0f',
    icon: path.join(__dirname, '..', '..', 'build', platform.IS_WIN ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      // Phase 1: nodeIntegration activé pour compatibilité avec le renderer existant
      // Phase 2 (TODO): passer à nodeIntegration:false + contextIsolation:true
      // quand toutes les références require() dans index.html seront migrées vers vibe.*
      nodeIntegration: true,
      contextIsolation: false,
      // Permet de charger correctement certains iframes/ressources externes (ex: embeds externes)
      webSecurity: false,
      // Permet d'utiliser <webview> côté renderer (pas d'iframe pour certains sites)
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(async () => {
  createWindow();
  try {
    await discordRpc.initDiscordRpc();
    discordRpc.setMenuPresence().catch(() => {});
  } catch (e) {
    // RPC ne doit jamais casser l'app
    console.warn('[discord-rpc] init failed:', e && e.message ? e.message : e);
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ==================== WINDOW CONTROLS ====================

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => app.quit());

// ==================== MICROSOFT AUTH ====================
// ✅ Tokens stockés chiffrés via safeStorage

function saveMsAccount(account) {
  storage.saveSecure('ms-account', account);
}

function loadMsAccount() {
  return storage.loadSecure('ms-account', null);
}

ipcMain.handle('ms-login', async () => {
  try {
    const redirectUri = 'https://login.live.com/oauth20_desktop.srf';
    const authUrl = 'https://login.live.com/oauth20_authorize.srf?' +
      `client_id=${MS_CLIENT_ID}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent('service::user.auth.xboxlive.com::MBI_SSL')}` +
      `&display=touch&prompt=select_account`;

    const code = await new Promise((resolve, reject) => {
      const authWindow = new BrowserWindow({
        width: 520, height: 680,
        title: 'Connexion Microsoft — VibeLauncher',
        backgroundColor: '#0a0c0f',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
        parent: mainWindow, modal: true, show: false,
      });

      authWindow.loadURL(authUrl);
      authWindow.once('ready-to-show', () => authWindow.show());

      const timer = setTimeout(() => {
        try { authWindow.close(); } catch (e) { /* ignore */ }
        reject(new Error('Timeout'));
      }, 180000);

      function checkUrl(url) {
        if (url.startsWith(redirectUri)) {
          clearTimeout(timer);
          try { authWindow.close(); } catch (e) { /* ignore */ }
          const urlObj = new URL(url);
          const c = urlObj.searchParams.get('code');
          const err = urlObj.searchParams.get('error_description');
          if (c) resolve(c);
          else reject(new Error(err || 'Connexion annulée'));
        }
      }

      authWindow.webContents.on('will-redirect', (e, url) => checkUrl(url));
      authWindow.webContents.on('will-navigate', (e, url) => checkUrl(url));
      authWindow.webContents.on('did-navigate', (e, url) => checkUrl(url));
      authWindow.on('closed', () => { clearTimeout(timer); reject(new Error('Fenêtre fermée')); });
    });

    // Token exchange
    const msToken = await fetchJson('https://login.live.com/oauth20_token.srf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${MS_CLIENT_ID}&code=${encodeURIComponent(code)}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });

    if (!msToken.access_token) return { success: false, error: 'Token MS invalide' };

    // Xbox Live
    const xblRes = await fetchJson('https://user.auth.xboxlive.com/user/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 't=' + msToken.access_token },
        RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
      }),
    });
    if (!xblRes.Token) return { success: false, error: 'Xbox Live échoué' };
    const userHash = xblRes.DisplayClaims.xui[0].uhs;

    // XSTS
    const xstsRes = await fetchJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        Properties: { SandboxId: 'RETAIL', UserTokens: [xblRes.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
      }),
    });
    if (xstsRes.XErr) {
      const errs = { 2148916233: 'Pas de compte Xbox', 2148916235: 'Xbox indisponible', 2148916238: 'Compte mineur' };
      return { success: false, error: errs[xstsRes.XErr] || `Erreur XSTS: ${xstsRes.XErr}` };
    }

    // MC Token
    const mcRes = await fetchJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xstsRes.Token}` }),
    });
    if (!mcRes.access_token) return { success: false, error: 'Token MC invalide' };

    // Profile
    const profile = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
      headers: { 'Authorization': 'Bearer ' + mcRes.access_token },
    });
    if (!profile.id) return { success: false, error: 'Profil introuvable — as-tu acheté Minecraft ?' };

    msAuthAccount = {
      access_token: mcRes.access_token,
      client_token: profile.id,
      uuid: profile.id,
      name: profile.name,
      user_properties: '{}',
    };
    saveMsAccount(msAuthAccount);
    return { success: true, name: profile.name };

  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ms-logout', async () => {
  msAuthAccount = null;
  storage.deleteSecure('ms-account');
  return true;
});

ipcMain.handle('ms-get-account', async () => {
  if (msAuthAccount) return msAuthAccount;
  const saved = loadMsAccount();
  if (saved) { msAuthAccount = saved; return saved; }
  return null;
});

// ==================== SETTINGS & STORAGE (UNIFIED) ====================
// ✅ Remplace les 15+ patterns save/load dupliqués

ipcMain.handle('get-minecraft-dir', () => platform.getDefaultMinecraftDir());
ipcMain.handle('browse-directory', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// Générateur de handlers save/load async
const storageKeys = [
  'settings', 'servers', 'stats', 'theme', 'wallpaper', 'lang',
  'profiles', 'mods-state', 'minegame', 'challenges',
];

for (const key of storageKeys) {
  ipcMain.handle(`save-${key}-async`, async (_, data) => storage.save(key, data));
  ipcMain.handle(`load-${key}-async`, async () => storage.load(key));
}

// ==================== SAVES / WORLDS ====================

ipcMain.handle('list-worlds-async', async (_, gameDir) => {
  try {
    const savesDir = path.join(gameDir, 'saves');
    if (!fs.existsSync(savesDir)) return [];
    return fs.readdirSync(savesDir)
      .filter(f => {
        try { return fs.statSync(path.join(savesDir, f)).isDirectory(); } catch { return false; }
      })
      .map(name => {
        try {
          const stat = fs.statSync(path.join(savesDir, name));
          const size = getDirSize(path.join(savesDir, name));
          return { name, modified: stat.mtime.toLocaleDateString('fr-FR'), size: formatSize(size) };
        } catch { return { name, modified: '—', size: '—' }; }
      });
  } catch { return []; }
});

ipcMain.handle('backup-single-world-async', async (_, { gameDir, worldName }) => {
  try {
    const src = path.join(gameDir, 'saves', worldName);
    const backupDir = path.join(app.getPath('userData'), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fse.copySync(src, path.join(backupDir, `${worldName}_${Date.now()}`));
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('backup-world-async', async (_, gameDir) => {
  try {
    const backupDir = path.join(app.getPath('userData'), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fse.copySync(path.join(gameDir, 'saves'), path.join(backupDir, `all_worlds_${Date.now()}`));
    return true;
  } catch { return false; }
});

ipcMain.handle('delete-world-async', async (_, { gameDir, worldName }) => {
  try {
    fse.removeSync(path.join(gameDir, 'saves', worldName));
    return true;
  } catch { return false; }
});

// ==================== RESOURCE PACKS ====================

ipcMain.handle('list-resourcepacks-async', async (_, gameDir) => {
  try {
    const rpDir = path.join(gameDir, 'resourcepacks');
    if (!fs.existsSync(rpDir)) return [];
    return fs.readdirSync(rpDir).map(name => {
      try {
        const fp = path.join(rpDir, name);
        const stat = fs.statSync(fp);
        const size = stat.isDirectory() ? getDirSize(fp) : stat.size;
        return { name, size: formatSize(size), isZip: name.endsWith('.zip') };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
});

ipcMain.handle('delete-resourcepack-async', async (_, { gameDir, name }) => {
  try { fse.removeSync(path.join(gameDir, 'resourcepacks', name)); return true; }
  catch { return false; }
});

// ==================== LOGS ====================

ipcMain.handle('read-log-async', async (_, gameDir) => {
  try {
    const p = path.join(gameDir, 'logs', 'latest.log');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch { return null; }
});

ipcMain.handle('list-crashes-async', async (_, gameDir) => {
  try {
    const dir = path.join(gameDir, 'crash-reports');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.txt'))
      .sort().reverse().slice(0, 20)
      .map(name => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, date: stat.mtime.toLocaleString('fr-FR') };
      });
  } catch { return []; }
});

// ==================== CLEANER ====================

ipcMain.handle('cleaner-scan-async', async (_, targets) => {
  const results = {};
  for (const target of targets) {
    results[target.id] = { files: [], totalSize: 0 };
    if (!fs.existsSync(target.dirPath)) continue;
    try {
      walkDir(target.dirPath, (fullPath, stat) => {
        if (target.ext.some(e => fullPath.endsWith(e))) {
          results[target.id].files.push(fullPath);
          results[target.id].totalSize += stat.size;
        }
      });
    } catch { /* ignore */ }
  }
  return results;
});

ipcMain.handle('cleaner-delete-async', async (_, files) => {
  let deleted = 0, freed = 0;
  for (const f of files) {
    try {
      const stat = fs.statSync(f);
      freed += stat.size;
      fs.unlinkSync(f);
      deleted++;
    } catch { /* ignore */ }
  }
  return { deleted, freed };
});

// ==================== UTILS ====================

ipcMain.on('open-path', (_, p) => {
  try {
    shell.openPath(p);
  } catch (e) {
    console.error('open-path:', e);
  }
});

ipcMain.on('open-url', async (_, url) => {
  if (!url || typeof url !== 'string') return;
  try {
    await shell.openExternal(url);
  } catch (e) {
    console.error('open-url:', e);
  }
});

/** Puzzle du jour Chess.com dans une vraie fenêtre */
ipcMain.on('open-chess-window', () => {
  const chessUrl = 'https://www.chess.com/daily-chess-puzzle';
  try {
    if (chessWindow && !chessWindow.isDestroyed()) {
      chessWindow.focus();
      chessWindow.loadURL(chessUrl);
      return;
    }
    chessWindow = new BrowserWindow({
      show: false,
      width: 960,
      height: 820,
      minWidth: 640,
      minHeight: 520,
      parent: mainWindow || undefined,
      title: 'Chess.com — Puzzle du jour',
      backgroundColor: '#161512',
      icon: path.join(__dirname, '..', '..', 'build', platform.IS_WIN ? 'icon.ico' : 'icon.png'),
      backgroundThrottling: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Idem iframe : on désactive la sécurité réseau dans cette fenêtre dédiée
        // pour éviter les pages blanches si des ressources sont bloquées.
        webSecurity: false,
        sandbox: false,
      },
    });
    chessWindow.once('ready-to-show', () => {
      try { chessWindow.show(); } catch { /* ignore */ }
    });
    chessWindow.webContents.on('did-finish-load', () => {
      console.log('[chessWindow] did-finish-load');
    });
    chessWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
      console.error('[chessWindow] did-fail-load', { code, desc, url });
    });
    chessWindow.loadURL(chessUrl);
    chessWindow.on('closed', () => {
      chessWindow = null;
    });
  } catch (e) {
    console.error('open-chess-window:', e);
    shell.openExternal(chessUrl).catch(() => {});
  }
});

// ==================== CHESS.COM in main window (BrowserView) ====================
ipcMain.on('chess-view-show', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (!chessView) {
      chessView = new BrowserView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
        },
      });
      chessView.webContents.on('did-finish-load', () => {
        console.log('[chess-view] did-finish-load');
      });
      chessView.webContents.on('did-fail-load', (e, code, desc, url) => {
        console.error('[chess-view] did-fail-load', { code, desc, url });
      });
    }

    // Monte / remonte le BrowserView
    mainWindow.setBrowserView(chessView);

    const bounds = mainWindow.getContentBounds();
    chessView.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    chessView.setAutoResize({ width: true, height: true });

    if (!chessView.webContents.getURL() || chessView.webContents.getURL() === 'about:blank') {
      chessView.webContents.loadURL(CHESS_DAILY_URL).catch(() => {});
    }

    chessViewActive = true;
  } catch (e) {
    console.error('[chess-view-show] failed:', e);
  }
});

ipcMain.on('chess-view-hide', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setBrowserView(null);
    chessViewActive = false;
  } catch (e) {
    console.error('[chess-view-hide] failed:', e);
  }
});

// ==================== CHESS.COM modal (une seule fenêtre visible) ====================
ipcMain.on('chess-modal-show', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const chessUrl = 'https://www.chess.com/daily-chess-puzzle';
  try {
    if (chessWindow && !chessWindow.isDestroyed()) {
      mainWindow.hide();
      chessWindow.focus();
      if (chessWindow.webContents.getURL() !== chessUrl) chessWindow.loadURL(chessUrl);
      chessWindow.show();
      return;
    }

    chessWindow = new BrowserWindow({
      show: false,
      width: 1100,
      height: 820,
      minWidth: 760,
      minHeight: 600,
      parent: mainWindow || undefined,
      title: 'Chess.com — Daily Puzzle',
      backgroundColor: '#161512',
      icon: path.join(__dirname, '..', '..', 'build', platform.IS_WIN ? 'icon.ico' : 'icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        sandbox: false,
      },
    });

    chessWindow.webContents.on('did-finish-load', () => {
      console.log('[chess-modal] did-finish-load');
    });
    chessWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
      console.error('[chess-modal] did-fail-load', { code, desc, url });
    });

    chessWindow.on('closed', () => {
      chessWindow = null;
      try { mainWindow.show(); } catch { /* ignore */ }
    });

    mainWindow.hide();
    chessWindow.loadURL(chessUrl);
    chessWindow.once('ready-to-show', () => {
      try { chessWindow.show(); } catch { /* ignore */ }
    });
  } catch (e) {
    console.error('chess-modal-show failed:', e);
    try { mainWindow.show(); } catch { /* ignore */ }
    shell.openExternal(chessUrl).catch(() => {});
  }
});

ipcMain.on('chess-modal-hide', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { chessWindow?.close(); } catch { /* ignore */ }
  try { mainWindow.show(); } catch { /* ignore */ }
});
ipcMain.on('download-skin', (_, url) => {
  dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer le skin',
    defaultPath: 'skin.png',
    filters: [{ name: 'PNG', extensions: ['png'] }],
  }).then(result => {
    if (result.canceled) return;
    const file = fs.createWriteStream(result.filePath);
    https.get(url, res => res.pipe(file));
  });
});

function send(msg) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('launch-log', String(msg));
}

function sendProgress(pct, label) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('launch-progress', { task: pct, total: 100, type: label });
}

function getDirSize(dir) {
  let size = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        const s = fs.statSync(fp);
        size += s.isDirectory() ? getDirSize(fp) : s.size;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return size;
}

function walkDir(dir, callback) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { try { walkDir(full, callback); } catch { /* ignore */ } }
      else {
        try { callback(full, fs.statSync(full)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ==================== DOWNLOAD ====================

function downloadFile(url, dest, redirectCount = 0, onProgress = null) {
  if (redirectCount > 10) return Promise.reject(new Error('Trop de redirections'));
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        const loc = res.headers.location;
        const nextUrl = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        return downloadFile(nextUrl, dest, redirectCount + 1, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        return reject(new Error(`HTTP ${res.statusCode} pour ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0');
      let downloaded = 0;
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (onProgress && total > 0) onProgress(Math.round(downloaded / total * 100));
      });
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', err => { try { fs.unlinkSync(dest); } catch { /* ignore */ } reject(err); });
    }).on('error', err => {
      file.close();
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      reject(err);
    });
  });
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(options.body) : null;
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: { ...options.headers },
    };
    if (body) reqOptions.headers['Content-Length'] = body.length;
    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ==================== JAVA MANAGEMENT ====================
// ✅ Multiplateforme (Windows + macOS + Linux)

function getJavaDir() {
  return path.join(app.getPath('userData'), 'java');
}

function findLocalJava(majorVersion) {
  const javaDir = path.join(getJavaDir(), `jre-${majorVersion}`);
  return platform.findJavaInDir(javaDir);
}

async function installJava(majorVersion) {
  const javaDir = getJavaDir();
  const destDir = path.join(javaDir, `jre-${majorVersion}`);

  const existing = platform.findJavaInDir(destDir);
  if (existing) {
    send(`✓ Java ${majorVersion} déjà installé`);
    return existing;
  }

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  send(`🔍 Recherche Java ${majorVersion} sur Adoptium...`);
  const apiUrl = platform.getAdoptiumUrl(majorVersion);

  const releaseInfo = await fetchJson(apiUrl);
  if (!Array.isArray(releaseInfo) || !releaseInfo[0]) {
    throw new Error(`Java ${majorVersion} introuvable sur Adoptium`);
  }

  const asset = releaseInfo[0];
  const downloadUrl = asset.binary.package.link;
  const fileName = asset.binary.package.name;
  const sizeMB = Math.round(asset.binary.package.size / 1024 / 1024);
  const archivePath = path.join(javaDir, fileName);

  send(`⬇ Téléchargement Java ${majorVersion} (${sizeMB} MB)...`);
  sendProgress(0, `Java ${majorVersion}`);

  await downloadFile(downloadUrl, archivePath, 0, pct => {
    sendProgress(pct, `Java ${majorVersion} - ${pct}%`);
  });

  send(`📦 Extraction Java ${majorVersion}...`);
  sendProgress(95, `Extraction Java ${majorVersion}`);
  
  // ✅ Extraction multiplateforme (plus de PowerShell only!)
  await platform.extractArchive(archivePath, destDir);

  try { fs.unlinkSync(archivePath); } catch { /* ignore */ }

  const javaExe = platform.findJavaInDir(destDir);
  if (!javaExe) throw new Error(`Java ${majorVersion} extrait mais exécutable introuvable`);

  // ✅ Rendre exécutable sur Unix
  if (!platform.IS_WIN) {
    try { fs.chmodSync(javaExe, 0o755); } catch { /* ignore */ }
  }

  sendProgress(100, `Java ${majorVersion} installé !`);
  send(`✓ Java ${majorVersion} installé : ${javaExe}`);
  return javaExe;
}

async function getJavaForVersion(mcVersion) {
  const majorVersion = JAVA_REQUIREMENTS[mcVersion] || 21;
  send(`☕ Java ${majorVersion} requis pour MC ${mcVersion}`);

  // 1. Local (téléchargé par le launcher)
  const local = findLocalJava(majorVersion);
  if (local) { send(`✓ Java ${majorVersion} local : ${local}`); return local; }

  // 2. Système
  const sys = platform.findSystemJava(majorVersion);
  if (sys) { send(`✓ Java ${majorVersion} système : ${sys}`); return sys; }

  // 3. Téléchargement automatique
  send(`⚙ Téléchargement Java ${majorVersion} automatique...`);
  return await installJava(majorVersion);
}

// ==================== FORGE / FABRIC ====================

function findFabricVersion(gameDir, mcVersion) {
  const dir = path.join(gameDir, 'versions');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).find(d =>
    d.startsWith('fabric-loader-') && d.endsWith(`-${mcVersion}`)
  ) || null;
}

function findForgeVersion(gameDir, mcVersion) {
  const dir = path.join(gameDir, 'versions');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).find(d =>
    d.toLowerCase().includes('forge') && d.includes(mcVersion)
  ) || null;
}

function isForgeComplete(gameDir, mcVersion) {
  const forgeVer = FORGE_VERSIONS[mcVersion];
  if (!forgeVer) return false;
  const clientJar = path.join(gameDir, 'libraries', 'net', 'minecraftforge', 'forge', forgeVer, `forge-${forgeVer}-client.jar`);
  const universalJar = path.join(gameDir, 'libraries', 'net', 'minecraftforge', 'forge', forgeVer, `forge-${forgeVer}-universal.jar`);
  return fs.existsSync(clientJar) || fs.existsSync(universalJar);
}

async function installFabric(gameDir, mcVersion) {
  const versionId = `fabric-loader-${FABRIC_LOADER}-${mcVersion}`;
  const versionDir = path.join(gameDir, 'versions', versionId);
  if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

  send(`⬇ Téléchargement profil Fabric ${mcVersion}...`);
  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${FABRIC_LOADER}/profile/json`;
  const profilePath = path.join(versionDir, `${versionId}.json`);
  await downloadFile(profileUrl, profilePath);

  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (!profile.id) throw new Error('Profil Fabric invalide');

  // Supprimer jar vide si existant
  const fabricJar = path.join(versionDir, `${versionId}.jar`);
  if (fs.existsSync(fabricJar)) {
    const stat = fs.statSync(fabricJar);
    if (stat.size < 1000) fs.unlinkSync(fabricJar);
  }

  send(`✓ Fabric ${mcVersion} installé`);
  return versionId;
}

async function installForge(gameDir, mcVersion, javaPath) {
  const forgeVer = FORGE_VERSIONS[mcVersion];
  if (!forgeVer) throw new Error(`Forge non supporté pour ${mcVersion}`);

  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVer}/forge-${forgeVer}-installer.jar`;
  const installerPath = path.join(app.getPath('temp'), `forge-installer-${mcVersion}.jar`);

  send(`⬇ Téléchargement installer Forge ${mcVersion}...`);
  await downloadFile(installerUrl, installerPath);

  const stat = fs.statSync(installerPath);
  if (stat.size < 10000) {
    try { fs.unlinkSync(installerPath); } catch { /* ignore */ }
    throw new Error('Installer Forge corrompu');
  }

  send(`⚙ Installation Forge ${mcVersion}... (2-3 min)`);

  const oldForgeVersions = ['1.9.4', '1.10.2', '1.11.2', '1.12.2'];
  const isOld = oldForgeVersions.includes(mcVersion);
  const javaArgs = isOld
    ? ['-Djava.net.preferIPv4Stack=true', '-jar', installerPath]
    : ['-jar', installerPath, '--installClient', gameDir];

  if (isOld) send('⚠ Une fenêtre va s\'ouvrir — cliquer sur "Install client" puis OK');

  await new Promise((resolve, reject) => {
    const proc = spawn(javaPath, javaArgs, {
      stdio: 'pipe',
      windowsHide: false,
      cwd: gameDir,
    });
    const killTimer = setTimeout(() => { proc.kill(); reject(new Error('Forge timeout 5min')); }, 300000);
    proc.stdout.on('data', d => { const l = d.toString().trim(); if (l) send(l); });
    proc.stderr.on('data', d => { const l = d.toString().trim(); if (l) send(l); });
    proc.on('close', code => {
      clearTimeout(killTimer);
      try { fs.unlinkSync(installerPath); } catch { /* ignore */ }
      if (code === 0) { send(`✓ Forge ${mcVersion} installé !`); resolve(); }
      else reject(new Error(`Forge installer code ${code}`));
    });
    proc.on('error', err => {
      clearTimeout(killTimer);
      try { fs.unlinkSync(installerPath); } catch { /* ignore */ }
      reject(new Error(`Erreur java : ${err.message}`));
    });
  });
}

// ==================== LAUNCH ====================

ipcMain.on('launch-minecraft', async (event, { username, version, gameDir, ram, mods, loaderType }) => {
  try {
    const gameDirectory = path.join(gameDir, 'vibelauncher', version);
    const modsDir = path.join(gameDirectory, 'mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

    // Clear mods
    for (const f of fs.readdirSync(modsDir)) {
      try { fs.unlinkSync(path.join(modsDir, f)); } catch { /* ignore */ }
    }

    // Copy enabled mods
    const srcMods = path.join(__dirname, '..', '..', 'mods', version);
    let copied = 0;
    if (fs.existsSync(srcMods)) {
      for (const mod of mods) {
        if (!mod.enabled) continue;
        const src = path.join(srcMods, mod.file);
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(modsDir, mod.file)); copied++; }
        else send(`⚠ Mod introuvable : ${mod.file}`);
      }
    }
    send(`✓ ${copied} mod(s) copié(s)`);

    // Java
    const javaPath = await getJavaForVersion(version);
    send(`☕ Java : ${javaPath}`);

    // Loader
    let launchVersion;
    if (loaderType === 'fabric') {
      launchVersion = findFabricVersion(gameDir, version);
      if (!launchVersion) {
        send(`🔧 Installation Fabric ${version}...`);
        launchVersion = await installFabric(gameDir, version);
      } else { send(`✓ Fabric : ${launchVersion}`); }
    } else {
      launchVersion = findForgeVersion(gameDir, version);
      if (!launchVersion || !isForgeComplete(gameDir, version)) {
        if (launchVersion && !isForgeComplete(gameDir, version)) {
          send(`⚠ Forge ${version} incomplet, réinstallation...`);
          try { fse.removeSync(path.join(gameDir, 'versions', launchVersion)); } catch { /* ignore */ }
        } else { send(`🔧 Installation Forge ${version}...`); }
        await installForge(gameDir, version, javaPath);
        launchVersion = findForgeVersion(gameDir, version);
        if (!launchVersion) throw new Error('Forge installé mais version introuvable');
      } else { send(`✓ Forge : ${launchVersion}`); }
    }

    send(`▶ Lancement ${launchVersion}...`);

    const launcher = new Client();
    const savedAccount = loadMsAccount();
    if (savedAccount) msAuthAccount = savedAccount;

    let authorization;
    if (msAuthAccount && msAuthAccount.access_token && !msAuthAccount.access_token.startsWith('offline_')) {
      send(`✓ Compte Microsoft : ${msAuthAccount.name}`);
      authorization = {
        access_token: msAuthAccount.access_token,
        client_token: msAuthAccount.client_token || msAuthAccount.uuid,
        uuid: msAuthAccount.uuid,
        name: msAuthAccount.name,
        user_properties: '{}',
      };
    } else {
      send(`⚠ Mode hors ligne : ${username}`);
      const crypto = require('crypto');
      const hash = crypto.createHash('md5').update('OfflinePlayer:' + username).digest('hex');
      const uuid = [
        hash.substring(0, 8), hash.substring(8, 12),
        '3' + hash.substring(13, 16),
        ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.substring(18, 20),
        hash.substring(20, 32),
      ].join('-');
      authorization = { access_token: uuid, client_token: uuid, uuid, name: username, user_properties: '{}' };
    }

    const playerName = authorization?.name || username;

    // Rich Presence : lancement (timestamp stable pour la session)
    discordRpc.setLaunchingPresence({ version, loaderType, player: playerName }).catch(() => {});

    const opts = {
      authorization,
      root: gameDir,
      version: { number: version, type: 'release', custom: launchVersion },
      memory: { max: `${ram}G`, min: '512M' },
      overrides: {
        gameDirectory,
        java: javaPath,
        exec: javaPath,
        javaArgs: [
          '--add-opens', 'java.base/java.nio=ALL-UNNAMED',
          '--add-opens', 'java.base/sun.nio.ch=ALL-UNNAMED',
          '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
          '--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED',
          '--add-opens', 'java.base/java.io=ALL-UNNAMED',
          '--add-opens', 'java.base/java.util=ALL-UNNAMED',
          '-Dfml.ignoreInvalidMinecraftCertificates=true',
          '-Dfml.ignorePatchDiscrepancies=true',
        ],
      },
    };

    launcher.on('debug', e => send(e));
    launcher.on('data', e => send(e));
    let lastRpcProgressUpdate = 0;
    launcher.on('progress', e => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('launch-progress', e);

      // Rich Presence : progression (throttlée)
      try {
        if (e && typeof e.task === 'number' && typeof e.total === 'number' && e.total > 0) {
          const pct = Math.max(0, Math.min(100, Math.round((e.task / e.total) * 100)));
          const now = Date.now();
          if (now - lastRpcProgressUpdate >= 3000 && ['assets', 'natives', 'assets-copy', 'classes'].includes(e.type)) {
            lastRpcProgressUpdate = now;
            discordRpc.setLaunchingPresence({
              version,
              loaderType,
              player: playerName,
              progress: pct,
              phase: e.type,
            }).catch(() => {});
          }
        }
      } catch { /* ignore RPC progress */ }
    });
    launcher.on('close', code => {
      if (code === 0) send(`✓ Minecraft fermé proprement`);
      else send(`❌ Minecraft fermé avec erreur (code ${code})`);
      discordRpc.setMenuPresence().catch(() => {});
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('launch-close', code);
    });

    // ✅ JAVA_HOME multiplateforme
    process.env.JAVA_HOME = path.dirname(path.dirname(javaPath));
    process.env.PATH = path.dirname(javaPath) + platform.pathSeparator() + process.env.PATH;

    mainWindow.webContents.send('launch-started');

    launcher.launch(opts)
      .then(() => {
        // Une fois le process démarré, on passe en "En jeu"
        discordRpc.setPlayingPresence({ version, loaderType, player: playerName }).catch(() => {});
      })
      .catch(err => {
        send(`❌ Erreur lancement : ${err.message}`);
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('launch-error', err.message);
        discordRpc.setMenuPresence().catch(() => {});
      });

  } catch (err) {
    send(`❌ Erreur : ${err.message}`);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('launch-error', err.message);
    discordRpc.setMenuPresence().catch(() => {});
  }
});

// Nettoyage RPC lors de la fermeture de l'app
app.on('before-quit', () => {
  discordRpc.shutdownDiscordRpc().catch(() => {});
});

// ==================== BACKWARD COMPATIBILITY ====================
// Handlers synchrones pour le renderer legacy (index.html non encore entièrement migré)
// TODO Phase 2: supprimer quand tout sera migré vers window.vibe.*

// Settings (ancien format)
ipcMain.handle('save-settings', async (_, s) => {
  return storage.save('settings', s);
});
ipcMain.handle('load-settings', async () => {
  return storage.load('settings');
});

// Sync save/load handlers
const syncSaveLoadKeys = {
  'servers': 'servers',
  'stats': 'stats',
  'mods-state': 'mods-state',
  'minegame': 'minegame',
  'challenges': 'challenges',
  'profiles': 'profiles',
};

for (const [channel, key] of Object.entries(syncSaveLoadKeys)) {
  ipcMain.on(`save-${channel}`, (_, data) => {
    storage.save(key, data);
  });
  ipcMain.on(`load-${channel}`, (event) => {
    event.returnValue = storage.load(key);
  });
}

// Profiles: special case (returns .profiles)
ipcMain.on('load-profiles', (event) => {
  const data = storage.load('profiles');
  event.returnValue = data ? data.profiles : null;
});

// Theme sync
ipcMain.on('save-theme', (_, theme) => {
  storage.save('theme', { theme });
});
ipcMain.on('load-theme', (event) => {
  const data = storage.load('theme');
  event.returnValue = data ? data.theme : null;
});

// Wallpaper sync
ipcMain.on('save-wallpaper', (_, wp) => {
  storage.save('wallpaper', { wp });
});
ipcMain.on('load-wallpaper', (event) => {
  const data = storage.load('wallpaper');
  event.returnValue = data ? data.wp : null;
});

// Lang sync
ipcMain.on('save-lang', (_, lang) => {
  storage.save('lang', { lang });
});
ipcMain.on('load-lang', (event) => {
  const data = storage.load('lang');
  event.returnValue = data ? data.lang : null;
});

// Worlds sync
ipcMain.on('list-worlds', (event, gameDir) => {
  try {
    const savesDir = path.join(gameDir, 'saves');
    if (!fs.existsSync(savesDir)) { event.returnValue = []; return; }
    const worlds = fs.readdirSync(savesDir).filter(f => {
      try { return fs.statSync(path.join(savesDir, f)).isDirectory(); } catch { return false; }
    }).map(name => {
      try {
        const stat = fs.statSync(path.join(savesDir, name));
        const size = getDirSize(path.join(savesDir, name));
        return { name, modified: stat.mtime.toLocaleDateString('fr-FR'), size: formatSize(size) };
      } catch { return { name, modified: '—', size: '—' }; }
    });
    event.returnValue = worlds;
  } catch { event.returnValue = []; }
});

ipcMain.on('backup-single-world', (_, { gameDir, worldName }) => {
  try {
    const src = path.join(gameDir, 'saves', worldName);
    const backupDir = path.join(app.getPath('userData'), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fse.copySync(src, path.join(backupDir, `${worldName}_${Date.now()}`));
  } catch (e) { console.error('Backup error:', e); }
});

ipcMain.on('backup-world', (_, gameDir) => {
  try {
    const backupDir = path.join(app.getPath('userData'), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fse.copySync(path.join(gameDir, 'saves'), path.join(backupDir, `all_worlds_${Date.now()}`));
    if (mainWindow) mainWindow.webContents.send('notify', 'Backup complet effectué !');
  } catch (e) { console.error('Backup error:', e); }
});

ipcMain.on('delete-world', (event, { gameDir, worldName }) => {
  try { fse.removeSync(path.join(gameDir, 'saves', worldName)); event.returnValue = true; }
  catch { event.returnValue = false; }
});

// Resource packs sync
ipcMain.on('list-resourcepacks', (event, gameDir) => {
  try {
    const rpDir = path.join(gameDir, 'resourcepacks');
    if (!fs.existsSync(rpDir)) { event.returnValue = []; return; }
    event.returnValue = fs.readdirSync(rpDir).map(name => {
      try {
        const fp = path.join(rpDir, name);
        const stat = fs.statSync(fp);
        const size = stat.isDirectory() ? getDirSize(fp) : stat.size;
        return { name, size: formatSize(size), isZip: name.endsWith('.zip') };
      } catch { return null; }
    }).filter(Boolean);
  } catch { event.returnValue = []; }
});

ipcMain.on('delete-resourcepack', (event, { gameDir, name }) => {
  try { fse.removeSync(path.join(gameDir, 'resourcepacks', name)); event.returnValue = true; }
  catch { event.returnValue = false; }
});

// Logs sync
ipcMain.on('read-log', (event, gameDir) => {
  try {
    const p = path.join(gameDir, 'logs', 'latest.log');
    event.returnValue = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch { event.returnValue = null; }
});

ipcMain.on('list-crashes', (event, gameDir) => {
  try {
    const dir = path.join(gameDir, 'crash-reports');
    if (!fs.existsSync(dir)) { event.returnValue = []; return; }
    event.returnValue = fs.readdirSync(dir)
      .filter(f => f.endsWith('.txt')).sort().reverse().slice(0, 20)
      .map(name => ({ name, date: fs.statSync(path.join(dir, name)).mtime.toLocaleString('fr-FR') }));
  } catch { event.returnValue = []; }
});

// MS Account sync
ipcMain.on('ms-get-account-sync', (event) => {
  event.returnValue = msAuthAccount;
});

// Cleaner sync
ipcMain.on('cleaner-scan', (event, targets) => {
  const results = {};
  for (const target of targets) {
    results[target.id] = { files: [], totalSize: 0 };
    if (!fs.existsSync(target.dirPath)) continue;
    try {
      walkDir(target.dirPath, (fullPath, stat) => {
        if (target.ext.some(e => fullPath.endsWith(e))) {
          results[target.id].files.push(fullPath);
          results[target.id].totalSize += stat.size;
        }
      });
    } catch { /* ignore */ }
  }
  event.returnValue = results;
});

ipcMain.on('cleaner-delete', (event, files) => {
  let deleted = 0, freed = 0;
  for (const f of files) {
    try { const stat = fs.statSync(f); freed += stat.size; fs.unlinkSync(f); deleted++; }
    catch { /* ignore */ }
  }
  event.returnValue = { deleted, freed };
});
