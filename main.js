const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const { Client, Authenticator } = require('minecraft-launcher-core');

// Client ID officiel du launcher Minecraft (pas besoin d'Azure perso)
const MS_CLIENT_ID = '00000000402b5328';
let msAuthAccount = null;

function saveMsAccount(account) {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'ms-account.json'), JSON.stringify(account, null, 2)); } catch(e) {}
}
function loadMsAccount() {
  try {
    const p = path.join(app.getPath('userData'), 'ms-account.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e) {}
  return null;
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(options.body) : null;
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    if (body) reqOptions.headers['Content-Length'] = body.length;
    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

ipcMain.handle('ms-login', async () => {
  try {
    // Utiliser login.live.com avec le client ID Mojang — tout doit être cohérent
    const redirectUri = 'https://login.live.com/oauth20_desktop.srf';
    const authUrl = 'https://login.live.com/oauth20_authorize.srf?' +
      'client_id=' + MS_CLIENT_ID +
      '&response_type=code' +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&scope=' + encodeURIComponent('service::user.auth.xboxlive.com::MBI_SSL') +
      '&display=touch&prompt=select_account';

    const code = await new Promise((resolve, reject) => {
      const authWindow = new BrowserWindow({
        width: 520, height: 680,
        title: 'Connexion Microsoft — VibeLauncher',
        backgroundColor: '#0a0c0f',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
        parent: mainWindow, modal: true, show: false
      });

      authWindow.loadURL(authUrl);
      authWindow.once('ready-to-show', () => authWindow.show());

      const timer = setTimeout(() => { try { authWindow.close(); } catch(e) {} reject(new Error('Timeout')); }, 180000);

      function checkUrl(url) {
        if (url.startsWith(redirectUri)) {
          clearTimeout(timer);
          try { authWindow.close(); } catch(e) {}
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

    // Échange de token — même domaine login.live.com
    const msToken = await fetchJson('https://login.live.com/oauth20_token.srf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'client_id=' + MS_CLIENT_ID + '&code=' + encodeURIComponent(code) + '&grant_type=authorization_code&redirect_uri=' + encodeURIComponent(redirectUri)
    });
    console.log('MS TOKEN:', JSON.stringify(msToken).substring(0, 200));

    if (!msToken.access_token) return { success: false, error: 'Token MS invalide : ' + JSON.stringify(msToken) };

    // Xbox Live — RpsTicket avec 't=' pour ce client ID
    const xblRes = await fetchJson('https://user.auth.xboxlive.com/user/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 't=' + msToken.access_token },
        RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
      })
    });
    console.log('XBL:', xblRes.Token ? 'OK' : JSON.stringify(xblRes).substring(0, 200));
    if (!xblRes.Token) return { success: false, error: 'Xbox Live échoué : ' + JSON.stringify(xblRes) };

    const userHash = xblRes.DisplayClaims.xui[0].uhs;

    // XSTS
    const xstsRes = await fetchJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        Properties: { SandboxId: 'RETAIL', UserTokens: [xblRes.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
      })
    });
    console.log('XSTS:', xstsRes.Token ? 'OK' : JSON.stringify(xstsRes).substring(0, 200));
    if (xstsRes.XErr) {
      const errs = { 2148916233: 'Pas de compte Xbox associé', 2148916235: 'Xbox non dispo dans ce pays', 2148916238: 'Compte mineur' };
      return { success: false, error: errs[xstsRes.XErr] || 'Erreur XSTS : ' + xstsRes.XErr };
    }

    // Token Minecraft
    const mcRes = await fetchJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityToken: 'XBL3.0 x=' + userHash + ';' + xstsRes.Token })
    });
    console.log('MC TOKEN:', mcRes.access_token ? 'OK' : JSON.stringify(mcRes).substring(0, 200));
    if (!mcRes.access_token) return { success: false, error: 'Token Minecraft invalide : ' + JSON.stringify(mcRes) };

    // Profil
    const profile = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
      headers: { 'Authorization': 'Bearer ' + mcRes.access_token }
    });
    if (!profile.id) return { success: false, error: 'Profil introuvable — as-tu acheté Minecraft ?' };

    msAuthAccount = { access_token: mcRes.access_token, client_token: profile.id, uuid: profile.id, name: profile.name, user_properties: '{}' };
    saveMsAccount(msAuthAccount);
    return { success: true, name: profile.name };

  } catch(err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ms-logout', async () => {
  msAuthAccount = null;
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'ms-account.json')); } catch(e) {}
  return true;
});

