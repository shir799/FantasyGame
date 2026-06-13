/**
 * @file CameraController — First-Person-Kamera für den lokalen Spieler.
 * Mouselook ohne Smoothing (1:1), Pitch-Clamp ±85°, FOV-Lerp beim Sprint,
 * FOV-Punch/Recoil mit Abklingkurven, subtiler Headbob, Death-Cam.
 * Screen-Shake-Offsets (game.shake) werden NACH allem addiert.
 */

import * as THREE from 'three';

const BASE_FOV = 75;            // Grad
const SPRINT_FOV = 80;          // Grad beim Sprint
const BASE_SENS = 0.0023;       // rad pro Pixel bei sensitivity = 1
const MAX_PITCH = 85 * Math.PI / 180;
const BOB_AMP = 0.018;          // m Headbob-Amplitude bei speed01 = 1
const DEATH_HEIGHT = 0.4;       // m Kamerahöhe über Fußpunkt im Tod
const DEATH_DURATION = 0.6;     // s Absinkdauer
const DEATH_ROLL = 0.14;        // rad leichte Rolle im Tod
const PUNCH_DECAY = 8;          // 1/s exponentielles Abklingen FOV-Punch
const KICK_DECAY = 12;          // 1/s exponentielles Abklingen Recoil

// Glatte Hermite-Kurve für die Death-Cam
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

export class CameraController {
  constructor(game, controller) {
    this.game = game || {};
    this.controller = controller;
    if (this.controller && typeof this.controller.yaw !== 'number') {
      this.controller.yaw = 0;
    }

    this.pitch = 0;       // rad, Zielwinkel des Spielers (yaw lebt im Controller)
    this.active = true;   // false → Menü-Orbit (main.js) übernimmt

    // interne Zustände
    this._punch = 0;      // zusätzlicher FOV-Offset (Grad)
    this._kick = 0;       // Recoil-Pitch-Offset (rad)
    this._sprint01 = 0;   // geglätteter Sprint-Anteil für FOV
    this._bobPhase = 0;
    this._bobAmp = 0;
    this._deathOn = false;
    this._deathT = 0;     // 0..1 Fortschritt der Death-Cam
    this._lastFov = 0;
    // wiederverwendbare Temporaries
    this._pos = new THREE.Vector3();
    this._lookDir = new THREE.Vector3();
  }

