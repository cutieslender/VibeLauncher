# VibeLauncher v2.0 — Documentation Développeur

## Guide de Migration v1 → v2

### Changements Breaking

#### 1. Sécurité: `contextIsolation` activé
L'ancien code utilisait `nodeIntegration: true` ce qui donnait un accès total au système depuis le renderer. C'est désormais désactivé.

**Avant (v1) — dans index.html:**
```javascript
const { ipcRenderer } = require('electron');
ipcRenderer.send('save-theme', theme);
const data = ipcRenderer.sendSync('load-servers');
```

**Après (v2) — via le bridge `preload.js`:**
```javascript
// L'API est exposée via window.vibe
await window.vibe.themes.save(theme);
const data = await window.vibe.servers.load();
```

#### 2. Plus de `sendSync` — tout est async
Tous les IPC sont maintenant asynchrones via `ipcMain.handle` / `ipcRenderer.invoke`.

**Migration pattern:**
```javascript
// Ancien: synchrone (bloquait l'UI)
ipcRenderer.sendSync('load-servers');

// Nouveau: async (non-bloquant)
const data = await window.vibe.servers.load();
```

#### 3. Tokens chiffrés
Les tokens Microsoft sont maintenant stockés via `safeStorage` d'Electron au lieu d'un JSON en clair.

#### 4. Thèmes JSON
Les thèmes sont maintenant des fichiers JSON dans `src/themes/` au lieu d'un objet hardcodé.

---

## Architecture v2

```
src/
├── main/                      # Process principal Electron
│   ├── main.js                # Point d'entrée (refactorisé)
│   ├── preload.js             # Bridge IPC sécurisé
│   └── core/
│       ├── platform.js        # Utils multiplateforme (Java, ZIP, chemins)
│       └── storage.js         # Storage unifié + chiffrement
├── renderer/
│   └── index.html             # UI (à refactoriser progressivement)
└── themes/
    ├── theme-engine.js        # Moteur de thèmes dynamique
    ├── astolfo.json           # Thème Astolfo ♡
    ├── dark.json              # Thème Dark
    ├── neon.json              # Thème Neon
    ├── cyberpunk.json         # Thème Cyberpunk
    ├── minimal.json           # Thème Minimal (light)
    └── rgb-animated.json      # Thème RGB animé
```

---

## Système de Thèmes

### Structure d'un thème JSON

```json
{
  "id": "mon-theme",
  "name": "Mon Thème",
  "description": "Description courte",
  
  "colors": {
    "bg": "#080b0f",
    "surface": "rgba(15, 19, 24, 0.95)",
    "accent": "#00d4ff",
    "text": "#e8f4f8"
  },
  
  "rgb": { "r": 0, "g": 212, "b": 255 },
  
  "background": {
    "type": "gradient-animated",
    "particles": { "enabled": true, "type": "dots", "count": 20 }
  },
  
  "effects": {
    "glassmorphism": true,
    "blur": "12px",
    "borderGlow": true
  },
  
  "animations": {
    "pulse": {
      "name": "my-pulse",
      "css": "@keyframes my-pulse { ... }",
      "duration": "3s"
    }
  },
  
  "customCSS": [
    ".element { color: red; }"
  ]
}
```

### Utilisation du ThemeEngine

```javascript
const ThemeEngine = require('./themes/theme-engine');
const engine = new ThemeEngine();

// Charger les thèmes builtin (rétrocompat ancien système)
engine.loadBuiltinThemes();

// Charger les thèmes JSON
engine.loadThemesFromDir('./src/themes');

// Appliquer un thème
engine.apply('astolfo');

// Lister les thèmes
console.log(engine.list());

// Thème actuel
console.log(engine.getCurrent()); // 'astolfo'
```

### Créer un thème custom

1. Créer un fichier `src/themes/mon-theme.json`
2. Suivre la structure JSON ci-dessus
3. Le thème sera automatiquement disponible au prochain lancement

---

## Compatibilité Multiplateforme

### Détection Java

Le module `platform.js` détecte Java sur toutes les plateformes:

| OS | Chemins recherchés |
|----|--------------------|
| Windows | `C:\Program Files\Eclipse Adoptium`, `C:\Program Files\Java`, etc. |
| macOS | `/Library/Java/JavaVirtualMachines`, Homebrew, etc. |
| Linux | `/usr/lib/jvm`, `/opt/java`, SDKMAN, etc. |

### Extraction ZIP

| OS | Méthode |
|----|---------|
| Windows | PowerShell `Expand-Archive` |
| macOS | `ditto -x -k` (préserve les attributs) |
| Linux | `unzip` ou `tar` selon le format |

### Build

```bash
# Windows
npm run build:win    # → dist/VibeLauncher-2.0.0-win-x64.exe

# Linux
npm run build:linux  # → dist/VibeLauncher-2.0.0-linux-x64.AppImage
                     #   dist/VibeLauncher-2.0.0-linux-x64.deb

# macOS
npm run build:mac    # → dist/VibeLauncher-2.0.0-mac-x64.dmg
                     #   dist/VibeLauncher-2.0.0-mac-arm64.dmg

# Tout
npm run build:all
```

### Notes macOS
- Les entitlements sont dans `build/entitlements.mac.plist`
- Le hardened runtime est activé pour la signature
- Les builds ARM64 (Apple Silicon) et x64 (Intel) sont générés

---

## API IPC (preload.js)

Toute communication renderer ↔ main passe par `window.vibe`:

| Domaine | Méthode | Description |
|---------|---------|-------------|
| `vibe.window` | `.minimize()`, `.maximize()`, `.close()` | Contrôles fenêtre |
| `vibe.auth` | `.login()`, `.logout()`, `.getAccount()` | Auth Microsoft |
| `vibe.settings` | `.save(obj)`, `.load()` | Paramètres |
| `vibe.launch` | `.start(opts)`, `.onLog(cb)`, `.onProgress(cb)` | Lancement MC |
| `vibe.themes` | `.save(id)`, `.load()` | Persistance thème |
| `vibe.saves` | `.listWorlds(dir)`, `.backupWorld(dir, name)` | Sauvegardes |
| `vibe.servers` | `.save(data)`, `.load()` | Serveurs |
| `vibe.utils` | `.openPath(p)`, `.openUrl(url)` | Utilitaires |

---

## Problèmes connus et TODO

### Phase 2 (à faire)
- [ ] Séparer `index.html` (8939 lignes) en composants modulaires
- [ ] Lazy loading des 30+ mini-jeux
- [ ] Worker threads pour les opérations fichier lourdes
- [ ] Cache des assets téléchargés (Java, Forge installer)
- [ ] Tests unitaires
- [ ] TypeScript migration

### Phase 3 (futur)
- [ ] Auto-updater intégré
- [ ] Téléchargement des mods à la demande (CDN)
- [ ] Système de plugins
- [ ] Profils cloud sync