ipcMain.handle('ms-get-account', async () => {
  if (msAuthAccount) return msAuthAccount;
  const saved = loadMsAccount();
  if (saved) { msAuthAccount = saved; return saved; }
  return null;
});

let mainWindow;

const FORGE_VERSIONS = {
  '1.8.9':  '1.8.9-11.15.1.2318-1.8.9',
  '1.9.4':  '1.9.4-12.17.0.2317-1.9.4',
  '1.10.2': '1.10.2-12.18.3.2511',
  '1.11.2': '1.11.2-13.20.1.2588',
  '1.12.2': '1.12.2-14.23.5.2860',
  '1.14.4': '1.14.4-28.2.26',
  '1.15.2': '1.15.2-31.2.57'
};

const FABRIC_LOADER_META = 'https://meta.fabricmc.net/v2/versions/loader';
let fabricLoaderVersionCache = null;

// Java requis par version MC
// Forge 1.9.4-1.16.5 = Java 8
// Fabric 1.16.5+ = Java 21
const JAVA_REQUIREMENTS = {
  '1.8.9':  8,
  '1.9.4':  8,  '1.10.2': 8,  '1.11.2': 8,
  '1.12.2': 8,  '1.14.4': 8,  '1.15.2': 8,
  '1.16.5': 21, // Fabric
  '1.17.1': 21,
  '1.18.2': 21, '1.19.4': 21, '1.20.6': 21, '1.21.11': 21
};

// Dossier où le launcher stocke ses propres JREs
function getJavaDir() {
  return path.join(app.getPath('userData'), 'java');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 700,
    minWidth: 900, minHeight: 600,
    frame: false, backgroundColor: '#0a0c0f',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    show: false
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close', () => app.quit());

ipcMain.handle('get-minecraft-dir', async () => {
  const home = require('os').homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA, '.minecraft');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'minecraft');
  return path.join(home, '.minecraft');
});

ipcMain.handle('browse-directory', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('save-settings', async (_, s) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(s, null, 2));
  return true;
});

ipcMain.handle('load-settings', async () => {
  const p = path.join(app.getPath('userData'), 'settings.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
});

ipcMain.on('save-servers', (_, servers) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'servers.json'), JSON.stringify(servers, null, 2));
});

ipcMain.on('load-servers', (event) => {
  const p = path.join(app.getPath('userData'), 'servers.json');
  event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
});

// ==================== STATS ====================
ipcMain.on('save-stats', (_, data) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'stats.json'), JSON.stringify(data, null, 2));
});

ipcMain.on('load-stats', (event) => {
  const p = path.join(app.getPath('userData'), 'stats.json');
  event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
});

// ==================== SAUVEGARDES ====================
ipcMain.on('list-worlds', (event, gameDir) => {
  try {
    const savesDir = path.join(gameDir, 'saves');
    if (!fs.existsSync(savesDir)) { event.returnValue = []; return; }
    const worlds = fs.readdirSync(savesDir).filter(f => {
      try { return fs.statSync(path.join(savesDir, f)).isDirectory(); } catch(e) { return false; }
    }).map(name => {
      try {
        const stat = fs.statSync(path.join(savesDir, name));
        const size = getDirSize(path.join(savesDir, name));
        return { name, modified: stat.mtime.toLocaleDateString('fr-FR'), size: formatSize(size) };
      } catch(e) { return { name, modified: '—', size: '—' }; }
    });
    event.returnValue = worlds;
  } catch(e) { event.returnValue = []; }
});

function getDirSize(dir) {
  let size = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        const s = fs.statSync(fp);
        size += s.isDirectory() ? getDirSize(fp) : s.size;
      } catch(e) {}
    }
  } catch(e) {}
  return size;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

ipcMain.on('backup-single-world', (_, { gameDir, worldName }) => {
  try {
    const src = path.join(gameDir, 'saves', worldName);
    const backupDir = path.join(app.getPath('userData'), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, worldName + '_' + Date.now());
    fse.copySync(src, dest);
  } catch(e) { console.error('Backup error:', e); }
});

