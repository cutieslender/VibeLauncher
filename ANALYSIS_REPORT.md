# VibeLauncher — Rapport d'Analyse Complet

## 1 — Architecture Actuelle

### Structure des fichiers
```
VibeLauncher/
├── main.js          ← Process principal Electron (951 lignes)
├── index.html       ← UI MONOLITHIQUE (8939 lignes, 430 KB)
├── package.json     ← Config Electron + dépendances
├── background.png   ← Image de fond (124 KB)
├── icon.ico / .png  ← Icônes
├── logo.webp        ← Logo
├── mods/            ← 80 MB de mods embarqués
│   ├── 1.9.4/       ← Forge mods (OptiFine, VibeMod, BetterFps)
│   ├── 1.10.2/
│   ├── 1.11.2/
│   ├── 1.12.2/
│   ├── 1.14.4/
│   ├── 1.15.2/
│   ├── 1.16.5/      ← Fabric mods (9 mods)
│   ├── 1.17.1/      ← Fabric mods (8 mods)
│   ├── 1.18.2/      ← Fabric mods (12 mods)
│   ├── 1.19.4/      ← Fabric mods (11 mods)
│   ├── 1.20.6/      ← Fabric mods (11 mods)
│   └── 1.21.11/     ← Fabric mods (9 mods)
└── README.md
```

### Stack technique
- **Runtime** : Electron 28 (Chromium + Node.js)
- **Dépendances** : minecraft-launcher-core v3, fs-extra
- **Build** : electron-builder
- **UI** : HTML/CSS/JS pur inline (pas de framework)
- **Auth** : Microsoft OAuth2 via login.live.com

### Fonctionnalités détectées (46+ pages)
| Catégorie | Pages |
|-----------|-------|
| **Core** | Play, Mods, Settings, Profiles |
| **Social** | Community (Discord), Servers, Credits |
| **Gestion** | Saves, Screenshots, Resource Packs, Stats, Skin, Logs, Cleaner |
| **Personnalisation** | Themes (18), Wallpapers, Langue (i18n) |
| **Divertissement** | Mine Clicker, Snake, Candy Crush, Pong, 2048, Chess, Parkour, Flappy, Asteroid, Breakout, Frogger, Pac-Man, Connect 4, Billard, Fishing, Penalty, Basket, Rhythm Click, Note Rush, Star Stage, Mini Golf, Solitaire, Darts, Idle Café, Minesweeper, Uno, Bataille, Zen Garden, Precision, Reaction, Pixel Art, CPS Counter |
| **Autre** | Changelog, About, Grades, Music, Achievements |

---

## 2 — Problèmes Détectés

### CRITIQUE — Sécurité
| # | Problème | Impact | Fichier |
|---|----------|--------|---------|
| S1 | `nodeIntegration: true` + `contextIsolation: false` | **Faille XSS critique** : tout code JS dans le renderer a accès complet au système de fichiers, aux processus, etc. | main.js:200 |
| S2 | Tokens MS stockés en clair dans un JSON | Les tokens d'authentification Microsoft sont sauvegardés sans chiffrement | main.js:14 |
| S3 | `exec()` utilisé sans sanitization | Injection de commandes possible si les chemins contiennent des caractères spéciaux | main.js:547 |
| S4 | Pas de Content-Security-Policy | Aucune politique CSP définie | index.html |

### CRITIQUE — Compatibilité multiplateforme
| # | Problème | Impact | Fichier |
|---|----------|--------|---------|
| P1 | `java.exe` hardcodé | Ne fonctionne **que sur Windows** | main.js:559 |
| P2 | PowerShell pour extraction ZIP | `Expand-Archive` = Windows seulement | main.js:547 |
| P3 | Chemins Windows hardcodés | `C:\\Program Files\\...` dans findSystemJava() | main.js:671-693 |
| P4 | Linux icon `.ico` au lieu de `.png` | electron-builder attend `.png` pour Linux | package.json:50 |
| P5 | Pas de gestion macOS sandbox | Aucun entitlement configuré | package.json |

### MAJEUR — Architecture
| # | Problème | Impact |
|---|----------|--------|
| A1 | **Fichier HTML monolithique de 8939 lignes (430 KB)** | Impossible à maintenir, pas de séparation des responsabilités |
| A2 | 209 fonctions JS dans un seul scope global | Collisions de noms, pollution du scope, impossible à tester |
| A3 | CSS inline (~1600 lignes) sans variables sémantiques | Duplication massive, thèmes fragiles |
| A4 | 80 MB de JARs dans le repo Git | Le repo est gonflé, clone lent, pas de versioning des mods |
| A5 | Pas de système de modules (CommonJS, ESM) | Tout est dans le scope global |
| A6 | IPC synchrone (`sendSync`) bloque le renderer | Freezes UI pendant les opérations fichier |

### MODÉRÉ — Performance
| # | Problème | Impact |
|---|----------|--------|
| F1 | Toutes les 46+ pages sont rendues au chargement | DOM énorme, mémoire gaspillée |
| F2 | Pas de lazy loading des mini-jeux | ~3000 lignes de code de jeux chargées inutilement |
| F3 | Google Fonts chargé sans fallback | Pas d'accès offline aux polices |
| F4 | `getDirSize()` récursif synchrone | Bloque le main process pour les gros dossiers |
| F5 | Pas de cache pour les assets téléchargés | Re-téléchargement inutile |

### MODÉRÉ — Code Quality
| # | Problème | Impact |
|---|----------|--------|
| Q1 | Gestion d'erreurs catch-and-ignore | `catch(e) {}` partout — erreurs silencieuses |
| Q2 | Pas de TypeScript | Pas de type safety |
| Q3 | Pas de linter/formatter | Style inconsistant |
| Q4 | Code dupliqué (save/load pattern répété 15+ fois) | Chaque feature a son propre save/load quasi identique |
| Q5 | `require()` à l'intérieur de fonctions | Imports non-standards, confusion des dépendances |