  /** Pro Frame: Mouselook, FOV, Bob, Death-Cam, zuletzt Shake-Offsets. */
  update(dt) {
    if (!(dt > 0)) dt = 0;

    // Abklingkurven laufen immer weiter (auch wenn inaktiv)
    this._punch *= Math.exp(-PUNCH_DECAY * dt);
    if (this._punch < 0.01) this._punch = 0;
    this._kick *= Math.exp(-KICK_DECAY * dt);
    if (Math.abs(this._kick) < 0.0005) this._kick = 0;

    if (!this.active || !this.controller) return;
    const cam = this.game.camera;
    if (!cam) return;

    // Death-Cam-Fortschritt
    if (this._deathOn) {
      this._deathT = Math.min(1, this._deathT + dt / DEATH_DURATION);
    } else {
      this._deathT = Math.max(0, this._deathT - dt / 0.25);
    }

    // Mouselook: 1:1, kein Smoothing. Delta immer konsumieren,
    // im Tod aber nicht anwenden (kein Drehen der Leiche).
    const input = this.game.input;
    if (input && typeof input.consumeMouseDelta === 'function') {
      const d = input.consumeMouseDelta() || { dx: 0, dy: 0 };
      if (!this._deathOn) {
        const sens = BASE_SENS *
          ((this.game.settings && this.game.settings.sensitivity) || 1);
        this.controller.yaw -= d.dx * sens;
        this.pitch = THREE.MathUtils.clamp(
          this.pitch - d.dy * sens, -MAX_PITCH, MAX_PITCH
        );
      }
    }

    const yaw = this.controller.yaw;
    const sp01 = this.controller.speed01 || 0;

    // FOV: Lerp Richtung Sprint-FOV plus abklingender Punch
    const sprinting = !!(input && typeof input.isDown === 'function' &&
      input.isDown('sprint')) && sp01 > 0.5 && !this.controller.isDashing;
    this._sprint01 += ((sprinting ? 1 : 0) - this._sprint01) * Math.min(1, dt * 7);
    const fov = BASE_FOV + (SPRINT_FOV - BASE_FOV) * this._sprint01 + this._punch;
    if (Math.abs(fov - this._lastFov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
      this._lastFov = fov;
    }

    // Headbob: subtil, an speed01 gekoppelt, nur am Boden
    const bobActive = this.controller.grounded && !this.controller.isDashing &&
      sp01 > 0.05 && this._deathT <= 0;
    const targetAmp = bobActive ? BOB_AMP * sp01 : 0;
    this._bobAmp += (targetAmp - this._bobAmp) * Math.min(1, dt * 10);
    if (this._bobAmp > 0.0005) this._bobPhase += dt * (7 + 5 * sp01);
    const bobY = Math.sin(this._bobPhase * 2) * this._bobAmp;
    const bobX = Math.cos(this._bobPhase) * this._bobAmp * 0.7;

    // Position: Augenhöhe, Death-Cam senkt auf 0.4 m über Fußpunkt
    const eye = this.controller.eyePos; // wiederverwendeter Vektor
    this._pos.copy(eye);
    if (this._deathT > 0) {
      const e = smoothstep(this._deathT);
      const lowY = this.controller.position.y + DEATH_HEIGHT;
      this._pos.y = eye.y + (lowY - eye.y) * e;
    }
    // Bob im Kameraraum: seitlich entlang der Rechts-Achse
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    this._pos.x += cy * bobX;
    this._pos.z += -sy * bobX;
    this._pos.y += bobY;

    // Rotation: YXZ, Pitch inkl. Recoil, Rolle nur im Tod
    const effPitch = THREE.MathUtils.clamp(
      this.pitch + this._kick, -MAX_PITCH, MAX_PITCH
    );
    const roll = smoothstep(this._deathT) * DEATH_ROLL;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(effPitch, yaw, roll, 'YXZ');

    // Screen-Shake-Offsets GANZ ZULETZT addieren
    const shake = this.game.shake;
    if (shake && shake.offsetPos) this._pos.add(shake.offsetPos);
    if (shake && shake.offsetRot) {
      cam.rotation.x += shake.offsetRot.x;
      cam.rotation.y += shake.offsetRot.y;
      cam.rotation.z += shake.offsetRot.z;
    }
    cam.position.copy(this._pos);
  }

  /** Blickrichtung inkl. Recoil (wiederverwendeter Vektor — bei Bedarf kopieren). */
  get lookDir() {
    const yaw = this.controller ? this.controller.yaw : 0;
    const p = THREE.MathUtils.clamp(this.pitch + this._kick, -MAX_PITCH, MAX_PITCH);
    const cp = Math.cos(p);
    return this._lookDir.set(
      -Math.sin(yaw) * cp,
      Math.sin(p),
      -Math.cos(yaw) * cp
    );
  }

  /** Kurzer FOV-Kick (Treffer/Dash); klingt exponentiell ab. */
  fovPunch(amount) {
    this._punch = Math.min(this._punch + (+amount || 0), 12);
  }

  /** Recoil: hebt die Blickrichtung kurz an, federt zurück. */
  kick(pitchDeg) {
    this._kick = THREE.MathUtils.clamp(
      this._kick + (+pitchDeg || 0) * Math.PI / 180, -0.35, 0.35
    );
  }

  /** Death-Cam an/aus: Kamera sinkt auf 0.4 m mit leichter Rolle. */
  setDeathCam(on) {
    this._deathOn = !!on;
  }
}