ipcMain.on('backup-world', (_, gameDir) => {
  try {
    const savesDir = path.join(gameDir, 'saves');
    const backupDir = path.join(app.getPath('userData'), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, 'all_worlds_' + Date.now());
    fse.copySync(savesDir, dest);
    if (mainWindow) mainWindow.webContents.send('notify', 'Backup complet effectué !');
  } catch(e) { console.error('Backup error:', e); }
});

ipcMain.on('list-resourcepacks', (event, gameDir) => {
  try {
    const rpDir = path.join(gameDir, 'resourcepacks');
    if (!fs.existsSync(rpDir)) { event.returnValue = []; return; }
    const packs = fs.readdirSync(rpDir).map(name => {
      try {
        const fp = path.join(rpDir, name);
        const stat = fs.statSync(fp);
        const size = stat.isDirectory() ? getDirSize(fp) : stat.size;
        return { name, size: formatSize(size), isZip: name.endsWith('.zip') };
      } catch(e) { return null; }
    }).filter(Boolean);
    event.returnValue = packs;
  } catch(e) { event.returnValue = []; }
});

ipcMain.on('delete-resourcepack', (event, { gameDir, name }) => {
  try {
    fse.removeSync(path.join(gameDir, 'resourcepacks', name));
    event.returnValue = true;
  } catch(e) { event.returnValue = false; }
});

ipcMain.on('delete-world', (event, { gameDir, worldName }) => {
  try {
    const worldPath = path.join(gameDir, 'saves', worldName);
    fse.removeSync(worldPath);
    event.returnValue = true;
  } catch(e) { event.returnValue = false; }
});

ipcMain.on('open-path', (_, p) => {
  require('electron').shell.openPath(p);
});

ipcMain.on('open-url', (_, url) => {
  require('electron').shell.openExternal(url);
});

// ==================== SKIN ====================
ipcMain.on('download-skin', (_, url) => {
  const { dialog } = require('electron');
  dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer le skin',
    defaultPath: 'skin.png',
    filters: [{ name: 'PNG', extensions: ['png'] }]
  }).then(result => {
    if (result.canceled) return;
    const https = require('https');
    const file = fs.createWriteStream(result.filePath);
    https.get(url, res => res.pipe(file));
  });
});

ipcMain.on('ms-get-account-sync', (event) => {
  event.returnValue = msAuthAccount;
});

// ==================== THÈME ====================
ipcMain.on('save-theme', (_, theme) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'theme.json'), JSON.stringify({ theme }));
});
ipcMain.on('load-theme', (event) => {
  const p = path.join(app.getPath('userData'), 'theme.json');
  event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).theme : null;
});

ipcMain.on('save-wallpaper', (_, wp) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'wallpaper.json'), JSON.stringify({ wp }));
});
ipcMain.on('load-wallpaper', (event) => {
  const p = path.join(app.getPath('userData'), 'wallpaper.json');
  event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).wp : null;
});

ipcMain.on('save-lang', (_, lang) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'lang.json'), JSON.stringify({ lang }));
});
ipcMain.on('load-lang', (event) => {
  const p = path.join(app.getPath('userData'), 'lang.json');
  event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).lang : null;
});

// ==================== MINE CLICKER ====================
// ==================== DÉFIS ====================
ipcMain.on('save-challenges', (_, data) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'challenges.json'), JSON.stringify(data, null, 2));
});
ipcMain.on('load-challenges', (event) => {
  const p = path.join(app.getPath('userData'), 'challenges.json');
  event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
});

// ==================== LOGS ====================
ipcMain.on('read-log', (event, gameDir) => {
  try {
    const p = path.join(gameDir, 'logs', 'latest.log');
    event.returnValue = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch(e) { event.returnValue = null; }
});

ipcMain.on('list-crashes', (event, gameDir) => {
  try {
    const dir = path.join(gameDir, 'crash-reports');
    if (!fs.existsSync(dir)) { event.returnValue = []; return; }
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.txt'))
      .sort().reverse()
      .slice(0, 20)
      .map(name => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, date: stat.mtime.toLocaleString('fr-FR') };
      });
    event.returnValue = files;
  } catch(e) { event.returnValue = []; }
});

