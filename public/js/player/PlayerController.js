/**
 * @file PlayerController — lokale Spielerbewegung mit Kapselphysik.
 * Liest Input, integriert Beschleunigung/Reibung/Schwerkraft und löst Kollision
 * über game.colliders.resolveCapsule. Sprung mit Coyote-Time und Jump-Buffer,
 * geskriptete Dashes (Input ignoriert, Schwerkraft pausiert) und externe Impulse.
 */

import * as THREE from 'three';

// Physik-Konstanten laut Vertrag
const GROUND_ACCEL = 60;        // m/s² am Boden
const AIR_ACCEL = 12;           // m/s² in der Luft
const GROUND_FRICTION = 10;     // 1/s Reibung am Boden ohne Input
const GRAVITY = 22;             // m/s²
const STEP_UP = 0.4;            // max. Stufenhöhe
const COYOTE_TIME = 0.1;        // s Sprung-Toleranz nach Kantenverlust
const JUMP_BUFFER_TIME = 0.1;   // s Sprung-Vormerkung vor Bodenkontakt
const FOOTSTEP_DIST = 2.2;      // m Distanz zwischen Schritten
const MAX_FALL_SPEED = 40;      // m/s Terminalgeschwindigkeit
const BLOCK_SPEED_MULT = 0.55;  // Tempo-Malus beim Blocken

// Hilfsfunktion: Vector3 oder [x,y,z] in out schreiben
function toVec3(v, out) {
  if (Array.isArray(v)) return out.set(+v[0] || 0, +v[1] || 0, +v[2] || 0);
  if (v && typeof v.x === 'number') return out.set(v.x, v.y, v.z);
  return out.set(0, 0, 0);
}

export class PlayerController {
  constructor(game, classDef) {
    this.game = game || {};
    // Defensive Defaults, falls Klassendaten unvollständig sind
    const def = classDef || {};
    this.def = {
      moveSpeed: typeof def.moveSpeed === 'number' ? def.moveSpeed : 6,
      sprintMult: typeof def.sprintMult === 'number' ? def.sprintMult : 1.3,
      jumpHeight: typeof def.jumpHeight === 'number' ? def.jumpHeight : 1.1,
      radius: typeof def.radius === 'number' ? def.radius : 0.4,
      height: typeof def.height === 'number' ? def.height : 1.8,
      eyeHeight: typeof def.eyeHeight === 'number' ? def.eyeHeight : 1.6,
    };

    this.position = new THREE.Vector3(0, 0, 0);  // Fußpunkt
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.yaw = 0;                 // wird vom CameraController gesetzt
    this.grounded = false;
    this.inputLocked = true;
    this.blocking = false;

    // Event-Callbacks (einfache Properties)
    this.onFootstep = null;
    this.onJump = null;
    this.onLand = null;

    // interne Zustände
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._dashTime = 0;
    this._dashVel = new THREE.Vector3();
    this._stepAcc = 0;
    // wiederverwendbare Temporaries (keine Allokationen im Hot Path)
    this._eye = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  /** Pro Frame: Input lesen, Physik integrieren, Kollision lösen. */
  update(dt) {
    if (!(dt > 0)) return;

    // Eingabewünsche (bei Lock oder Dash neutral)
    const input = this.game.input;
    let ix = 0, iz = 0, sprint = false;
    if (!this.inputLocked && input && this._dashTime <= 0) {
      ix = (input.isDown('right') ? 1 : 0) - (input.isDown('left') ? 1 : 0);
      iz = (input.isDown('forward') ? 1 : 0) - (input.isDown('back') ? 1 : 0);
      sprint = input.isDown('sprint');
    }
    // Jump-Buffer auch während Dash füttern (Absicht merken), aber nicht ausführen
    if (!this.inputLocked && input && input.wasPressed('jump')) {
      this._jumpBuffer = JUMP_BUFFER_TIME;
    } else {
      this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    }
    // Coyote-Time: am Boden auffrischen, in der Luft ablaufen lassen
    this._coyote = this.grounded ? COYOTE_TIME : Math.max(0, this._coyote - dt);

    const v = this.velocity;

    if (this._dashTime > 0) {
      // Geskriptete Dash-Geschwindigkeit: Input ignoriert, Schwerkraft pausiert
      this._dashTime -= dt;
      v.copy(this._dashVel);
      if (this._dashTime <= 0) this._endDash();
    } else {
      // Wunschrichtung relativ zur Blickrichtung (yaw)
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      const wish = this._wish.set(
        -sy * iz + cy * ix,
        0,
        -cy * iz - sy * ix
      );
      const hasInput = wish.lengthSq() > 0.0001;
      if (hasInput) wish.normalize();

      const targetSpeed = this.def.moveSpeed
        * (sprint ? this.def.sprintMult : 1)
        * (this.blocking ? BLOCK_SPEED_MULT : 1);

      if (this.grounded) {
        if (hasInput) {
          // Sofortiger Richtungswechsel: Richtung schnappt, Betrag beschleunigt
          const cur = Math.hypot(v.x, v.z);
          let spd = Math.min(cur, targetSpeed);
          spd = Math.min(spd + GROUND_ACCEL * dt, targetSpeed);
          v.x = wish.x * spd;
          v.z = wish.z * spd;
        } else {
          // Reibung ohne Input — knackiges Auslaufen
          const f = Math.max(0, 1 - GROUND_FRICTION * dt);
          v.x *= f;
          v.z *= f;
          if (Math.hypot(v.x, v.z) < 0.05) { v.x = 0; v.z = 0; }
        }
      } else if (hasInput) {
        // Luftsteuerung: sanft beschleunigen, Momentum (Dash/Knockback) erhalten
        const pre = Math.hypot(v.x, v.z);
        v.x += wish.x * AIR_ACCEL * dt;
        v.z += wish.z * AIR_ACCEL * dt;
        const post = Math.hypot(v.x, v.z);
        const limit = Math.max(pre, targetSpeed);
        if (post > limit && post > 0) {
          const s = limit / post;
          v.x *= s;
          v.z *= s;
        }
      }

      // Sprung: gepuffert + Coyote-Time
      if (this._jumpBuffer > 0 && (this.grounded || this._coyote > 0)) {
        v.y = Math.sqrt(2 * GRAVITY * this.def.jumpHeight);
        this.grounded = false;
        this._coyote = 0;
        this._jumpBuffer = 0;
        if (this.onJump) this.onJump();
      }

      // Schwerkraft mit Terminalgeschwindigkeit
      v.y = Math.max(v.y - GRAVITY * dt, -MAX_FALL_SPEED);
    }

    // Integration
    this.position.addScaledVector(v, dt);

    // Kollision: Kapsel auflösen (mutiert position und velocity)
    const preVy = v.y;
    const wasGrounded = this.grounded;
    const colliders = this.game.colliders;
    if (colliders && typeof colliders.resolveCapsule === 'function') {
      const res = colliders.resolveCapsule(
        this.position, this.def.radius, this.def.height, v, STEP_UP
      );
      this.grounded = !!(res && res.grounded);
    } else {
      // Fallback ohne Colliders: flacher Boden bei y=0
      if (this.position.y <= 0) {
        this.position.y = 0;
        if (v.y < 0) v.y = 0;
        this.grounded = true;
      } else {
        this.grounded = false;
      }
    }

    // Landung erkennen
    if (this.grounded && !wasGrounded) {
      this._stepAcc = 0;
      if (this.onLand) this.onLand(Math.max(0, -preVy));
    }

    // Schritt-Akkumulator: alle ~2.2 m Bewegung am Boden ein Schritt
    if (this.grounded && this._dashTime <= 0) {
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0.5) {
        this._stepAcc += hs * dt;
        if (this._stepAcc >= FOOTSTEP_DIST) {
          this._stepAcc -= FOOTSTEP_DIST;
          if (this.onFootstep) this.onFootstep();
        }
      } else {
        this._stepAcc = 0;
      }
    }
  }

