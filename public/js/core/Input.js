/**
 * Input.js — Tastatur, Maus und Pointer-Lock für den lokalen Spieler.
 * Events werden zwischen den Frames akkumuliert; update() macht daraus
 * frame-genaue wasPressed/wasReleased-Flags. Mausdelta wird nur bei
 * aktivem Pointer-Lock gesammelt und per consumeMouseDelta() abgeholt.
 */

// Tasten-Codes → logische Aktionen.
const KEY_MAP = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  KeyQ: 'skill1',
  KeyE: 'skill2',
  KeyR: 'ultimate',
};

// Maustasten → logische Aktionen (0 = links, 2 = rechts).
const MOUSE_MAP = { 0: 'primary', 2: 'secondary' };

// Eingaben in Formularfeldern (z.B. Namensfeld) zählen nicht als Spiel-Input.
function isEditableTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

export class Input {
  constructor(domElement) {
    /** false → alle Abfragen liefern neutrale Werte. */
    this.enabled = true;

    this._lockTarget = domElement || document.body;
    this._down = new Set();             // aktuell gehaltene Aktionen
    this._pressed = new Set();          // in diesem Frame neu gedrückt
    this._released = new Set();         // in diesem Frame losgelassen
    this._pendingPressed = new Set();   // seit letztem update() eingegangen
    this._pendingReleased = new Set();
    this._dx = 0;
    this._dy = 0;
    this._lockCbs = [];

    this._onKeyDown = (e) => {
      if (isEditableTarget(e.target)) return;
      const action = KEY_MAP[e.code];
      if (!action) return;
      e.preventDefault();
      if (e.repeat || this._down.has(action)) return;
      this._down.add(action);
      this._pendingPressed.add(action);
    };

    // keyup immer verarbeiten, damit keine Taste "hängen" bleibt.
    this._onKeyUp = (e) => {
      const action = KEY_MAP[e.code];
      if (!action || !this._down.has(action)) return;
      this._down.delete(action);
      this._pendingReleased.add(action);
    };

    this._onMouseDown = (e) => {
      const action = MOUSE_MAP[e.button];
      if (!action || this._down.has(action)) return;
      this._down.add(action);
      this._pendingPressed.add(action);
    };

    this._onMouseUp = (e) => {
      const action = MOUSE_MAP[e.button];
      if (!action || !this._down.has(action)) return;
      this._down.delete(action);
      this._pendingReleased.add(action);
    };

    // Mausdelta nur akkumulieren, wenn der Pointer-Lock aktiv ist.
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this._dx += e.movementX || 0;
      this._dy += e.movementY || 0;
    };

    this._onContextMenu = (e) => {
      e.preventDefault();
    };

    // Fokusverlust: alle gehaltenen Eingaben sauber lösen.
    this._onBlur = () => {
      for (const action of this._down) this._pendingReleased.add(action);
      this._down.clear();
      this._dx = 0;
      this._dy = 0;
    };

    this._onLockChange = () => {
      const locked = this.locked;
      if (!locked) {
        // Reste verwerfen, sonst springt die Kamera beim nächsten Lock.
        this._dx = 0;
        this._dy = 0;
      }
      for (const cb of this._lockCbs) {
        try {
          cb(locked);
        } catch (err) {
          console.warn('Input: onLockChange-Callback fehlgeschlagen', err);
        }
      }
    };

    this._onLockError = () => {
      console.warn('Input: Pointer-Lock-Anfrage fehlgeschlagen');
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('pointerlockerror', this._onLockError);
  }

  /** Pro Frame zu Beginn aufrufen: pending-Events in Frame-Flags überführen. */
  update() {
    this._pressed.clear();
    this._released.clear();
    for (const a of this._pendingPressed) this._pressed.add(a);
    for (const a of this._pendingReleased) this._released.add(a);
    this._pendingPressed.clear();
    this._pendingReleased.clear();
  }

  /** Aktion aktuell gehalten? */
  isDown(action) {
    return this.enabled && this._down.has(action);
  }

  /** Aktion in diesem Frame neu gedrückt? */
  wasPressed(action) {
    return this.enabled && this._pressed.has(action);
  }

  /** Aktion in diesem Frame losgelassen? */
  wasReleased(action) {
    return this.enabled && this._released.has(action);
  }

  /** Akkumuliertes Mausdelta abholen und zurücksetzen. */
  consumeMouseDelta() {
    const dx = this._dx;
    const dy = this._dy;
    this._dx = 0;
    this._dy = 0;
    if (!this.enabled) return { dx: 0, dy: 0 };
    return { dx, dy };
  }

  /** Ziel-Element für den Pointer-Lock setzen (z.B. das Canvas). */
  setPointerLockTarget(el) {
    if (el) this._lockTarget = el;
  }

  /** Lock anfordern — MUSS aus einer User-Geste heraus aufgerufen werden. */
  requestLock() {
    const el = this._lockTarget;
    if (!el || this.locked || typeof el.requestPointerLock !== 'function') return;
    try {
      // Moderne Browser geben ein Promise zurück; Ablehnung still schlucken
      // (pointerlockerror-Event meldet den Fehler bereits).
      const result = el.requestPointerLock();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (err) {
      console.warn('Input: requestPointerLock fehlgeschlagen', err);
    }
  }

  /** Lock freigeben (no-op, wenn keiner aktiv ist). */
  exitLock() {
    if (document.pointerLockElement && typeof document.exitPointerLock === 'function') {
      document.exitPointerLock();
    }
  }

  /** Ist der Pointer aktuell auf unser Ziel-Element gelockt? */
  get locked() {
    return !!this._lockTarget && document.pointerLockElement === this._lockTarget;
  }

  /** Callback bei Lock-Wechsel registrieren; cb(locked:boolean). */
  onLockChange(cb) {
    if (typeof cb === 'function') this._lockCbs.push(cb);
  }
}