ipcMain.on('save-minegame', (_, data) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'minegame.json'), JSON.stringify(data, null, 2));
});
ipcMain.on('load-minegame', (event) => {
  const p = path.join(app.getPath('userData'), 'minegame.json');
  event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
});

ipcMain.on('save-mods-state', (_, data) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'mods-state.json'), JSON.stringify(data, null, 2));
});

ipcMain.on('load-mods-state', (event) => {
  const p = path.join(app.getPath('userData'), 'mods-state.json');
  event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
});

ipcMain.on('save-profiles', (_, data) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'profiles.json'), JSON.stringify(data, null, 2));
});

ipcMain.on('load-profiles', (event) => {
  const p = path.join(app.getPath('userData'), 'profiles.json');
  event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).profiles : null;
});

// ==================== NETTOYEUR ====================
ipcMain.on('cleaner-scan', (event, targets) => {
  const results = {};
  for (const target of targets) {
    results[target.id] = { files: [], totalSize: 0 };
    if (!fs.existsSync(target.dirPath)) continue;
    try {
      const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { try { walk(full); } catch(e){} }
          else if (target.ext.some(e => entry.name.endsWith(e))) {
            try {
              const stat = fs.statSync(full);
              results[target.id].files.push(full);
              results[target.id].totalSize += stat.size;
            } catch(e) {}
          }
        }
      };
      walk(target.dirPath);
    } catch(e) {}
  }
  event.returnValue = results;
});

ipcMain.on('cleaner-delete', (event, files) => {
  let deleted = 0, freed = 0;
  for (const f of files) {
    try {
      const stat = fs.statSync(f);
      freed += stat.size;
      fs.unlinkSync(f);
      deleted++;
    } catch(e) {}
  }
  event.returnValue = { deleted, freed };
});

function send(msg) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('launch-log', String(msg));
}

function sendProgress(pct, label) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('launch-progress', { task: pct, total: 100, type: label });
}

// Téléchargement avec redirections + progression
function downloadFile(url, dest, redirectCount = 0, onProgress = null) {
  if (redirectCount > 10) return Promise.reject(new Error('Trop de redirections'));
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        try { fs.unlinkSync(dest); } catch(e) {}
        const loc = res.headers.location;
        const nextUrl = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        return downloadFile(nextUrl, dest, redirectCount + 1, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch(e) {}
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
      file.on('error', err => { try { fs.unlinkSync(dest); } catch(e) {} reject(err); });
    }).on('error', err => {
      file.close();
      try { fs.unlinkSync(dest); } catch(e) {}
      reject(err);
    });
  });
}

