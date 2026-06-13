/**
 * AudioFeedback — kompletter prozeduraler WebAudio-Synth fuer ASCHENTHRON.
 * Alle Spielklaenge entstehen ohne Audiodateien aus Oszillatoren, einem
 * gecachten Noise-Buffer, Biquad-Sweeps und klickfreien Ramp-Huellkurven.
 * Raeumlichkeit: StereoPanner (Pan aus Blickrichtung) + Distanzdaempfung.
 */

const NOISE_SECONDS = 2;        // Laenge des gecachten Rausch-Buffers
const DIST_FALLOFF = 0.08;      // Lautstaerke = 1 / (1 + dist * DIST_FALLOFF)
const UNLOCK_GRACE_MS = 400;    // direkt nach unlock() trotz resume()-Latenz planen

// Vektor-Eingaben (THREE.Vector3, {x,y,z} oder [x,y,z]) vereinheitlichen.
function vec3(v) {
  if (!v) return null;
  if (Array.isArray(v)) return { x: +v[0] || 0, y: +v[1] || 0, z: +v[2] || 0 };
  if (typeof v.x === 'number') {
    return { x: v.x, y: typeof v.y === 'number' ? v.y : 0, z: typeof v.z === 'number' ? v.z : 0 };
  }
  return null;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

export class AudioFeedback {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._comp = null;
    this._noiseBuf = null;
    this._distCurve = null;
    this._volume = 0.8;
    this._unlockAt = 0;
    this._listener = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, z: -1 } };
    this._loops = new Set();
    this._ambienceOn = false;
    this._ambBus = null;
    this._crackleTimer = 0;
    this._createContext();
  }

  // ---------------------------------------------------------------- Kontext

  _createContext() {
    if (this.ctx) return;
    const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AC) return;
    try { this.ctx = new AC(); } catch (e) { this.ctx = null; return; }
    // Sanfter Limiter gegen Clipping bei Explosions-Stacks
    this._comp = this.ctx.createDynamicsCompressor();
    this._comp.threshold.value = -14;
    this._comp.knee.value = 18;
    this._comp.ratio.value = 5;
    this._comp.attack.value = 0.004;
    this._comp.release.value = 0.2;
    this.master = this.ctx.createGain();
    this.master.gain.value = this._volume;
    this.master.connect(this._comp);
    this._comp.connect(this.ctx.destination);
  }

  /** Im User-Gesture aufrufen; resumed den AudioContext, idempotent. */
  unlock() {
    this._createContext();
    if (!this.ctx) return;
    this._unlockAt = Date.now();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** Gesamtlautstaerke 0..1. */
  setVolume(v01) {
    this._volume = clamp(+v01 || 0, 0, 1);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.03);
    }
  }

  /** Pro Frame von main.js: Hoererposition + Blickrichtung (fuer Pan/Distanz). */
  setListener(pos, forward) {
    const p = vec3(pos);
    if (p) this._listener.pos = p;
    const f = vec3(forward);
    if (f) {
      const h = Math.hypot(f.x, f.z);
      if (h > 1e-4) this._listener.fwd = { x: f.x / h, z: f.z / h };
    }
    // Aktive Loops der Bewegung nachfuehren
    for (const rec of this._loops) {
      if (rec.pos) this._respatialize(rec);
    }
  }

  // Plant nur, wenn der Kontext laeuft (sonst stauen sich Events bis resume()).
  _audible() {
    if (!this.ctx || !this.master) return false;
    if (this.ctx.state === 'running') return true;
    return Date.now() - this._unlockAt < UNLOCK_GRACE_MS;
  }

  // -------------------------------------------------------- Raeumlichkeit

  // Pan aus Richtung relativ zur Blickrichtung, Daempfung aus Distanz.
  _spatial(pos) {
    const L = this._listener;
    const dx = pos.x - L.pos.x;
    const dy = (pos.y || 0) - L.pos.y;
    const dz = pos.z - L.pos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const att = 1 / (1 + dist * DIST_FALLOFF);
    let pan = 0;
    const dh = Math.hypot(dx, dz);
    if (dh > 0.001) {
      // Rechts-Vektor = forward x up (up = +Y) → (-fz, 0, fx)
      const rx = -L.fwd.z;
      const rz = L.fwd.x;
      pan = clamp((dx * rx + dz * rz) / dh, -1, 1) * 0.8;
    }
    return { att, pan };
  }

  // Ausgabe-Kette einer Stimme: Gain (vol*att) → Panner → Master.
  _voice(pos, vol) {
    const ctx = this.ctx;
    const sp = pos ? this._spatial(pos) : { att: 1, pan: 0 };
    const out = ctx.createGain();
    out.gain.value = vol * sp.att;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = sp.pan;
      out.connect(pan);
      pan.connect(this.master);
    } else {
      out.connect(this.master);
    }
    return out;
  }

  _respatialize(rec) {
    if (!this.ctx) return;
    const sp = this._spatial(rec.pos);
    const tn = this.ctx.currentTime;
    rec.spat.gain.setTargetAtTime(rec.vol * sp.att, tn, 0.06);
    if (rec.pan) rec.pan.pan.setTargetAtTime(sp.pan, tn, 0.06);
  }

  // ------------------------------------------------------------ Bausteine

  // Gecachter weisser Noise-Buffer (2 s).
  _noise() {
    if (this._noiseBuf) return this._noiseBuf;
    const len = Math.floor(this.ctx.sampleRate * NOISE_SECONDS);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
    return buf;
  }

  // Tanh-Kurve fuer den Roar-Waveshaper.
  _distortion() {
    if (this._distCurve) return this._distCurve;
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(3.5 * x);
    }
    this._distCurve = c;
    return c;
  }

  // Einzelner Oszillator mit Huellkurve, optionalem Sweep und Tiefpass.
  _osc(out, { type = 'sine', f0, f1 = null, t, dur, peak, a = 0.005, lp = 0 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    if (f1 !== null) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (lp > 0) {
      const fl = ctx.createBiquadFilter();
      fl.type = 'lowpass';
      fl.frequency.value = lp;
      o.connect(fl);
      fl.connect(g);
    } else {
      o.connect(g);
    }
    g.connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Noise-Burst durch Biquad mit optionalem Frequenz-Sweep, perkussive Huelle.
  _noiseHit(out, { t, dur, peak, a = 0.003, type = 'lowpass', f0, f1 = null, q = 0.8, rate = 1 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    src.playbackRate.value = rate;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.Q.value = q;
    fl.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 !== null) fl.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(fl);
    fl.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 0.6);
    src.stop(t + dur + 0.1);
  }

  // Whoosh: Bandpass-Noise mit Sweep und An-/Abschwell-Huelle.
  _whoosh(out, { t, dur, peak, f0, f1, q = 1.6, rate = 1 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    src.playbackRate.value = rate;
    const fl = ctx.createBiquadFilter();
    fl.type = 'bandpass';
    fl.Q.value = q;
    fl.frequency.setValueAtTime(Math.max(20, f0), t);
    fl.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(fl);
    fl.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 0.6);
    src.stop(t + dur + 0.1);
  }

  // Sub-Sinus-Drop (z. B. 60→30 Hz) als Explosions-Fundament.
  _sub(out, { t, f0, f1, dur, peak }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Metall: 3-4 leicht verstimmte Teiltoene mit schnellem Decay + Noise-Transient.
  _metal(out, { t, base, ratios = [1, 2.26, 3.53, 4.95], decay, peak }) {
    const ctx = this.ctx;
    const types = ['sine', 'triangle'];
    for (let i = 0; i < ratios.length; i++) {
      const o = ctx.createOscillator();
      o.type = types[i % 2];
      o.frequency.value = base * ratios[i] * (1 + (Math.random() * 2 - 1) * 0.004);
      o.detune.value = (Math.random() * 2 - 1) * 9;
      const g = ctx.createGain();
      const pk = peak / (1 + i * 0.9);
      const d = decay * (1 - i * 0.12);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(pk, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + d + 0.05);
    }
    this._noiseHit(out, { t, dur: 0.035, peak: peak * 0.7, type: 'highpass', f0: 2200, q: 0.7 });
  }

  // Glockenschlag: inharmonische Teiltoene (Hum/Prime/Tierce/Quint/Nominal).
  _bell(out, { t, base, peak, dur }) {
    const partials = [
      [0.5, 0.4, 1.0], [1.0, 1.0, 0.9], [1.19, 0.3, 0.55], [1.56, 0.25, 0.5],
      [2.0, 0.45, 0.45], [2.74, 0.15, 0.3], [3.76, 0.08, 0.2],
    ];
    const ctx = this.ctx;
    for (const [r, w, rel] of partials) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = base * r * (1 + (Math.random() * 2 - 1) * 0.002);
      const g = ctx.createGain();
      const d = Math.max(0.15, dur * rel);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak * w, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + d + 0.05);
    }
    this._noiseHit(out, { t, dur: 0.03, peak: peak * 0.3, type: 'highpass', f0: 2600, q: 0.7 });
  }

  // Kleine Tonfolge (Sieg/Niederlage); jede Note mit leiser Oktave darueber.
  _seq(out, t, notes, p, type) {
    let tt = t;
    for (const [f, d, v] of notes) {
      this._osc(out, { type, f0: f * p, t: tt, dur: d + 0.12, peak: v, a: 0.012 });
      this._osc(out, { type: 'sine', f0: f * 2 * p, t: tt, dur: d * 0.8, peak: v * 0.22, a: 0.012 });
      tt += d;
    }
  }

  // Roar: Saegezahn-Stack + Vibrato-LFO + Waveshaper + Noise-Layer (0.8 s).
  _roar(out, t, p) {
    const ctx = this.ctx;
    const dur = 0.8;
    const sh = ctx.createWaveShaper();
    sh.curve = this._distortion();
    sh.oversample = '2x';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.8;
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.55, t + 0.06);
    g.gain.linearRampToValueAtTime(0.45, t + dur - 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    sh.connect(lp);
    lp.connect(g);
    g.connect(out);
    // Vibrato auf alle Grundtoene, leicht beschleunigend
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(5, t);
    lfo.frequency.linearRampToValueAtTime(7.5, t + dur);
    const lfoG = ctx.createGain();
    lfoG.gain.value = 5;
    lfo.connect(lfoG);
    for (const f of [72, 96, 108, 144]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * p, t);
      o.frequency.exponentialRampToValueAtTime(f * p * 0.82, t + dur); // bedrohliches Absinken
      lfoG.connect(o.frequency);
      const og = ctx.createGain();
      og.gain.value = 0.25;
      o.connect(og);
      og.connect(sh);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
    this._noiseHit(out, { t, dur, peak: 0.25, type: 'bandpass', f0: 360, f1: 220, q: 1.0, rate: 0.7 });
  }

  // Herzschlag: zwei dumpfe Sinus-Schlaege ("Lub-Dub").
  _heart(out, t, p) {
    const ctx = this.ctx;
    const beat = (tt, f, v) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, tt);
      o.frequency.exponentialRampToValueAtTime(f * 0.7, tt + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(v, tt + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.18);
      o.connect(g);
      g.connect(out);
      o.start(tt);
      o.stop(tt + 0.25);
    };
    beat(t, 62 * p, 0.5);
    beat(t + 0.26, 50 * p, 0.38);
  }

  // ------------------------------------------------------------- One-Shots

  /** Einmal-Sound; unbekannte IDs werden still ignoriert. */
  play(id, { pos = null, vol = 1, pitch = 1 } = {}) {
    if (!this._audible()) return;
    const out = this._voice(vec3(pos), Math.max(0, vol));
    this._build(id, out, this.ctx.currentTime + 0.005, clamp(+pitch || 1, 0.25, 4));
  }

  // Rezepte fuer alle Sound-IDs des Vertrags.
  _build(id, out, t, p) {
    switch (id) {
      case 'ui_click':
        this._osc(out, { type: 'triangle', f0: 950 * p, f1: 520 * p, t, dur: 0.07, peak: 0.22, a: 0.004 });
        this._noiseHit(out, { t, dur: 0.02, peak: 0.07, type: 'highpass', f0: 3000, q: 0.7 });
        break;
      case 'ui_hover':
        this._osc(out, { type: 'sine', f0: 1250 * p, f1: 1500 * p, t, dur: 0.05, peak: 0.09, a: 0.006 });
        break;
      case 'cast_arcane':
        this._osc(out, { type: 'triangle', f0: 620 * p, f1: 1500 * p, t, dur: 0.14, peak: 0.28, a: 0.005 });
        this._osc(out, { type: 'sine', f0: 1240 * p, f1: 3000 * p, t, dur: 0.12, peak: 0.1, a: 0.005 });
        this._noiseHit(out, { t, dur: 0.1, peak: 0.1, type: 'bandpass', f0: 2400 * p, f1: 4200 * p, q: 2.5 });
        break;
      case 'fireball_launch':
        this._whoosh(out, { t, dur: 0.4, peak: 0.5, f0: 240 * p, f1: 1300 * p, q: 1.4 });
        this._sub(out, { t, f0: 130 * p, f1: 70 * p, dur: 0.25, peak: 0.3 });
        break;
      case 'charge_loop': // Fallback, falls per play() statt loop() ausgeloest
        this._noiseHit(out, { t, dur: 0.5, peak: 0.18, type: 'bandpass', f0: 700 * p, f1: 1400 * p, q: 5 });
        break;
      case 'explosion_small':
        this._noiseHit(out, { t, dur: 0.5, peak: 0.8, type: 'lowpass', f0: 1400 * p, f1: 180, q: 0.7 });
        this._sub(out, { t, f0: 60 * p, f1: 30, dur: 0.45, peak: 0.7 });
        break;
      case 'explosion_big':
        this._noiseHit(out, { t, dur: 1.0, peak: 1.0, type: 'lowpass', f0: 1800 * p, f1: 120, q: 0.7 });
        this._noiseHit(out, { t: t + 0.05, dur: 1.2, peak: 0.35, type: 'lowpass', f0: 400, f1: 90, q: 0.6, rate: 0.6 });
        this._sub(out, { t, f0: 70 * p, f1: 28, dur: 0.9, peak: 0.9 });
        break;
      case 'sword_swing':
        this._whoosh(out, { t, dur: 0.18, peak: 0.32, f0: 500 * p, f1: 2100 * p, q: 2.0 });
        break;
      case 'sword_hit':
        this._metal(out, { t, base: 560 * p, decay: 0.2, peak: 0.5 });
        break;
      case 'heavy_swing':
        this._whoosh(out, { t, dur: 0.28, peak: 0.45, f0: 240 * p, f1: 1100 * p, q: 1.6 });
        break;
      case 'heavy_hit':
        this._metal(out, { t, base: 360 * p, decay: 0.28, peak: 0.65 });
        this._sub(out, { t, f0: 110 * p, f1: 55, dur: 0.25, peak: 0.4 });
        break;
      case 'block_impact':
        this._metal(out, { t, base: 300 * p, ratios: [1, 2.41, 3.89, 5.2], decay: 0.35, peak: 0.6 });
        this._noiseHit(out, { t, dur: 0.08, peak: 0.35, type: 'bandpass', f0: 1500 * p, q: 1.2 });
        this._sub(out, { t, f0: 95 * p, f1: 60, dur: 0.2, peak: 0.35 });
        break;
      case 'shield_up':
        this._osc(out, { type: 'sine', f0: 320 * p, f1: 880 * p, t, dur: 0.35, peak: 0.3, a: 0.02 });
        this._osc(out, { type: 'triangle', f0: 480 * p, f1: 1320 * p, t, dur: 0.3, peak: 0.12, a: 0.02 });
        this._noiseHit(out, { t: t + 0.05, dur: 0.25, peak: 0.07, type: 'highpass', f0: 3500, q: 0.7 });
        break;
      case 'shield_break':
        // glasig fallende Teiltoene + Splitter-Noise
        for (const [f, d, v] of [[1900, 0.28, 0.3], [2700, 0.22, 0.2], [1300, 0.35, 0.25]]) {
          this._osc(out, { type: 'sine', f0: f * p, f1: f * 0.55 * p, t, dur: d, peak: v, a: 0.003 });
        }
        this._noiseHit(out, { t, dur: 0.3, peak: 0.4, type: 'highpass', f0: 2200, f1: 900, q: 0.8 });
        break;
      case 'blink':
        this._noiseHit(out, { t, dur: 0.18, peak: 0.35, type: 'bandpass', f0: 900 * p, f1: 3400 * p, q: 1.8 });
        this._osc(out, { type: 'sine', f0: 420 * p, f1: 1500 * p, t, dur: 0.16, peak: 0.18, a: 0.005 });
        break;
      case 'dash':
        this._whoosh(out, { t, dur: 0.3, peak: 0.5, f0: 700 * p, f1: 260 * p, q: 1.2 });
        break;
      case 'claw':
        this._noiseHit(out, { t, dur: 0.12, peak: 0.4, type: 'bandpass', f0: 1100 * p, f1: 2800 * p, q: 2.2 });
        this._noiseHit(out, { t: t + 0.04, dur: 0.1, peak: 0.3, type: 'bandpass', f0: 1500 * p, f1: 3200 * p, q: 2.2 });
        break;
      case 'breath_loop': // Fallback, falls per play() statt loop() ausgeloest
        this._noiseHit(out, { t, dur: 0.6, peak: 0.3, type: 'lowpass', f0: 900 * p, f1: 500, q: 0.8 });
        break;
      case 'roar':
        this._roar(out, t, p);
        break;
      case 'tail_whoosh':
        this._whoosh(out, { t, dur: 0.35, peak: 0.5, f0: 160 * p, f1: 750 * p, q: 1.1, rate: 0.8 });
        break;
      case 'slam':
        this._noiseHit(out, { t, dur: 0.5, peak: 0.8, type: 'lowpass', f0: 900 * p, f1: 140, q: 0.8 });
        this._sub(out, { t, f0: 85 * p, f1: 34, dur: 0.5, peak: 0.8 });
        this._metal(out, { t, base: 190 * p, decay: 0.3, peak: 0.18 }); // Truemmer-Anklang
        break;
      case 'nova_cast':
        this._osc(out, { type: 'sine', f0: 330 * p, f1: 990 * p, t, dur: 0.7, peak: 0.25, a: 0.05 });
        this._osc(out, { type: 'sine', f0: 332 * p, f1: 1002 * p, t, dur: 0.7, peak: 0.2, a: 0.05 });
        this._noiseHit(out, { t, dur: 0.7, peak: 0.1, type: 'highpass', f0: 1500, f1: 5000, q: 0.8 });
        break;
      case 'nova_blast':
        this._noiseHit(out, { t, dur: 0.9, peak: 0.9, type: 'bandpass', f0: 2300 * p, f1: 240, q: 0.9 });
        this._sub(out, { t, f0: 65 * p, f1: 28, dur: 0.8, peak: 0.9 });
        this._metal(out, { t: t + 0.02, base: 980 * p, decay: 0.5, peak: 0.28 }); // arkanes Nachklingen
        break;
      case 'hurt':
        this._osc(out, { type: 'sawtooth', f0: 170 * p, f1: 90 * p, t, dur: 0.14, peak: 0.3, a: 0.004, lp: 700 });
        this._noiseHit(out, { t, dur: 0.08, peak: 0.16, type: 'lowpass', f0: 800, q: 0.7 });
        break;
      case 'death':
        this._osc(out, { type: 'sine', f0: 200 * p, f1: 50, t, dur: 0.7, peak: 0.45, a: 0.01 });
        this._osc(out, { type: 'sawtooth', f0: 130 * p, f1: 60, t, dur: 0.5, peak: 0.15, a: 0.01, lp: 500 });
        this._noiseHit(out, { t: t + 0.1, dur: 0.6, peak: 0.25, type: 'lowpass', f0: 600, f1: 120, q: 0.7 });
        break;
      case 'hitmarker':
        this._osc(out, { type: 'square', f0: 2300 * p, f1: 1800 * p, t, dur: 0.035, peak: 0.13, a: 0.002 });
        break;
      case 'footstep':
        this._noiseHit(out, { t, dur: 0.07, peak: 0.18, type: 'lowpass', f0: 480 * p, q: 0.8, rate: 0.9 + Math.random() * 0.25 });
        this._sub(out, { t, f0: 95 * p, f1: 60, dur: 0.06, peak: 0.1 });
        break;
      case 'jump':
        this._whoosh(out, { t, dur: 0.16, peak: 0.18, f0: 280 * p, f1: 700 * p, q: 1.2 });
        break;
      case 'land':
        this._noiseHit(out, { t, dur: 0.14, peak: 0.3, type: 'lowpass', f0: 500 * p, f1: 160, q: 0.8 });
        this._sub(out, { t, f0: 110 * p, f1: 55, dur: 0.14, peak: 0.35 });
        break;
      case 'countdown_tick':
        this._osc(out, { type: 'sine', f0: 880 * p, t, dur: 0.09, peak: 0.3, a: 0.003 });
        this._osc(out, { type: 'sine', f0: 1760 * p, t, dur: 0.05, peak: 0.08, a: 0.003 });
        break;
      case 'round_start':
        this._bell(out, { t, base: 220 * p, peak: 0.55, dur: 1.8 });
        break;
      case 'round_win': // kleine Dur-Folge aufwaerts
        this._seq(out, t, [[523.25, 0.14, 0.3], [659.25, 0.14, 0.3], [783.99, 0.4, 0.34]], p, 'triangle');
        break;
      case 'round_lose': // Moll-Folge abwaerts
        this._seq(out, t, [[392, 0.16, 0.3], [311.13, 0.16, 0.28], [261.63, 0.45, 0.3]], p, 'sine');
        break;
      case 'match_win': // 3-Ton-Fanfare (Dur) + Glocken-Layer
        this._seq(out, t, [[523.25, 0.18, 0.32], [659.25, 0.18, 0.32], [783.99, 0.9, 0.38]], p, 'triangle');
        this._bell(out, { t: t + 0.36, base: 261.63 * p, peak: 0.22, dur: 1.8 });
        break;
      case 'match_lose': // 3 Toene Moll abwaerts + dunkles Fundament
        this._seq(out, t, [[329.63, 0.2, 0.3], [261.63, 0.2, 0.28], [220, 1.0, 0.3]], p, 'sine');
        this._sub(out, { t: t + 0.4, f0: 55, f1: 40, dur: 1.0, peak: 0.22 });
        break;
      case 'heartbeat':
        this._heart(out, t, p);
        break;
      default:
        break; // unbekannte ID → still ignorieren
    }
  }

  // ----------------------------------------------------------------- Loops

  /** Loopbarer Sound; gibt {stop(), setPos(p)} zurueck (auch bei unbekannter ID). */
  loop(id, { pos = null, vol = 1 } = {}) {
    const dummy = { stop() {}, setPos() {} };
    this._createContext();
    if (!this.ctx || !this.master) return dummy;
    let make = null;
    if (id === 'charge_loop') make = this._loopCharge;
    else if (id === 'breath_loop') make = this._loopBreath;
    if (!make) return dummy;

    const ctx = this.ctx;
    const p = vec3(pos);
    const sp = p ? this._spatial(p) : { att: 1, pan: 0 };
    const spat = ctx.createGain();
    spat.gain.value = Math.max(0, vol) * sp.att;
    let pan = null;
    if (ctx.createStereoPanner) {
      pan = ctx.createStereoPanner();
      pan.pan.value = sp.pan;
      spat.connect(pan);
      pan.connect(this.master);
    } else {
      spat.connect(this.master);
    }
    const env = ctx.createGain();
    env.connect(spat);
    const t = ctx.currentTime + 0.01;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.08); // klickfreies Einblenden
    const stops = make.call(this, env, t);
    const rec = { pos: p, vol: Math.max(0, vol), spat, pan, env, stops, alive: true };
    this._loops.add(rec);
    const self = this;
    return {
      stop() {
        if (!rec.alive) return;
        rec.alive = false;
        self._loops.delete(rec);
        const tn = ctx.currentTime;
        rec.env.gain.cancelScheduledValues(tn);
        rec.env.gain.setValueAtTime(rec.env.gain.value, tn);
        rec.env.gain.linearRampToValueAtTime(0, tn + 0.15); // kurzer Fade
        for (const s of rec.stops) {
          try { s.stop(tn + 0.2); } catch (e) { /* bereits gestoppt */ }
        }
        setTimeout(() => {
          try { rec.spat.disconnect(); if (rec.pan) rec.pan.disconnect(); } catch (e) { /* egal */ }
        }, 400);
      },
      setPos(np) {
        const v = vec3(np);
        if (!v || !rec.alive) return;
        rec.pos = v;
        self._respatialize(rec);
      },
    };
  }

  // Feuerball-Aufladen: zitternder Bandpass-Schimmer + arkanes Brummen.
  _loopCharge(env, t) {
    const ctx = this.ctx;
    const stops = [];
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 5;
    const ng = ctx.createGain();
    ng.gain.value = 0.2;
    src.connect(bp);
    bp.connect(ng);
    ng.connect(env);
    src.start(t);
    stops.push(src);
    // Schnelles Zittern + langsames Wandern der Filterfrequenz
    for (const [f, depth] of [[6.5, 240], [0.5, 320]]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = f;
      const lg = ctx.createGain();
      lg.gain.value = depth;
      lfo.connect(lg);
      lg.connect(bp.frequency);
      lfo.start(t);
      stops.push(lfo);
    }
    for (const f of [220, 223.5]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = 0.05;
      o.connect(og);
      og.connect(env);
      o.start(t);
      stops.push(o);
    }
    return stops;
  }

  // Feueratem: dekorrelierte Noise-Schichten mit flackernder Filterbewegung.
  _loopBreath(env, t) {
    const ctx = this.ctx;
    const stops = [];
    const layer = (type, f, q, g, offset) => {
      const src = ctx.createBufferSource();
      src.buffer = this._noise();
      src.loop = true;
      const fl = ctx.createBiquadFilter();
      fl.type = type;
      fl.frequency.value = f;
      fl.Q.value = q;
      const gg = ctx.createGain();
      gg.gain.value = g;
      src.connect(fl);
      fl.connect(gg);
      gg.connect(env);
      src.start(t, offset);
      stops.push(src);
      return fl;
    };
    layer('lowpass', 950, 0.7, 0.3, 0);
    const bp = layer('bandpass', 420, 1.4, 0.26, 1.0);
    layer('lowpass', 170, 0.7, 0.3, 0.5); // tiefes Grollen
    // Flacker-LFO auf die mittlere Schicht
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 3.2;
    const lg = ctx.createGain();
    lg.gain.value = 140;
    lfo.connect(lg);
    lg.connect(bp.frequency);
    lfo.start(t);
    stops.push(lfo);
    return stops;
  }

  // -------------------------------------------------------------- Ambience

  /** Wind + tiefer Drone + zufaelliges Fackel-Knistern; idempotent. */
  startAmbience() {
    if (this._ambienceOn) return;
    this._createContext();
    if (!this.ctx || !this.master) return;
    this._ambienceOn = true;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0, t);
    bus.gain.linearRampToValueAtTime(1, t + 2.5); // langsames Einblenden
    bus.connect(this.master);
    this._ambBus = bus;
    // Wind: gefiltertes Loop-Rauschen mit langsamer LFO-Filterbewegung
    const wind = ctx.createBufferSource();
    wind.buffer = this._noise();
    wind.loop = true;
    wind.playbackRate.value = 0.85;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    lp.Q.value = 0.6;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 300;
    bp.Q.value = 0.8;
    const wg = ctx.createGain();
    wg.gain.value = 0.085;
    wind.connect(lp);
    lp.connect(bp);
    bp.connect(wg);
    wg.connect(bus);
    wind.start(t);
    // Boeen: sehr langsame LFOs auf Filterfrequenz und Lautstaerke
    const lfoF = ctx.createOscillator();
    lfoF.frequency.value = 0.07;
    const lfoFG = ctx.createGain();
    lfoFG.gain.value = 150;
    lfoF.connect(lfoFG);
    lfoFG.connect(bp.frequency);
    lfoF.start(t);
    const lfoA = ctx.createOscillator();
    lfoA.frequency.value = 0.045;
    const lfoAG = ctx.createGain();
    lfoAG.gain.value = 0.03;
    lfoA.connect(lfoAG);
    lfoAG.connect(wg.gain);
    lfoA.start(t);
    // Tiefer Drone: zwei verstimmte Sinus, sehr leise
    for (const [f, g] of [[55, 0.035], [55.7, 0.03]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og);
      og.connect(bus);
      o.start(t);
    }
    this._scheduleCrackle();
  }

  // Alle 4-9 s ein zufaellig platziertes Fackel-Knistern planen.
  _scheduleCrackle() {
    if (!this._ambienceOn) return;
    const delay = 4000 + Math.random() * 5000;
    this._crackleTimer = setTimeout(() => {
      this._crackleBurst();
      this._scheduleCrackle();
    }, delay);
  }

  // Kurzer Burst aus wenigen hochpass-gefilterten Noise-Ticks.
  _crackleBurst() {
    if (!this.ctx || this.ctx.state !== 'running' || !this._ambBus) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = (Math.random() * 2 - 1) * 0.7;
      g.connect(pan);
      pan.connect(this._ambBus);
    } else {
      g.connect(this._ambBus);
    }
    let t = ctx.currentTime + 0.02;
    const n = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      this._noiseHit(g, {
        t, dur: 0.02 + Math.random() * 0.03, peak: 0.1 + Math.random() * 0.12,
        type: 'highpass', f0: 1800 + Math.random() * 1500, q: 0.7,
        rate: 0.8 + Math.random() * 0.6,
      });
      t += 0.03 + Math.random() * 0.09;
    }
  }
}
