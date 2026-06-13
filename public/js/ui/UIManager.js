/**
 * UIManager.js — Screens, HUD, Ansagen und Einstellungen.
 * Verwaltet alle DOM-Overlays (Menü, Lobby, Klassenwahl, HUD, Pause,
 * Ergebnis, Disconnect), persistiert Einstellungen in localStorage und
 * meldet Nutzeraktionen über callbacks.* an main.js. Kein three.js, kein Netz.
 */

import { CLASSES, CLASS_IDS, SLOT_ORDER, SLOT_KEYS, MATCH } from '/shared/classes.js';

const STORAGE_KEY = 'aschenthron-settings';
const DEFAULT_SETTINGS = { sensitivity: 1, quality: 'medium', volume: 0.8, name: '' };
const SCREEN_NAMES = ['menu', 'lobby', 'class', 'hud', 'pause', 'result', 'disconnected'];
const QUALITIES = ['low', 'medium', 'high'];
const STAT_ROWS = [
  ['offense', 'Angriff'],
  ['defense', 'Verteidigung'],
  ['speed', 'Tempo'],
  ['range', 'Reichweite'],
];

// Klassen-Sigillen als Inline-SVG (currentColor = Klassenfarbe).
const SIGILS = {
  mage: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="32" cy="32" r="19" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.35"/>
    <path d="M32 7 L36.4 27.6 L57 32 L36.4 36.4 L32 57 L27.6 36.4 L7 32 L27.6 27.6 Z" fill="currentColor"/>
    <path d="M49 9 L50.8 14.2 L56 16 L50.8 17.8 L49 23 L47.2 17.8 L42 16 L47.2 14.2 Z" fill="currentColor" opacity="0.8"/>
  </svg>`,
  knight: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M32 5 L53 13 V31 C53 45 44 54 32 60 C20 54 11 45 11 31 V13 Z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>
    <path d="M32 14 V44" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M24 23 H40" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="32" cy="48" r="2.4" fill="currentColor"/>
  </svg>`,
  dragon: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8 34 L24 28 L36 16 L50 8 L44 22 L52 28 L50 44 L30 46 L20 52 L10 40 Z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>
    <circle cx="38" cy="26" r="2.4" fill="currentColor"/>
    <path d="M12 36 L20 38" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
  </svg>`,
};

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

/** Hex-Zahl → CSS-Farbe (#rrggbb), defensiv mit Gold-Fallback. */
function hexCss(hex) {
  if (typeof hex !== 'number' || !Number.isFinite(hex)) return '#c98a3d';
  return '#' + (hex >>> 0).toString(16).padStart(6, '0').slice(-6);
}

/** Hex-Zahl → "r, g, b" für rgba()-Verwendung in CSS-Variablen. */
function hexRgbTriple(hex) {
  if (typeof hex !== 'number' || !Number.isFinite(hex)) return '201, 138, 61';
  const n = hex >>> 0;
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** Text für innerHTML-Templates entschärfen. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
}

/** Sekunden → "m:ss". */
function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class UIManager {
  constructor() {
    // main.js verdrahtet diese Callbacks (inkl. Klick-Sounds).
    this.callbacks = {
      onEnter: null, onSelectClass: null, onReady: null, onRematch: null,
      onSolo: null, onLeaveSolo: null, onResume: null, onLeave: null, onSettings: null,
    };

    this._settings = this._loadSettings();
    this._current = 'menu';
    this._screens = new Map();
    for (const name of SCREEN_NAMES) {
      this._screens.set(name, document.getElementById('screen-' + name));
    }

    // Zustand
    this._selectedClass = null;
    this._ready = false;
    this._solo = false;
    this._soloAvailable = false;
    this._joinUrl = '';
    this._roster = [];
    this._myId = null;
    this._hudClassId = null;
    this._prevFrac = {};
    this._slotEls = {};
    this._cards = new Map();
    this._cardTags = new Map();
    this._announceTimer = 0;
    this._announceOutTimer = 0;
    this._countdownTimer = 0;
    this._hitTimer = 0;
    this._lowHpActive = false;
    this._crosshairVisible = false;
    this._lastTimerText = '';
    this._lastMyHpText = '';
    this._lastMyMaxText = '';
    this._lastShieldText = '';

    // Häufig genutzte Elemente einmalig greifen.
    const $ = (id) => document.getElementById(id);
    this._els = {
      nameInput: $('menu-name'),
      joinUrl: $('join-url'),
      btnSolo: $('btn-solo'),
      classCards: $('class-cards'),
      enemyStatus: $('class-enemy-status'),
      btnReady: $('btn-ready'),
      enemyBar: $('enemy-bar'),
      enemyName: $('enemy-name'),
      enemyClass: $('enemy-class'),
      enemyHp: $('enemy-hp'),
      enemyShield: $('enemy-shield'),
      pipsMine: $('pips-mine'),
      pipsTheirs: $('pips-theirs'),
      timer: $('hud-timer'),
      roundLabel: $('hud-round'),
      myHp: $('my-hp'),
      myShield: $('my-shield'),
      myHpNum: $('my-hp-num'),
      myMaxNum: $('my-max-num'),
      myShieldNum: $('my-shield-num'),
      meter: $('hud-meter'),
      meterLabel: $('hud-meter-label'),
      meterFill: $('hud-meter-fill'),
      slots: $('hud-slots'),
      crosshair: $('crosshair'),
      vignette: $('damage-vignette'),
      lowHp: $('low-hp'),
      dmgDir: $('dmg-dir'),
      hitmarker: $('hitmarker'),
      dmgNumbers: $('dmg-numbers'),
      announce: $('announce'),
      announceText: $('announce-text'),
      announceSub: $('announce-sub'),
      countdown: $('countdown'),
      btnLeaveSolo: $('btn-pause-leave-solo'),
      btnLeave: $('btn-pause-leave'),
      resultTitle: $('result-title'),
      resultScore: $('result-score'),
      btnRematch: $('btn-rematch'),
      btnResultSolo: $('btn-result-solo'),
      rematchHint: $('rematch-hint'),
      toasts: $('toasts'),
    };

    this._buildClassCards();
    this._buildSlots();
    this._buildPips();
    this._bindButtons();
    this._bindSettings();
    this._applySettingsToInputs();
  }

  // ---------- Screens ----------

  /** Genau einen Screen anzeigen ('menu'|'lobby'|'class'|'hud'|'pause'|'result'|'disconnected'). */
  showScreen(name) {
    if (!SCREEN_NAMES.includes(name)) return;
    const prev = this._current;
    this._current = name;
    for (const [key, el] of this._screens) {
      if (el) el.hidden = key !== name;
    }
    document.body.dataset.screen = name;

    if (name === 'class' && prev !== 'class') this._resetClassScreen();
    if (name === 'menu' || name === 'lobby') this._solo = false;
    if (name === 'pause') {
      // Im Solo-Training „Training beenden“ statt „Verlassen“ anbieten.
      if (this._els.btnLeaveSolo) this._els.btnLeaveSolo.hidden = !this._solo;
      if (this._els.btnLeave) this._els.btnLeave.hidden = this._solo;
    }
    if (name !== 'hud') {
      if (this._els.lowHp) this._els.lowHp.classList.remove('active');
      if (this._els.crosshair) this._els.crosshair.classList.remove('visible');
      this._lowHpActive = false;
      this._crosshairVisible = false;
    }
  }

  get currentScreen() {
    return this._current;
  }

  // ---------- Menü / Lobby ----------

  /** Join-Adresse für Spieler 2 anzeigen. */
  setJoinInfo(lanIp, port) {
    const host = lanIp || (typeof location !== 'undefined' ? location.hostname : '') || 'localhost';
    this._joinUrl = `http://${host}:${port || 8080}`;
    if (this._els.joinUrl) this._els.joinUrl.textContent = this._joinUrl;
  }

  /** Roster-Update: Gegner-Status + Klassenwahl-Markierungen spiegeln. */
  setRoster(players, myId) {
    this._roster = Array.isArray(players) ? players.filter((p) => p && p.id != null) : [];
    if (myId != null) this._myId = myId;

    const enemy = this._roster.find((p) => p.id !== this._myId) || null;
    for (const [classId, tag] of this._cardTags) {
      tag.hidden = !(enemy && enemy.classId === classId);
    }

    const status = this._els.enemyStatus;
    if (status) {
      if (!enemy) {
        status.textContent = 'Warte auf Gegner …';
        status.classList.remove('ready');
      } else {
        const name = enemy.name || 'Gegner';
        status.textContent = enemy.ready ? `${name} ist bereit` : `${name} wählt noch …`;
        status.classList.toggle('ready', !!enemy.ready);
      }
    }

    // Eigene Auswahl aus dem Server-Echo spiegeln (z. B. nach Rematch).
    const me = this._roster.find((p) => p.id === this._myId);
    if (me && me.classId && me.classId !== this._selectedClass) {
      this._applySelection(me.classId, false);
    }
  }

  /** Solo-Training-Button in der Lobby ein-/ausblenden. */
  setSoloAvailable(b) {
    this._soloAvailable = !!b;
    if (this._els.btnSolo) this._els.btnSolo.hidden = !this._soloAvailable;
  }

  // ---------- HUD ----------

  /** Pro Frame: HP/Schild, Cooldown-Sweeps, Charge-/Atem-Meter, Crosshair. */
  tickHud(game) {
    if (!game) return;
    const local = game.local || null;
    if (local && local.def && local.classId !== this._hudClassId) {
      this._configureHudClass(local);
    }

    // Lebens- und Schildanzeigen
    let myFrac = 0;
    const health = game.health || null;
    if (health && typeof health.mine === 'function') {
      const m = health.mine() || {};
      const max = m.maxHp > 0 ? m.maxHp : 1;
      const hp = Math.max(0, m.hp || 0);
      const shield = Math.max(0, m.shield || 0);
      myFrac = clamp01(hp / max);
      this._setBarWidth(this._els.myHp, myFrac);
      this._setBarWidth(this._els.myShield, clamp01(shield / max));
      this._setText(this._els.myHpNum, '_lastMyHpText', String(Math.ceil(hp)));
      this._setText(this._els.myMaxNum, '_lastMyMaxText', `/ ${Math.round(max)}`);
      const shieldTxt = shield > 0 ? `+${Math.ceil(shield)}` : '';
      if (shieldTxt !== this._lastShieldText) {
        this._lastShieldText = shieldTxt;
        if (this._els.myShieldNum) {
          this._els.myShieldNum.hidden = !shieldTxt;
          this._els.myShieldNum.textContent = shieldTxt;
        }
      }

      const t = (typeof health.theirs === 'function') ? health.theirs() : null;
      if (this._els.enemyBar) {
        if (t && t.maxHp > 0) {
          this._els.enemyBar.classList.remove('inactive');
          this._setBarWidth(this._els.enemyHp, clamp01((t.hp || 0) / t.maxHp));
          this._setBarWidth(this._els.enemyShield, clamp01((t.shield || 0) / t.maxHp));
        } else {
          this._els.enemyBar.classList.add('inactive');
        }
      }
    }

    // Low-HP-Puls nur im laufenden Kampf
    const low = this._current === 'hud' && myFrac > 0 && myFrac < 0.25;
    if (low !== this._lowHpActive) {
      this._lowHpActive = low;
      if (this._els.lowHp) this._els.lowHp.classList.toggle('active', low);
    }

    // Ability-Slots (Cooldown-Sweep + Restzeit + Ready-Aufblitzen)
    const ab = local ? local.abilities : null;
    for (const slot of SLOT_ORDER) {
      const els = this._slotEls[slot];
      if (!els) continue;
      let frac = 0;
      let rem = 0;
      if (ab) {
        if (typeof ab.fraction === 'function') frac = clamp01(ab.fraction(slot) || 0);
        if (typeof ab.remaining === 'function') rem = Math.max(0, ab.remaining(slot) || 0);
      }
      if (frac !== els.lastFrac) {
        els.lastFrac = frac;
        els.cd.style.setProperty('--cd', frac.toFixed(3));
      }
      const remTxt = rem > 0.05 ? (rem < 10 ? rem.toFixed(1) : String(Math.ceil(rem))) : '';
      if (remTxt !== els.lastRem) {
        els.lastRem = remTxt;
        els.rem.textContent = remTxt;
      }
      // Aufblitzen, wenn der Cooldown gerade ausgelaufen ist.
      const prev = this._prevFrac[slot] || 0;
      if (prev > 0.04 && frac <= 0.001) this._flashSlot(els.root);
      this._prevFrac[slot] = frac;
    }

    // Charge-/Atem-Meter über den Slots
    let meterShow = false;
    let meterVal = 0;
    let meterKind = 'charge';
    let meterLabel = 'Aufladung';
    if (ab && local) {
      if (local.classId === 'dragon' && typeof ab.breathMeter01 === 'number') {
        meterShow = true;
        meterVal = clamp01(ab.breathMeter01);
        meterKind = 'breath';
        meterLabel = 'Feueratem';
      }
      const charge = (typeof ab.charge01 === 'number') ? ab.charge01 : 0;
      if (charge > 0.001) {
        meterShow = true;
        meterVal = clamp01(charge);
        meterKind = 'charge';
        meterLabel = 'Aufladung';
      }
    }
    if (this._els.meter) {
      this._els.meter.hidden = !meterShow;
      if (meterShow) {
        if (this._els.meter.dataset.kind !== meterKind) this._els.meter.dataset.kind = meterKind;
        if (this._els.meterLabel && this._els.meterLabel.textContent !== meterLabel) {
          this._els.meterLabel.textContent = meterLabel;
        }
        if (this._els.meterFill) this._els.meterFill.style.width = (meterVal * 100).toFixed(1) + '%';
      }
    }

    // Crosshair nur im aktiven Kampf zeigen
    const showCross = this._current === 'hud' && game.phase === 'fighting';
    if (showCross !== this._crosshairVisible) {
      this._crosshairVisible = showCross;
      if (this._els.crosshair) this._els.crosshair.classList.toggle('visible', showCross);
    }
  }

  /** Runden-Pips und Rundenlabel setzen. */
  setScores(mine, theirs, round) {
    this._fillPips(this._els.pipsMine, mine);
    this._fillPips(this._els.pipsTheirs, theirs);
    if (this._els.roundLabel) {
      this._els.roundLabel.textContent = (round > 0) ? `Runde ${round}` : '';
    }
  }

  /** Restzeit anzeigen (Sekunden) oder mit null verbergen. */
  setTimer(seconds) {
    const el = this._els.timer;
    if (!el) return;
    if (seconds == null || !Number.isFinite(seconds)) {
      el.hidden = true;
      this._lastTimerText = '';
      return;
    }
    el.hidden = false;
    const txt = fmtTime(seconds);
    if (txt !== this._lastTimerText) {
      this._lastTimerText = txt;
      el.textContent = txt;
    }
    el.classList.toggle('urgent', seconds <= 10);
  }

  /** Große Ansage mittig (Serifen, fade-scale-in). */
  announce(text, { sub = '', ms = 1800, big = false } = {}) {
    const el = this._els.announce;
    if (!el) return;
    if (this._els.announceText) this._els.announceText.textContent = String(text ?? '');
    if (this._els.announceSub) {
      this._els.announceSub.textContent = sub;
      this._els.announceSub.hidden = !sub;
    }
    el.classList.toggle('big', !!big);
    el.classList.remove('out', 'show');
    el.hidden = false;
    void el.offsetWidth; // Animation neu starten
    el.classList.add('show');
    clearTimeout(this._announceTimer);
    clearTimeout(this._announceOutTimer);
    const life = Math.max(400, ms);
    this._announceOutTimer = setTimeout(() => el.classList.add('out'), life - 240);
    this._announceTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove('out', 'show');
    }, life);
  }

  /** Riesige Countdown-Zahl (3/2/1). */
  countdown(n) {
    const el = this._els.countdown;
    if (!el) return;
    el.textContent = String(n);
    el.hidden = false;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    clearTimeout(this._countdownTimer);
    this._countdownTimer = setTimeout(() => { el.hidden = true; }, 900);
  }

  /** Hitmarker für 120 ms aufblitzen lassen. */
  hitmarker() {
    const el = this._els.hitmarker;
    if (!el) return;
    el.classList.add('show');
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => el.classList.remove('show'), 120);
  }

  /** Richtungs-Vignette: 0 = vorn, positiv = im Uhrzeigersinn (rad). */
  damageDirection(angleRad) {
    const dir = this._els.dmgDir;
    if (dir && typeof angleRad === 'number' && Number.isFinite(angleRad)) {
      dir.style.transform = `rotate(${angleRad}rad)`;
      dir.classList.remove('show');
      void dir.offsetWidth;
      dir.classList.add('show');
    }
    // Zusätzlich kurzer Rundum-Blitz der roten Vignette.
    const v = this._els.vignette;
    if (v) {
      v.classList.remove('hit');
      void v.offsetWidth;
      v.classList.add('hit');
    }
  }

  /** Schwebende Schadenszahl an Bildschirmposition (0..1) spawnen. */
  showDamageNumber(amount, screenX01, screenY01) {
    const layer = this._els.dmgNumbers;
    if (!layer || typeof amount !== 'number' || !Number.isFinite(amount)) return;
    const div = document.createElement('div');
    div.className = 'dmg-num' + (amount >= 40 ? ' big' : '');
    div.textContent = String(Math.round(amount));
    div.style.left = (clamp01(screenX01) * 100).toFixed(2) + '%';
    div.style.top = (clamp01(screenY01) * 100).toFixed(2) + '%';
    div.style.setProperty('--dx', (Math.random() * 36 - 18).toFixed(0) + 'px');
    layer.appendChild(div);
    setTimeout(() => div.remove(), 900);
  }

  /** Name + Klasse des Gegners über dessen HP-Leiste anzeigen. */
  setEnemyInfo(name, classId) {
    const def = (CLASSES && CLASSES[classId]) || null;
    if (this._els.enemyName) {
      this._els.enemyName.textContent = name || '—';
      this._els.enemyName.style.color = def ? hexCss(def.color) : '';
    }
    if (this._els.enemyClass) {
      this._els.enemyClass.textContent = def ? def.name : (classId === 'dummy' ? 'Übungsgolem' : '');
    }
  }

  // ---------- Ergebnis ----------

  /** Ergebnis-Screen befüllen und anzeigen. */
  showResult({ victory, scoreMine = 0, scoreTheirs = 0, soloAllowed = false } = {}) {
    if (this._els.resultTitle) {
      this._els.resultTitle.textContent = victory ? 'SIEG' : 'NIEDERLAGE';
      this._els.resultTitle.classList.toggle('victory', !!victory);
      this._els.resultTitle.classList.toggle('defeat', !victory);
    }
    if (this._els.resultScore) this._els.resultScore.textContent = `${scoreMine} : ${scoreTheirs}`;
    if (this._els.rematchHint) this._els.rematchHint.hidden = true;
    if (this._els.btnRematch) this._els.btnRematch.disabled = false;
    if (this._els.btnResultSolo) this._els.btnResultSolo.hidden = !soloAllowed;
    this.showScreen('result');
  }

  /** Kurzlebige Meldung oben mittig. */
  toast(text, ms = 3000) {
    const wrap = this._els.toasts;
    if (!wrap) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = String(text ?? '');
    wrap.appendChild(t);
    const life = Math.max(600, ms);
    setTimeout(() => t.classList.add('out'), life - 280);
    setTimeout(() => t.remove(), life + 60);
  }

  // ---------- Einstellungen ----------

  /** Aktuelle Einstellungen ({sensitivity, quality, volume, name}). */
  getSettings() {
    return { ...this._settings };
  }

  // ---------- interne Helfer ----------

  /** Callback defensiv aufrufen. */
  _emit(name, ...args) {
    const cb = this.callbacks ? this.callbacks[name] : null;
    if (typeof cb !== 'function') return;
    try {
      cb(...args);
    } catch (err) {
      console.warn(`UIManager: Callback "${name}" fehlgeschlagen`, err);
    }
  }

  _loadSettings() {
    let data = {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) data = JSON.parse(raw) || {};
    } catch (err) {
      data = {};
    }
    const s = { ...DEFAULT_SETTINGS, ...data };
    s.sensitivity = clamp(Number.isFinite(+s.sensitivity) ? +s.sensitivity : 1, 0.3, 2.5);
    s.volume = clamp(Number.isFinite(+s.volume) ? +s.volume : 0.8, 0, 1);
    s.quality = QUALITIES.includes(s.quality) ? s.quality : 'medium';
    s.name = typeof s.name === 'string' ? s.name.slice(0, 16) : '';
    return s;
  }

  _saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings));
    } catch (err) {
      // Storage kann blockiert sein (Privatmodus) — still ignorieren.
    }
  }

  /** Alle [data-setting]-Inputs (Menü UND Pause) binden. */
  _bindSettings() {
    const inputs = Array.from(document.querySelectorAll('[data-setting]'));
    this._settingInputs = inputs;
    for (const input of inputs) {
      const key = input.dataset.setting;
      const evt = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(evt, () => {
        let value = input.value;
        if (input.type === 'range') value = parseFloat(value);
        if (key === 'name') value = String(value).slice(0, 16);
        this._settings[key] = value;
        this._applySettingsToInputs();
        this._saveSettings();
        if (key !== 'name') this._emit('onSettings', { ...this._settings });
      });
    }
  }

  /** Einstellungswerte in alle Inputs + Anzeigen spiegeln. */
  _applySettingsToInputs() {
    for (const input of this._settingInputs || []) {
      const key = input.dataset.setting;
      const value = this._settings[key];
      if (value == null) continue;
      if (String(input.value) !== String(value)) input.value = value;
    }
    for (const out of document.querySelectorAll('[data-setting-out]')) {
      const key = out.dataset.settingOut;
      if (key === 'sensitivity') out.textContent = this._settings.sensitivity.toFixed(2);
      else if (key === 'volume') out.textContent = Math.round(this._settings.volume * 100) + '%';
    }
  }

  _bindButtons() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };

    on('btn-enter', () => {
      const raw = this._els.nameInput ? this._els.nameInput.value.trim() : '';
      const name = raw || 'Namenlos';
      this._settings.name = raw;
      this._saveSettings();
      this._emit('onEnter', name);
    });

    on('btn-copy', () => this._copyJoinUrl());
    if (this._els.joinUrl) this._els.joinUrl.addEventListener('click', () => this._copyJoinUrl());

    on('btn-solo', () => {
      this._solo = true;
      this._emit('onSolo');
    });

    on('btn-ready', () => {
      if (!this._selectedClass) return;
      this._ready = !this._ready;
      this._syncReadyButton();
      this._emit('onReady', this._ready);
    });

    on('btn-resume', () => this._emit('onResume'));
    on('btn-pause-leave', () => this._emit('onLeave'));
    on('btn-pause-leave-solo', () => {
      this._solo = false;
      this._emit('onLeaveSolo');
    });

    on('btn-rematch', () => {
      if (this._els.rematchHint) this._els.rematchHint.hidden = false;
      if (this._els.btnRematch) this._els.btnRematch.disabled = true;
      this._emit('onRematch');
    });

    on('btn-result-solo', () => {
      this._solo = true;
      this._emit('onSolo');
    });

    on('btn-reconnect', () => location.reload());

    // Enter im Namensfeld = Arena betreten
    if (this._els.nameInput) {
      this._els.nameInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          const btn = document.getElementById('btn-enter');
          if (btn) btn.click();
        }
      });
    }
  }

  async _copyJoinUrl() {
    if (!this._joinUrl) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(this._joinUrl);
      ok = true;
    } catch (err) {
      // Fallback für Kontexte ohne Clipboard-API (http im LAN)
      try {
        const ta = document.createElement('textarea');
        ta.value = this._joinUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (err2) {
        ok = false;
      }
    }
    this.toast(ok ? 'Adresse kopiert' : 'Kopieren nicht möglich — bitte abtippen', 1800);
  }

  // ---------- Klassenwahl ----------

  _buildClassCards() {
    const container = this._els.classCards;
    if (!container) return;
    container.innerHTML = '';
    const ids = Array.isArray(CLASS_IDS) && CLASS_IDS.length ? CLASS_IDS : Object.keys(CLASSES || {});
    for (const id of ids) {
      const def = CLASSES ? CLASSES[id] : null;
      if (!def) continue;

      const card = document.createElement('div');
      card.className = 'class-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.dataset.classId = id;
      card.style.setProperty('--class-color', hexCss(def.color));
      card.style.setProperty('--class-rgb', hexRgbTriple(def.color));

      const stats = def.stats || {};
      const statsHtml = STAT_ROWS.map(([key, label]) => `
        <div class="stat-row">
          <span class="stat-label">${label}</span>
          <span class="stat-track"><span class="stat-fill" style="width:${Math.round(clamp01(stats[key] || 0) * 100)}%"></span></span>
        </div>`).join('');

      const abilities = def.abilities || {};
      const abilityHtml = SLOT_ORDER.map((slot) => {
        const a = abilities[slot];
        if (!a) return '';
        return `<li title="${esc(a.desc || '')}"><kbd>${esc(SLOT_KEYS[slot] || '')}</kbd><span>${esc(a.name || '')}</span></li>`;
      }).join('');

      card.innerHTML = `
        <span class="card-enemy-tag" hidden>Gegner</span>
        <div class="card-sigil">${SIGILS[id] || SIGILS.knight}</div>
        <h3 class="card-name">${esc(def.name)}</h3>
        <p class="card-tagline">${esc(def.tagline || def.desc || '')}</p>
        <div class="card-stats">${statsHtml}</div>
        <ul class="card-abilities">${abilityHtml}</ul>`;

      card.addEventListener('click', () => this._applySelection(id, true));
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          this._applySelection(id, true);
        }
      });

      container.appendChild(card);
      this._cards.set(id, card);
      const tag = card.querySelector('.card-enemy-tag');
      if (tag) this._cardTags.set(id, tag);
    }
  }

  /** Kartenauswahl anwenden; emit=false bei Server-Echo. */
  _applySelection(classId, emit) {
    if (!this._cards.has(classId)) return;
    this._selectedClass = classId;
    for (const [id, card] of this._cards) {
      card.classList.toggle('selected', id === classId);
    }
    if (this._els.btnReady) this._els.btnReady.disabled = false;
    if (emit) {
      if (this._ready) {
        // Klassenwechsel hebt die Bereit-Meldung auf.
        this._ready = false;
        this._syncReadyButton();
      }
      this._emit('onSelectClass', classId);
    }
  }

  _syncReadyButton() {
    const btn = this._els.btnReady;
    if (!btn) return;
    btn.classList.toggle('armed', this._ready);
    btn.textContent = this._ready ? 'Bereit ✓' : 'Bereit';
  }

  _resetClassScreen() {
    this._ready = false;
    this._syncReadyButton();
    if (this._els.btnReady) this._els.btnReady.disabled = !this._selectedClass;
  }

  // ---------- HUD-Aufbau ----------

  _buildSlots() {
    const container = this._els.slots;
    if (!container) return;
    container.innerHTML = '';
    this._slotEls = {};
    for (const slot of SLOT_ORDER) {
      const root = document.createElement('div');
      root.className = 'slot';
      root.dataset.slot = slot;
      root.innerHTML = `
        <span class="slot-cd" style="--cd:0"></span>
        <span class="slot-key">${esc(SLOT_KEYS[slot] || '')}</span>
        <span class="slot-rem"></span>
        <span class="slot-name"></span>`;
      container.appendChild(root);
      this._slotEls[slot] = {
        root,
        cd: root.querySelector('.slot-cd'),
        rem: root.querySelector('.slot-rem'),
        name: root.querySelector('.slot-name'),
        lastFrac: -1,
        lastRem: '',
      };
    }
  }

  _buildPips() {
    const count = (MATCH && MATCH.ROUNDS_TO_WIN) || 2;
    for (const el of [this._els.pipsMine, this._els.pipsTheirs]) {
      if (!el) continue;
      el.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const pip = document.createElement('div');
        pip.className = 'pip';
        el.appendChild(pip);
      }
    }
  }

  _fillPips(container, n) {
    if (!container) return;
    const wins = Math.max(0, n | 0);
    const pips = container.children;
    for (let i = 0; i < pips.length; i++) {
      pips[i].classList.toggle('filled', i < wins);
    }
  }

  /** HUD auf die lokale Klasse einstellen (Slot-Namen, Crosshair). */
  _configureHudClass(local) {
    this._hudClassId = local.classId;
    const def = local.def || {};
    const abilities = def.abilities || {};
    for (const slot of SLOT_ORDER) {
      const els = this._slotEls[slot];
      if (!els) continue;
      const a = abilities[slot];
      els.name.textContent = a ? (a.name || '') : '';
      els.root.title = a ? (a.desc || '') : '';
    }
    if (this._els.crosshair) {
      this._els.crosshair.dataset.class = local.classId || '';
    }
    this._prevFrac = {};
  }

  _flashSlot(root) {
    if (!root) return;
    root.classList.remove('flash');
    void root.offsetWidth;
    root.classList.add('flash');
  }

  _setBarWidth(el, frac) {
    if (!el) return;
    const w = (clamp01(frac) * 100).toFixed(1) + '%';
    if (el._lastW !== w) {
      el._lastW = w;
      el.style.width = w;
    }
  }

  _setText(el, cacheKey, text) {
    if (!el || this[cacheKey] === text) return;
    this[cacheKey] = text;
    el.textContent = text;
  }
}