// Extrait un zip avec PowerShell (Windows natif, pas besoin de dépendance)
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Extraction échouée : ${err.message}`));
      else resolve();
    });
  });
}

// Cherche java.exe dans un dossier extrait (qui peut avoir un sous-dossier jdk-xx...)
function findJavaInDir(dir) {
  if (!fs.existsSync(dir)) return null;
  // Cherche directement
  const direct = path.join(dir, 'bin', 'java.exe');
  if (fs.existsSync(direct)) return direct;
  // Cherche dans sous-dossiers (cas Adoptium qui crée jdk-21.0.x-hotspot/)
  for (const entry of fs.readdirSync(dir)) {
    const sub = path.join(dir, entry, 'bin', 'java.exe');
    if (fs.existsSync(sub)) return sub;
  }
  return null;
}

// Vérifie si un java local est déjà installé pour cette version majeure
function findLocalJava(majorVersion) {
  const javaDir = path.join(getJavaDir(), `jre-${majorVersion}`);
  return findJavaInDir(javaDir);
}

// Télécharge et installe Java depuis Adoptium API
async function installJava(majorVersion) {
  const javaDir = getJavaDir();
  const destDir = path.join(javaDir, `jre-${majorVersion}`);

  // Déjà installé ?
  const existing = findJavaInDir(destDir);
  if (existing) {
    send(`✓ Java ${majorVersion} déjà installé`);
    return existing;
  }

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // Récupérer l'URL de téléchargement depuis l'API Adoptium
  send(`🔍 Recherche Java ${majorVersion} sur Adoptium...`);
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'x64' ? 'x64' : 'aarch64';
  // Java 8 = feature version 8, JRE suffit
  // Java 21 = feature version 21, JRE suffit
  const imageType = 'jre';
  const apiUrl = `https://api.adoptium.net/v3/assets/latest/${majorVersion}/hotspot?image_type=${imageType}&os=${os}&architecture=${arch}&vendor=eclipse`;

  // Fetch API JSON
  const releaseInfo = await new Promise((resolve, reject) => {
    https.get(apiUrl, { headers: { 'User-Agent': 'VibeLauncher/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Réponse API invalide')); }
      });
    }).on('error', reject);
  });

  if (!Array.isArray(releaseInfo) || !releaseInfo[0]) {
    throw new Error(`Java ${majorVersion} introuvable sur Adoptium`);
  }

  const asset = releaseInfo[0];
  const downloadUrl = asset.binary.package.link;
  const fileName = asset.binary.package.name;
  const sizeMB = Math.round(asset.binary.package.size / 1024 / 1024);
  const zipPath = path.join(javaDir, fileName);

  send(`⬇ Téléchargement Java ${majorVersion} (${sizeMB} MB)...`);
  sendProgress(0, `Java ${majorVersion}`);

  await downloadFile(downloadUrl, zipPath, 0, pct => {
    sendProgress(pct, `Java ${majorVersion} - ${pct}%`);
  });

  send(`📦 Extraction Java ${majorVersion}...`);
  sendProgress(95, `Extraction Java ${majorVersion}`);
  await extractZip(zipPath, destDir);

  // Nettoyer le zip
  try { fs.unlinkSync(zipPath); } catch(e) {}

  const javaExe = findJavaInDir(destDir);
  if (!javaExe) throw new Error(`Java ${majorVersion} extrait mais java.exe introuvable`);

  sendProgress(100, `Java ${majorVersion} installé !`);
  send(`✓ Java ${majorVersion} installé : ${javaExe}`);
  return javaExe;
}

// Obtenir le bon java pour une version MC
async function getJavaForVersion(mcVersion) {
  const majorVersion = JAVA_REQUIREMENTS[mcVersion] || 21;
  send(`☕ Java ${majorVersion} requis pour MC ${mcVersion}`);

  // 1. Chercher dans notre dossier LOCAL d'abord (téléchargé par le launcher)
  const local = findLocalJava(majorVersion);
  if (local) {
    send(`✓ Java ${majorVersion} local : ${local}`);
    return local;
  }

  // 2. Chercher Java 8 sur le système (souvent déjà installé)
  if (majorVersion === 8) {
    const sys = findSystemJava(8);
    if (sys) {
      send(`✓ Java 8 système : ${sys}`);
      return sys;
    }
  }

  // 3. Télécharger automatiquement depuis Adoptium
  send(`⚙ Téléchargement Java ${majorVersion} automatique...`);
  return await installJava(majorVersion);
}

// Cherche Java sur le système (Program Files etc.)
function findSystemJava(majorVersion) {
  if (process.platform !== 'win32') return null;
  const dirs = [
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Amazon Corretto',
  ];
  const patterns = {
    8:  [/^(jdk|jre)1\.8/, /^jdk-8\./],
    17: [/^jdk-17[\.\-]/, /^jdk-17$/],
    21: [/^jdk-21[\.\-]/],
  };
  const pats = patterns[majorVersion] || [new RegExp(`jdk-${majorVersion}`)];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).sort().reverse();
    for (const entry of entries) {
      if (pats.some(p => p.test(entry))) {
        const j = path.join(dir, entry, 'bin', 'java.exe');
        if (fs.existsSync(j)) return j;
      }
    }
  }
  return null;
}

async function getFabricLoaderVersion() {
  if (fabricLoaderVersionCache) return fabricLoaderVersionCache;
  const list = await fetchJson(FABRIC_LOADER_META);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Méta Fabric indisponible (loader)');
  }
  const stable = list.find(e => e && e.stable && e.version);
  const ver = stable ? stable.version : list[0].version;
  if (!ver) throw new Error('Version Fabric Loader introuvable');
  fabricLoaderVersionCache = ver;
  return ver;
}