---

## 3 — Améliorations Proposées

### 3.1 — Sécurité (Priorité 1)
1. **Activer `contextIsolation: true`** et utiliser un `preload.js` avec `contextBridge`
2. **Chiffrer les tokens** avec `safeStorage` d'Electron
3. **Ajouter une CSP** stricte dans le HTML
4. **Sanitizer tous les chemins** passés à `exec()`

### 3.2 — Multiplateforme (Priorité 1)
1. **Remplacer `java.exe`** par détection dynamique (`java` sur Unix, `java.exe` sur Windows)
2. **Remplacer PowerShell** par `adm-zip` ou `yauzl` (extraction ZIP native Node.js)
3. **Créer `findSystemJava()` multiplateforme** (Linux: `/usr/lib/jvm`, macOS: `/Library/Java`)
4. **Configurer les icons** correctement par plateforme (`.icns` pour macOS, `.png` pour Linux)
5. **Ajouter les entitlements macOS** pour le sandbox

### 3.3 — Architecture (Priorité 2)
1. **Séparer le HTML en composants** : un fichier par page
2. **Extraire le CSS** dans des fichiers séparés par module
3. **Modulariser le JS** avec un système de modules
4. **Créer un `preload.js`** pour l'IPC bridge sécurisé
5. **Externaliser les mods** du repo (téléchargement à la demande)

### 3.4 — Thèmes (Priorité 2)
1. **Créer 6 thèmes avancés** avec effets visuels complets :
   - Dark (sobre, professionnel)
   - Neon (cyberpunk léger, glows intenses)
   - Cyberpunk (jaune/rouge, glitch effects)
   - Minimal (clean, sans effets)
   - **Astolfo / Femboy** (rose/violet/noir, inspiré des images fournies)
   - **RGB Animated** (cycle arc-en-ciel amélioré avec gradients)
2. **Fichiers JSON** configurables par l'utilisateur
3. **Animations de background** par thème
4. **Typographie et icônes** personnalisées par thème

### 3.5 — Performance (Priorité 3)
1. **Lazy loading** des pages et mini-jeux
2. **Convertir les IPC synchrones** en asynchrones
3. **Bundler les polices** en local
4. **Worker threads** pour les opérations fichier lourdes

### 3.6 — Compression (Priorité 3)
1. **Minifier** HTML/CSS/JS pour le build
2. **Compresser les mods** avec Zstandard
3. **Utiliser ASAR** d'Electron correctement (exclure les mods)

---

## 4 — Architecture Cible

```
vibelauncher/
├── src/
│   ├── main/
│   │   ├── main.js              ← Process principal (refactorisé)
│   │   ├── preload.js           ← Bridge IPC sécurisé
│   │   ├── core/
│   │   │   ├── java-manager.js  ← Gestion Java multiplateforme
│   │   │   ├── auth.js          ← Microsoft OAuth (chiffré)
│   │   │   ├── downloader.js    ← Téléchargement avec retry/cache
│   │   │   ├── forge.js         ← Installation Forge
│   │   │   ├── fabric.js        ← Installation Fabric
│   │   │   ├── launcher.js      ← Lancement MC
│   │   │   └── storage.js       ← Persistance unifiée
│   │   └── utils/
│   │       ├── paths.js         ← Chemins multiplateforme
│   │       ├── zip.js           ← Extraction ZIP native
│   │       └── platform.js      ← Détection OS/arch
│   ├── renderer/
│   │   ├── index.html           ← Shell HTML minimal
│   │   ├── app.js               ← Point d'entrée renderer
│   │   ├── styles/
│   │   │   ├── base.css         ← Reset + variables
│   │   │   ├── layout.css       ← Sidebar + grid
│   │   │   ├── components.css   ← Boutons, cartes, modals
│   │   │   └── animations.css   ← Transitions GPU
│   │   ├── pages/               ← Un fichier par page
│   │   │   ├── play.js
│   │   │   ├── mods.js
│   │   │   ├── settings.js
│   │   │   └── ...
│   │   └── games/               ← Mini-jeux (lazy loaded)
│   │       ├── snake.js
│   │       ├── chess.js
│   │       └── ...
│   └── themes/
│       ├── dark.json
│       ├── neon.json
│       ├── cyberpunk.json
│       ├── minimal.json
│       ├── astolfo.json
│       └── rgb-animated.json
├── assets/
│   ├── fonts/                   ← Polices bundlées
│   ├── icons/                   ← Icônes par thème
│   └── backgrounds/             ← Fonds par thème
├── mods/                        ← Mods (gitignored, téléchargement auto)
├── build/
│   ├── electron-builder.yml     ← Config build multiplateforme
│   ├── entitlements.mac.plist   ← macOS entitlements
│   └── scripts/                 ← Scripts de build
├── config/
│   └── default-settings.json    ← Paramètres par défaut
├── package.json
└── README.md
```

---

## 5 — Estimation d'effort

| Tâche | Complexité | Temps estimé |
|-------|-----------|-------------|
| Fix sécurité (preload + CSP) | Moyenne | 4-6h |
| Compatibilité multiplateforme | Haute | 8-12h |
| Refactoring architecture | Très haute | 20-30h |
| 6 thèmes avancés | Moyenne | 6-10h |
| Lazy loading + perf | Moyenne | 4-6h |
| Build multiplateforme | Moyenne | 3-4h |
| Tests + documentation | Moyenne | 4-6h |
| **Total** | | **~50-75h** |

---

*Rapport généré par analyse complète du repository github.com/cutieslender/VibeLauncher*