  /** Hart versetzen (Spawn/Blink); Geschwindigkeit und Dash werden gelöscht. */
  teleport(pos, yaw) {
    toVec3(pos, this.position);
    this.velocity.set(0, 0, 0);
    this._dashTime = 0;
    this._jumpBuffer = 0;
    this._coyote = 0;
    this._stepAcc = 0;
    this.grounded = false;
    if (typeof yaw === 'number' && isFinite(yaw)) this.yaw = yaw;
  }

  /** Knockback/Leap: horizontal addieren, Aufwärtsanteil als max (kein Stapeln). */
  addImpulse(v3) {
    const imp = toVec3(v3, this._tmp);
    this._dashTime = 0; // Impuls bricht laufenden Dash ab
    this.velocity.x += imp.x;
    this.velocity.z += imp.z;
    if (imp.y > 0) {
      this.velocity.y = Math.max(this.velocity.y, imp.y);
      this.grounded = false;
    } else {
      this.velocity.y += imp.y;
    }
  }

  /** Geskriptete Dash-Bewegung: konstante Geschwindigkeit über duration. */
  startDash(dirV3, distance, duration) {
    const dur = Math.max(0.05, +duration || 0.2);
    const dist = Math.max(0, +distance || 0);
    const dir = toVec3(dirV3, this._tmp);
    if (dir.lengthSq() < 0.0001) {
      // Fallback: Blickrichtung flach
      dir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    }
    dir.normalize();
    this._dashVel.copy(dir).multiplyScalar(dist / dur);
    this._dashTime = dur;
    this.velocity.copy(this._dashVel);
  }

  // Dash beenden: horizontalen Überschuss kappen, Vertikalanteil nullen
  _endDash() {
    this._dashTime = 0;
    const maxRun = this.def.moveSpeed * this.def.sprintMult;
    const h = Math.hypot(this.velocity.x, this.velocity.z);
    if (h > maxRun && h > 0) {
      const s = maxRun / h;
      this.velocity.x *= s;
      this.velocity.z *= s;
    }
    this.velocity.y = 0;
  }

  get isDashing() {
    return this._dashTime > 0;
  }

  /** Horizontale Geschwindigkeit normiert auf max. Sprinttempo (0..1). */
  get speed01() {
    const max = this.def.moveSpeed * this.def.sprintMult;
    if (max <= 0) return 0;
    return Math.min(1, Math.hypot(this.velocity.x, this.velocity.z) / max);
  }

  /** Augenposition (wiederverwendeter Vektor — bei Bedarf kopieren). */
  get eyePos() {
    return this._eye.set(
      this.position.x,
      this.position.y + this.def.eyeHeight,
      this.position.z
    );
  }
}
