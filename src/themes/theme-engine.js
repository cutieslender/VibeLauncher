/**
 * VibeLauncher — Theme Engine
 * 
 * Moteur de thèmes dynamique qui charge les fichiers JSON de thèmes
 * et les applique au launcher avec animations et effets visuels.
 * 
 * Remplace le système THEMES hardcodé (18 thèmes = 18 objets JS simples)
 * par un système extensible avec :
 *   - Fichiers JSON configurables
 *   - Animations CSS générées
 *   - Effets de particules
 *   - Support des thèmes animés (RGB cycle)
 *   - Glassmorphism, glows, etc.
 * 
 * Usage:
 *   const engine = new ThemeEngine();
 *   await engine.loadThemesFromDir('./themes');
 *   engine.apply('astolfo');
 */

class ThemeEngine {
  constructor() {
    this.themes = new Map();
    this.currentTheme = null;
    this.cycleInterval = null;
    this.cycleIndex = 0;
    this.dynamicStyleEl = null;
    this.animationStyleEl = null;
    this.particleContainer = null;
  }

  // ==================== CHARGEMENT ====================

  /**
   * Enregistre un thème depuis un objet JSON
   */
  register(theme) {
    if (!theme.id) throw new Error('Theme must have an id');
    this.themes.set(theme.id, theme);
  }

