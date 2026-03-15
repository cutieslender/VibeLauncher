/**
 * VibeLauncher — Platform Utilities
 * 
 * Gestion multiplateforme des chemins, Java, et extraction ZIP.
 * Compatible: Windows / macOS / Linux
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// ==================== PLATFORM DETECTION ====================

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

/**
 * Nom de l'exécutable Java selon la plateforme
 */
function javaExeName() {
  return IS_WIN ? 'java.exe' : 'java';
}

// ==================== PATHS ====================

/**
 * Retourne le dossier .minecraft par défaut selon l'OS
 */
function getDefaultMinecraftDir() {
  const home = os.homedir();
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.minecraft');
  if (IS_MAC) return path.join(home, 'Library', 'Application Support', 'minecraft');
  return path.join(home, '.minecraft');
}

/**
 * Séparateur de PATH selon l'OS
 */
function pathSeparator() {
  return IS_WIN ? ';' : ':';
}

// ==================== JAVA DETECTION ====================

/**
 * Cherche l'exécutable Java dans un dossier (récursivement 1 niveau)
 */
function findJavaInDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const exe = javaExeName();
  
  // Chemin direct
  const direct = path.join(dir, 'bin', exe);
  if (fs.existsSync(direct)) return direct;
  
  // Sous-dossiers (Adoptium crée jdk-21.0.x-hotspot/ etc.)
  try {
    for (const entry of fs.readdirSync(dir)) {
      const sub = path.join(dir, entry, 'bin', exe);
      if (fs.existsSync(sub)) return sub;
      
      // macOS: Contents/Home/bin/java
      if (IS_MAC) {
        const macSub = path.join(dir, entry, 'Contents', 'Home', 'bin', exe);
        if (fs.existsSync(macSub)) return macSub;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Cherche Java sur le système (toutes plateformes)
 * @param {number} majorVersion - Version Java requise (8, 17, 21)
 * @returns {string|null} Chemin vers java ou null
 */
function findSystemJava(majorVersion) {
  const patterns = {
    8:  [/^(jdk|jre)[_-]?1\.8/i, /^jdk-8[\.\-]/i, /^temurin-8/i, /^zulu-8/i],
    17: [/^jdk-17[\.\-]/i, /^temurin-17/i, /^zulu-17/i],
    21: [/^jdk-21[\.\-]/i, /^temurin-21/i, /^zulu-21/i],
  };
  const pats = patterns[majorVersion] || [new RegExp(`jdk-${majorVersion}`, 'i')];

  const searchDirs = [];

  if (IS_WIN) {
    searchDirs.push(
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Zulu',
    );
  } else if (IS_MAC) {
    searchDirs.push(
      '/Library/Java/JavaVirtualMachines',
      path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines'),
      '/opt/homebrew/opt/openjdk',
      `/opt/homebrew/opt/openjdk@${majorVersion}`,
    );
  } else { // Linux
    searchDirs.push(
      '/usr/lib/jvm',
      '/usr/local/lib/jvm',
      '/opt/java',
      '/opt/jdk',
      path.join(os.homedir(), '.sdkman', 'candidates', 'java'),
    );
  }

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir).sort().reverse();
      for (const entry of entries) {
        if (pats.some(p => p.test(entry))) {
          const exe = javaExeName();
          
          // Standard: dir/entry/bin/java
          const j = path.join(dir, entry, 'bin', exe);
          if (fs.existsSync(j)) return j;
          
          // macOS JVMs: dir/entry/Contents/Home/bin/java
          if (IS_MAC) {
            const jMac = path.join(dir, entry, 'Contents', 'Home', 'bin', exe);
            if (fs.existsSync(jMac)) return jMac;
          }
        }
      }
    } catch (e) { /* ignore unreadable dirs */ }
  }

  // Dernier recours: vérifier si `java` est dans le PATH
  try {
    const cmd = IS_WIN ? 'where java' : 'which java';
    const result = execSync(cmd, { timeout: 5000, encoding: 'utf8' }).trim();
    if (result) {
      // Vérifier la version
      try {
        const ver = execSync(`"${result}" -version 2>&1`, { timeout: 5000, encoding: 'utf8' });
        if (ver.includes(`"${majorVersion}.`) || ver.includes(`"1.${majorVersion}.`)) {
          return result.split('\n')[0].trim();
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* not in PATH */ }

  return null;
}

/**
 * URL Adoptium API pour télécharger Java
 */
function getAdoptiumUrl(majorVersion) {
  const osName = IS_WIN ? 'windows' : IS_MAC ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  return `https://api.adoptium.net/v3/assets/latest/${majorVersion}/hotspot?image_type=jre&os=${osName}&architecture=${arch}&vendor=eclipse`;
}

/**
 * Extension de l'archive Java selon l'OS
 */
function getJavaArchiveExt() {
  return IS_WIN ? '.zip' : '.tar.gz';
}

// ==================== ZIP EXTRACTION ====================

/**
 * Extrait un fichier archive (ZIP ou tar.gz) de manière multiplateforme
 * @param {string} archivePath - Chemin de l'archive
 * @param {string} destDir - Dossier de destination
 */
async function extractArchive(archivePath, destDir) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  
  const { exec } = require('child_process');
  
  return new Promise((resolve, reject) => {
    let cmd;
    
    if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
      // Unix tar (macOS & Linux)
      cmd = `tar -xzf "${archivePath}" -C "${destDir}"`;
    } else if (archivePath.endsWith('.zip')) {
      if (IS_WIN) {
        // PowerShell sur Windows
        cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`;
      } else if (IS_MAC) {
        // ditto sur macOS (meilleur que unzip pour les attributs)
        cmd = `ditto -x -k "${archivePath}" "${destDir}"`;
      } else {
        // unzip sur Linux
        cmd = `unzip -o -q "${archivePath}" -d "${destDir}"`;
      }
    } else {
      return reject(new Error(`Format d'archive non supporté: ${archivePath}`));
    }
    
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Extraction échouée: ${err.message}`));
      else resolve();
    });
  });
}

// ==================== EXPORT ====================

module.exports = {
  IS_WIN, IS_MAC, IS_LINUX,
  javaExeName,
  getDefaultMinecraftDir,
  pathSeparator,
  findJavaInDir,
  findSystemJava,
  getAdoptiumUrl,
  getJavaArchiveExt,
  extractArchive,
};