function findFabricVersion(gameDir, mcVersion, loaderVersion) {
  const exact = `fabric-loader-${loaderVersion}-${mcVersion}`;
  if (fs.existsSync(path.join(gameDir, 'versions', exact))) return exact;
  return null;
}

function removeOtherFabricProfiles(gameDir, mcVersion, keepLoaderVersion) {
  const versionsRoot = path.join(gameDir, 'versions');
  if (!fs.existsSync(versionsRoot)) return;
  const keep = `fabric-loader-${keepLoaderVersion}-${mcVersion}`;
  for (const d of fs.readdirSync(versionsRoot)) {
    if (d.startsWith('fabric-loader-') && d.endsWith(`-${mcVersion}`) && d !== keep) {
      try {
        fs.rmSync(path.join(versionsRoot, d), { recursive: true, force: true });
        send(`🗑 Ancien profil Fabric retiré : ${d}`);
      } catch { /* ignore */ }
    }
  }
}

// Cherche Forge installé
function findForgeVersion(gameDir, mcVersion) {
  const dir = path.join(gameDir, 'versions');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).find(d =>
    d.toLowerCase().includes('forge') && d.includes(mcVersion)
  ) || null;
}

// Installe Fabric
async function installFabric(gameDir, mcVersion) {
  const loaderVer = await getFabricLoaderVersion();
  removeOtherFabricProfiles(gameDir, mcVersion, loaderVer);

  const versionId = `fabric-loader-${loaderVer}-${mcVersion}`;
  const versionDir = path.join(gameDir, 'versions', versionId);
  if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

  send(`⬇ Téléchargement profil Fabric ${mcVersion} (loader ${loaderVer})...`);
  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVer}/profile/json`;
  const profilePath = path.join(versionDir, `${versionId}.json`);
  await downloadFile(profileUrl, profilePath);

  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (!profile.id) throw new Error('Profil Fabric invalide');
  send(`✓ Profil Fabric valide : ${profile.id}`);

  // NE PAS créer de .jar — Fabric Loader doit trouver le vrai jar vanilla lui-même
  // Si un jar vide existe déjà (ancienne installation), le supprimer
  const fabricJar = path.join(versionDir, `${versionId}.jar`);
  if (fs.existsSync(fabricJar)) {
    const stat = fs.statSync(fabricJar);
    if (stat.size < 1000) {
      fs.unlinkSync(fabricJar);
      send(`🗑 Ancien jar Fabric vide supprimé`);
    }
  }

  send(`✓ Fabric ${mcVersion} installé`);
  return versionId;
}

// Vérifie que l'installation Forge est complète (client jar présent)
function isForgeComplete(gameDir, mcVersion) {
  const forgeVer = FORGE_VERSIONS[mcVersion];
  if (!forgeVer) return false;
  const clientJar = path.join(gameDir, 'libraries', 'net', 'minecraftforge', 'forge', forgeVer, `forge-${forgeVer}-client.jar`);
  const universalJar = path.join(gameDir, 'libraries', 'net', 'minecraftforge', 'forge', forgeVer, `forge-${forgeVer}-universal.jar`);
  return fs.existsSync(clientJar) || fs.existsSync(universalJar);
}

// Installe Forge
async function installForge(gameDir, mcVersion, javaPath) {
  const forgeVer = FORGE_VERSIONS[mcVersion];
  if (!forgeVer) throw new Error(`Forge non supporté pour ${mcVersion}`);

  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVer}/forge-${forgeVer}-installer.jar`;
  const installerPath = path.join(app.getPath('temp'), `forge-installer-${mcVersion}.jar`);

  send(`⬇ Téléchargement installer Forge ${mcVersion}...`);
  await downloadFile(installerUrl, installerPath);

  const stat = fs.statSync(installerPath);
  if (stat.size < 10000) {
    try { fs.unlinkSync(installerPath); } catch(e) {}
    throw new Error('Installer Forge corrompu');
  }

  send(`⚙ Installation Forge ${mcVersion}... (2-3 min)`);

  // Vieux Forge (1.9.4-1.12.2) : GUI only, cwd=gameDir
  // Nouveaux Forge (1.14.4+) : --installClient
  const oldForgeVersions = ['1.8.9', '1.9.4', '1.10.2', '1.11.2', '1.12.2'];
  const isOld = oldForgeVersions.includes(mcVersion);
  const javaArgs = isOld
    ? ['-Djava.net.preferIPv4Stack=true', '-jar', installerPath]
    : ['-jar', installerPath, '--installClient', gameDir];

  if (isOld) send('⚠ Une fenetre va s ouvrir - clique sur "Install client" puis OK');

  await new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn(javaPath, javaArgs, {
      stdio: 'pipe',
      windowsHide: false,
      cwd: gameDir
    });
    const killTimer = setTimeout(() => { proc.kill(); reject(new Error('Forge timeout 5min')); }, 300000);
    proc.stdout.on('data', d => { const l = d.toString().trim(); if (l) send(l); });
    proc.stderr.on('data', d => { const l = d.toString().trim(); if (l) send(l); });
    proc.on('close', code => {
      clearTimeout(killTimer);
      try { fs.unlinkSync(installerPath); } catch(e) {}
      if (code === 0) { send(`✓ Forge ${mcVersion} installé !`); resolve(); }
      else reject(new Error(`Forge installer code ${code}`));
    });
    proc.on('error', err => {
      clearTimeout(killTimer);
      try { fs.unlinkSync(installerPath); } catch(e) {}
      reject(new Error(`Erreur java : ${err.message}`));
    });
  });
}

