/**
 * VibeLauncher — Unified Storage
 * 
 * Remplace les 15+ patterns save/load dupliqués par un système unifié.
 * Ajoute le support de chiffrement pour les données sensibles (tokens).
 */
const path = require('path');
const fs = require('fs');
const { app, safeStorage } = require('electron');

class Storage {
  constructor() {
    this.basePath = app.getPath('userData');
  }

  /**
   * Sauvegarde un objet JSON dans un fichier
   * @param {string} key - Nom du fichier (sans extension)
   * @param {*} data - Données à sauvegarder
   */
  save(key, data) {
    try {
      const filePath = path.join(this.basePath, `${key}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error(`[Storage] Erreur save ${key}:`, e.message);
      return false;
    }
  }

  /**
   * Charge un objet JSON depuis un fichier
   * @param {string} key - Nom du fichier (sans extension)
   * @param {*} fallback - Valeur par défaut si le fichier n'existe pas
   */
  load(key, fallback = null) {
    try {
      const filePath = path.join(this.basePath, `${key}.json`);
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`[Storage] Erreur load ${key}:`, e.message);
      return fallback;
    }
  }

  /**
   * Supprime un fichier de stockage
   * @param {string} key - Nom du fichier (sans extension)
   */
  delete(key) {
    try {
      const filePath = path.join(this.basePath, `${key}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return true;
    } catch (e) {
      console.error(`[Storage] Erreur delete ${key}:`, e.message);
      return false;
    }
  }

  /**
   * Sauvegarde des données sensibles (chiffrement Electron)
   * Utilise safeStorage si disponible, sinon fallback en clair avec warning
   */
  saveSecure(key, data) {
    try {
      const filePath = path.join(this.basePath, `${key}.enc`);
      const json = JSON.stringify(data);
      
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(json);
        fs.writeFileSync(filePath, encrypted);
      } else {
        // Fallback: base64 (pas sécurisé mais mieux que rien)
        console.warn(`[Storage] safeStorage indisponible — ${key} stocké en base64`);
        const fileFallback = path.join(this.basePath, `${key}.json`);
        fs.writeFileSync(fileFallback, Buffer.from(json).toString('base64'), 'utf8');
      }
      return true;
    } catch (e) {
      console.error(`[Storage] Erreur saveSecure ${key}:`, e.message);
      return false;
    }
  }

  /**
   * Charge des données sensibles (déchiffrement Electron)
   */
  loadSecure(key, fallback = null) {
    try {
      const filePath = path.join(this.basePath, `${key}.enc`);
      
      if (fs.existsSync(filePath) && safeStorage.isEncryptionAvailable()) {
        const encrypted = fs.readFileSync(filePath);
        const json = safeStorage.decryptString(encrypted);
        return JSON.parse(json);
      }
      
      // Fallback: essayer le fichier base64
      const fileFallback = path.join(this.basePath, `${key}.json`);
      if (fs.existsSync(fileFallback)) {
        const content = fs.readFileSync(fileFallback, 'utf8');
        try {
          // Essayer base64 d'abord
          return JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
        } catch {
          // Sinon JSON direct (migration depuis l'ancien format)
          return JSON.parse(content);
        }
      }
      
      return fallback;
    } catch (e) {
      console.error(`[Storage] Erreur loadSecure ${key}:`, e.message);
      return fallback;
    }
  }

  deleteSecure(key) {
    try {
      ['.enc', '.json'].forEach(ext => {
        const fp = path.join(this.basePath, `${key}${ext}`);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });
      return true;
    } catch (e) { return false; }
  }
}

module.exports = new Storage();