  /**
   * Charge tous les thèmes depuis un dossier (Node.js / Electron)
   * @param {string} dirPath - Chemin vers le dossier de thèmes
   */
  loadThemesFromDir(dirPath) {
    const fs = require('fs');
    const path = require('path');
    
    if (!fs.existsSync(dirPath)) {
      console.warn(`[ThemeEngine] Dossier thèmes introuvable: ${dirPath}`);
      return;
    }
    
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
        this.register(data);
        console.log(`[ThemeEngine] Thème chargé: ${data.id} (${data.name})`);
      } catch (e) {
        console.error(`[ThemeEngine] Erreur chargement ${file}:`, e.message);
      }
    }
  }

  /**
   * Charge les thèmes intégrés (fallback si pas de dossier)
   * Inclut les 18 thèmes de l'ancien système + les 6 nouveaux
   */
  loadBuiltinThemes() {
    // Ancien système — thèmes couleur simples (rétrocompatibilité)
    const legacy = {
      blanc:    { r:200,g:200,b:200, accent:'#333333', accent2:'#111111', accent3:'#666666', light:true },
      noir:     { r:100,g:100,b:100, accent:'#e0e0e0', accent2:'#aaaaaa', accent3:'#ffffff' },
      pourpre:  { r:199,g:21,b:133,  accent:'#c71585', accent2:'#8b0057', accent3:'#ff69b4' },
      rouge:    { r:255,g:68,b:68,   accent:'#ff4444', accent2:'#cc2222', accent3:'#ff9999' },
      orange:   { r:255,g:136,b:0,   accent:'#ff8800', accent2:'#cc6600', accent3:'#ffbb66' },
      jaune:    { r:255,g:204,b:0,   accent:'#ffcc00', accent2:'#cc9900', accent3:'#ffe566' },
      vert:     { r:57,g:255,b:20,   accent:'#39ff14', accent2:'#28cc00', accent3:'#88ff66' },
      bleu:     { r:30,g:144,b:255,  accent:'#1e90ff', accent2:'#0066cc', accent3:'#66b8ff' },
      violet:   { r:145,g:70,b:255,  accent:'#9146ff', accent2:'#6e2fff', accent3:'#b88aff' },
      ivoire:   { r:180,g:165,b:130, accent:'#8b7355', accent2:'#6b5335', accent3:'#c4a882', light:true },
      creme:    { r:184,g:134,b:11,  accent:'#b8860b', accent2:'#8b6508', accent3:'#daa520', light:true },
      beige:    { r:160,g:140,b:100, accent:'#8b7355', accent2:'#6b5335', accent3:'#c4a882', light:true },
      rose:     { r:255,g:105,b:180, accent:'#ff69b4', accent2:'#cc4488', accent3:'#ffaacc' },
      kaki:     { r:139,g:148,b:103, accent:'#8b9467', accent2:'#6b7447', accent3:'#b4bc88' },
      brun:     { r:196,g:129,b:58,  accent:'#c4813a', accent2:'#9e5f1e', accent3:'#e8aa6a' },
      marron:   { r:139,g:69,b:19,   accent:'#8b4513', accent2:'#5c2d08', accent3:'#c07040' },
      bordeaux: { r:139,g:26,b:46,   accent:'#8b1a2e', accent2:'#5c0a1a', accent3:'#c04060' },
    };

    for (const [id, colors] of Object.entries(legacy)) {
      this.register({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        description: `Thème ${id}`,
        colors: {
          bg: colors.light ? '#e8e4dc' : '#080b0f',
          accent: colors.accent,
          accent2: colors.accent2,
          accent3: colors.accent3,
          text: colors.light ? '#111111' : '#e8eaf0',
          text2: colors.light ? '#333333' : '#b0b8cc',
          text3: colors.light ? '#666666' : '#6a7490',
        },
        rgb: { r: colors.r, g: colors.g, b: colors.b },
        light: !!colors.light,
        customCSS: [],
      });
    }
  }

  // ==================== APPLICATION ====================

  /**
   * Applique un thème par son ID
   * @param {string} themeId - ID du thème à appliquer
   */
  apply(themeId) {
    const theme = this.themes.get(themeId);
    if (!theme) {
      console.warn(`[ThemeEngine] Thème inconnu: ${themeId}`);
      return false;
    }

    // Arrêter le cycle RGB si actif
    this._stopCycle();

    this.currentTheme = themeId;
    const root = document.documentElement;

    // 1. Appliquer les couleurs CSS variables
    if (theme.colors) {
      for (const [key, value] of Object.entries(theme.colors)) {
        const cssVar = `--${key.replace(/_/g, '-')}`;
        root.style.setProperty(cssVar, value);
      }
    }

    // 2. Calculer les surfaces dynamiques depuis RGB
    if (theme.rgb) {
      const { r, g, b } = theme.rgb;
      
      if (!theme.light && !theme.colors?.surface) {
        root.style.setProperty('--surface', `rgba(${Math.floor(r*0.04)},${Math.floor(g*0.04)},${Math.floor(b*0.06)},0.95)`);
        root.style.setProperty('--surface2', `rgba(${Math.floor(r*0.06)},${Math.floor(g*0.06)},${Math.floor(b*0.09)},0.9)`);
        root.style.setProperty('--surface3', `rgba(${Math.floor(r*0.1)},${Math.floor(g*0.1)},${Math.floor(b*0.14)},0.9)`);
        root.style.setProperty('--border', `rgba(${r},${g},${b},0.18)`);
      }

      root.style.setProperty('--glow', theme.colors?.glow || `0 0 20px rgba(${r},${g},${b},0.3)`);
      root.style.setProperty('--glow-strong', theme.colors?.glow_strong || `0 0 40px rgba(${r},${g},${b},0.5)`);
    }

    // 3. Appliquer les thèmes clairs
    if (theme.light) {
      root.style.setProperty('--bg', theme.colors?.bg || '#e8e4dc');
      root.style.setProperty('--surface', theme.colors?.surface || 'rgba(255,255,255,0.7)');
      root.style.setProperty('--surface2', theme.colors?.surface2 || 'rgba(240,235,225,0.95)');
      root.style.setProperty('--surface3', theme.colors?.surface3 || 'rgba(220,215,200,0.95)');
      root.style.setProperty('--border', theme.colors?.border || 'rgba(0,0,0,0.15)');
      root.style.setProperty('--text', theme.colors?.text || '#111111');
      root.style.setProperty('--text2', theme.colors?.text2 || '#333333');
      root.style.setProperty('--text3', theme.colors?.text3 || '#666666');
    }

    // 4. Injecter les animations CSS
    this._injectAnimations(theme);

    // 5. Injecter le CSS custom du thème
    this._injectCustomCSS(theme);

    // 6. Mettre à jour les éléments dynamiques
    this._updateDynamicElements(theme);

    // 7. Démarrer le cycle RGB si nécessaire
    if (theme.cycle?.enabled) {
      this._startCycle(theme);
    }

    // 8. Particules
    if (theme.background?.particles?.enabled) {
      this._startParticles(theme.background.particles);
    } else {
      this._stopParticles();
    }

    return true;
  }

  // ==================== INTERNALS ====================

  _getDynamicStyleEl() {
    if (!this.dynamicStyleEl) {
      this.dynamicStyleEl = document.createElement('style');
      this.dynamicStyleEl.id = 'theme-engine-dynamic';
      document.head.appendChild(this.dynamicStyleEl);
    }
    return this.dynamicStyleEl;
  }

  _getAnimationStyleEl() {
    if (!this.animationStyleEl) {
      this.animationStyleEl = document.createElement('style');
      this.animationStyleEl.id = 'theme-engine-animations';
      document.head.appendChild(this.animationStyleEl);
    }
    return this.animationStyleEl;
  }

  _injectAnimations(theme) {
    const el = this._getAnimationStyleEl();
    let css = '';
    
    if (theme.animations) {
      for (const anim of Object.values(theme.animations)) {
        if (anim.css) css += anim.css + '\n';
      }
    }
    
    // Animation de fond commune (utilisée par plusieurs thèmes)
    css += `
      @keyframes astolfo-bg-shimmer {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
    `;
    
    el.textContent = css;
  }

  _injectCustomCSS(theme) {
    const el = this._getDynamicStyleEl();
    let css = '';

    if (theme.customCSS && Array.isArray(theme.customCSS)) {
      css = theme.customCSS.join('\n');
    }

    // CSS commun pour le scrollbar et la sélection
    if (theme.rgb) {
      const { r, g, b } = theme.rgb;
      css += `
        ::-webkit-scrollbar-thumb { background: rgba(${r},${g},${b},0.35) !important; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(${r},${g},${b},0.6) !important; }
      `;
    }

    el.textContent = css;
  }

  _updateDynamicElements(theme) {
    const { r, g, b } = theme.rgb || { r: 0, g: 212, b: 255 };

    // Logo glow
    const logo = document.querySelector('.logo-main h1');
    if (logo) {
      logo.style.textShadow = theme.sidebar?.logoShadow || `0 0 30px rgba(${r},${g},${b},0.8)`;
    }

    // Logo separator
    const sep = document.querySelector('.logo-sep');
    if (sep) {
      sep.style.background = `linear-gradient(90deg, transparent, ${theme.colors?.accent || '#00d4ff'}, transparent)`;
    }

    // Sidebar
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      sidebar.style.background = theme.sidebar?.background || `rgba(${Math.floor(r*0.03)},${Math.floor(g*0.03)},${Math.floor(b*0.05)},0.7)`;
    }
  }

  // ==================== RGB CYCLE ====================

  _startCycle(theme) {
    const colors = theme.cycle.colors;
    const speed = theme.cycle.speed || 2000;
    
    this.cycleIndex = 0;
    this.cycleInterval = setInterval(() => {
      const c = colors[this.cycleIndex % colors.length];
      this.cycleIndex++;

      const root = document.documentElement;
      root.style.setProperty('--accent', c.accent);
      root.style.setProperty('--accent2', c.accent2);
      root.style.setProperty('--accent3', c.accent3);
      root.style.setProperty('--glow', `0 0 25px rgba(${c.r},${c.g},${c.b},0.3)`);
      root.style.setProperty('--glow-strong', `0 0 50px rgba(${c.r},${c.g},${c.b},0.5)`);
      root.style.setProperty('--border', `rgba(${c.r},${c.g},${c.b},0.18)`);
      root.style.setProperty('--surface', `rgba(${Math.floor(c.r*0.04)},${Math.floor(c.g*0.04)},${Math.floor(c.b*0.06)},0.95)`);
      root.style.setProperty('--surface2', `rgba(${Math.floor(c.r*0.06)},${Math.floor(c.g*0.06)},${Math.floor(c.b*0.09)},0.9)`);
      root.style.setProperty('--surface3', `rgba(${Math.floor(c.r*0.1)},${Math.floor(c.g*0.1)},${Math.floor(c.b*0.14)},0.9)`);

      this._updateDynamicElements({
        ...theme,
        rgb: { r: c.r, g: c.g, b: c.b },
        colors: { ...theme.colors, accent: c.accent }
      });
    }, speed);
  }

  _stopCycle() {
    if (this.cycleInterval) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
  }

  // ==================== PARTICULES ====================

  _startParticles(config) {
    this._stopParticles();

    const container = document.createElement('div');
    container.id = 'theme-particles';
    container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;';
    document.body.appendChild(container);
    this.particleContainer = container;

    const count = config.count || 20;
    const color = config.color || 'rgba(255,255,255,0.1)';

    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      const size = 2 + Math.random() * 4;
      const x = Math.random() * 100;
      const duration = 10 + Math.random() * 20;
      const delay = Math.random() * duration;

      if (config.type === 'hearts') {
        p.innerHTML = '♡';
        p.style.cssText = `
          position:absolute; left:${x}%; font-size:${8+Math.random()*14}px;
          color:${color}; opacity:${0.1+Math.random()*0.3};
          animation: particle-float ${duration}s ${delay}s linear infinite;
        `;
      } else {
        p.style.cssText = `
          position:absolute; left:${x}%; width:${size}px; height:${size}px;
          background:${color}; border-radius:50%; opacity:${0.2+Math.random()*0.4};
          animation: particle-float ${duration}s ${delay}s linear infinite;
        `;
      }
      container.appendChild(p);
    }

    // Injecter l'animation de particules
    const style = this._getAnimationStyleEl();
    style.textContent += `
      @keyframes particle-float {
        0% { transform: translateY(110vh) rotate(0deg); }
        100% { transform: translateY(-10vh) rotate(360deg); }
      }
    `;
  }

  _stopParticles() {
    if (this.particleContainer) {
      this.particleContainer.remove();
      this.particleContainer = null;
    }
  }

  // ==================== PUBLIC API ====================

  /**
   * Retourne la liste des thèmes disponibles
   */
  list() {
    return Array.from(this.themes.values()).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      accent: t.colors?.accent,
      rgb: t.rgb,
      light: !!t.light,
      animated: !!t.animated || !!t.cycle?.enabled,
    }));
  }

  /**
   * Retourne le thème actif
   */
  getCurrent() {
    return this.currentTheme;
  }

  /**
   * Vérifie si un thème existe
   */
  has(themeId) {
    return this.themes.has(themeId);
  }

  /**
   * Détruit le moteur (nettoyage)
   */
  destroy() {
    this._stopCycle();
    this._stopParticles();
    if (this.dynamicStyleEl) this.dynamicStyleEl.remove();
    if (this.animationStyleEl) this.animationStyleEl.remove();
  }
}

// Export pour usage dans Electron renderer ou comme module
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ThemeEngine;
} else if (typeof window !== 'undefined') {
  window.ThemeEngine = ThemeEngine;
}