function resolveModSourcePath(srcMods, mod) {
  const primary = path.join(srcMods, mod.file);
  if (fs.existsSync(primary)) return primary;
  const alts = mod.altFiles;
  if (Array.isArray(alts)) {
    for (const name of alts) {
      const p = path.join(srcMods, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// LANCEMENT PRINCIPAL
ipcMain.on('launch-minecraft', async (event, { username, version, gameDir, ram, mods, loaderType, noLag }) => {
  try {
    // 1. Préparer dossier et mods
    const gameDirectory = path.join(gameDir, 'vibelauncher', version);
    const modsDir = path.join(gameDirectory, 'mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

    for (const f of fs.readdirSync(modsDir)) {
      try { fs.unlinkSync(path.join(modsDir, f)); } catch(e) {}
    }

    const srcMods = path.join(__dirname, 'mods', version);
    let copied = 0;
    if (fs.existsSync(srcMods)) {
      for (const mod of mods) {
        if (!mod.enabled) continue;
        const src = resolveModSourcePath(srcMods, mod);
        if (src) {
          fs.copyFileSync(src, path.join(modsDir, mod.file));
          copied++;
          if (path.basename(src) !== mod.file) {
            send(`✓ Mod ${mod.file} ← ${path.basename(src)}`);
          }
        } else {
          send(`⚠ Mod introuvable : ${mod.file}`);
        }
      }
    }
    send(`✓ ${copied} mod(s) copié(s)`);

    // 2. Obtenir le bon Java (installe si besoin)
    const javaPath = await getJavaForVersion(version);
    send(`☕ Java : ${javaPath}`);

    // 3. Installer loader si absent
    let launchVersion;
    if (loaderType === 'fabric') {
      const fabricLoaderVer = await getFabricLoaderVersion();
      send(`✓ Fabric Loader stable : ${fabricLoaderVer}`);
      launchVersion = findFabricVersion(gameDir, version, fabricLoaderVer);
      if (!launchVersion) {
        send(`🔧 Installation Fabric ${version}...`);
        launchVersion = await installFabric(gameDir, version);
      } else {
        send(`✓ Fabric : ${launchVersion}`);
      }
    } else {
      launchVersion = findForgeVersion(gameDir, version);
      if (!launchVersion || !isForgeComplete(gameDir, version)) {
        if (launchVersion && !isForgeComplete(gameDir, version)) {
          send(`⚠ Forge ${version} incomplet, réinstallation...`);
          // Supprimer l'ancienne version Forge incomplète
          const badDir = path.join(gameDir, 'versions', launchVersion);
          try { require('fs').rmSync(badDir, { recursive: true }); } catch(e) {}
        } else {
          send(`🔧 Installation Forge ${version}...`);
        }
        await installForge(gameDir, version, javaPath);
        launchVersion = findForgeVersion(gameDir, version);
        if (!launchVersion) throw new Error('Forge installé mais version introuvable');
      } else {
        send(`✓ Forge : ${launchVersion}`);
      }
    }

    send(`▶ Lancement ${launchVersion}...`);

    // 4. Lancer Minecraft
    const launcher = new Client();

    // Auth : recharger depuis fichier pour être sûr d'avoir le bon compte
    const savedAccount = loadMsAccount();
    if (savedAccount) msAuthAccount = savedAccount;

    let authorization;
    if (msAuthAccount && msAuthAccount.access_token && !msAuthAccount.access_token.startsWith('offline_')) {
      send(`✓ Compte Microsoft : ${msAuthAccount.name}`);
      // Format exact attendu par minecraft-launcher-core
      authorization = {
        access_token: msAuthAccount.access_token,
        client_token: msAuthAccount.client_token || msAuthAccount.uuid,
        uuid: msAuthAccount.uuid,
        name: msAuthAccount.name,
        user_properties: '{}'
      };
    } else {
      send(`⚠ Mode hors ligne : ${username}`);
      const crypto = require('crypto');
      const hash = crypto.createHash('md5').update('OfflinePlayer:' + username).digest('hex');
      const uuid = [
        hash.substring(0, 8),
        hash.substring(8, 12),
        '3' + hash.substring(13, 16),
        ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.substring(18, 20),
        hash.substring(20, 32)
      ].join('-');
      authorization = { access_token: uuid, client_token: uuid, uuid, name: username, user_properties: '{}' };
    }
    const useJava8 = (JAVA_REQUIREMENTS[version] || 21) === 8;
    const baseJvm = useJava8
      ? ['-Dfml.ignoreInvalidMinecraftCertificates=true', '-Dfml.ignorePatchDiscrepancies=true']
      : [
          '--add-opens', 'java.base/java.nio=ALL-UNNAMED',
          '--add-opens', 'java.base/sun.nio.ch=ALL-UNNAMED',
          '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
          '--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED',
          '--add-opens', 'java.base/java.io=ALL-UNNAMED',
          '--add-opens', 'java.base/java.util=ALL-UNNAMED',
          '-Dfml.ignoreInvalidMinecraftCertificates=true',
          '-Dfml.ignorePatchDiscrepancies=true'
        ];

    const noLagEnabled = noLag !== false;
    const noLagJvm = noLagEnabled ? [
      '-XX:+UseG1GC',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:MaxGCPauseMillis=50',
      '-XX:+ParallelRefProcEnabled',
      '-XX:+UseStringDeduplication',
      '-Dfml.readTimeout=180',
    ] : [];

    const forgeJvmArgs = [...baseJvm, ...noLagJvm];
    if (noLagEnabled) send('⚡ Mode No-Lag : JVM (G1GC, pauses courtes, FML readTimeout)');

    const opts = {
      authorization,
      root: gameDir,
      version: { number: version, type: 'release', custom: launchVersion },
      memory: { max: `${ram}G`, min: '512M' },
      overrides: {
        gameDirectory: gameDirectory,
        java: javaPath,   // minecraft-launcher-core v3
        exec: javaPath,   // fallback nom alternatif
        javaArgs: forgeJvmArgs
      }
    };

    launcher.on('debug', e => send(e));
    launcher.on('data', e => send(e));
    launcher.on('progress', e => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('launch-progress', e);
    });
    launcher.on('close', code => {
      if (code === 0) send(`✓ Minecraft fermé proprement`);
      else send(`❌ Minecraft fermé avec erreur (code ${code})`);
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('launch-close', code);
    });

    // Forcer JAVA_HOME et PATH pour que minecraft-launcher-core utilise Java 21
    process.env.JAVA_HOME = path.dirname(path.dirname(javaPath));
    process.env.PATH = path.dirname(javaPath) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH;
    send(`☕ JAVA_HOME forcé : ${process.env.JAVA_HOME}`);

    mainWindow.webContents.send('launch-started');

    launcher.launch(opts).catch(err => {
      send(`❌ Erreur lancement : ${err.message}`);
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('launch-error', err.message);
    });

  } catch (err) {
    send(`❌ Erreur : ${err.message}`);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('launch-error', err.message);
  }
});
