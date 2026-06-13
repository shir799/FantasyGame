/**
 * ScreenShake — Trauma-basiertes Kamera-Wackeln.
 * add(amount) erhoeht Trauma (0..1), Abklingrate 1.4/s, Offset ∝ trauma².
 * Rauschen aus Sinus-Summen mit Primzahl-Frequenzen (glatt, nicht periodisch wirkend).
 * CameraController addiert offsetPos/offsetRot NACH dem Mouselook.
 */
import * as THREE from 'three';

const MAX_POS = 0.12;                              // m, maximaler Positions-Offset
const MAX_ROT = THREE.MathUtils.degToRad(0.7);     // rad, maximaler Rotations-Offset
const DECAY = 1.4;                                 // Trauma-Abkling pro Sekunde

export class ScreenShake {
  constructor() {
    this.trauma = 0;
    this.offsetPos = new THREE.Vector3();
    this.offsetRot = new THREE.Euler();
    // Zufaellige Startphase, damit Shakes nicht immer identisch beginnen
    this._t = Math.random() * 100;
  }

  /** Trauma hinzufuegen, geclampt auf [0,1]. */
  add(amount) {
    const a = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    this.trauma = Math.min(1, this.trauma + a);
  }

  /** Pro Frame: Trauma abklingen lassen und Offsets neu wuerfeln. */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.016;
    this._t += dt;
    this.trauma = Math.max(0, this.trauma - DECAY * dt);
    const s = this.trauma * this.trauma;
    if (s < 1e-5) {
      this.offsetPos.set(0, 0, 0);
      this.offsetRot.set(0, 0, 0);
      return;
    }
    const t = this._t;
    // Pseudo-Perlin: zwei Sinus mit Primzahl-Frequenzen, per Phase dekorreliert
    const n = (f1, f2, phase) =>
      Math.sin(t * f1 + phase) * 0.62 + Math.sin(t * f2 + phase * 2.17) * 0.38;
    this.offsetPos.set(
      n(13, 29, 1) * MAX_POS * s,
      n(17, 31, 11) * MAX_POS * s,
      n(19, 37, 23) * MAX_POS * s * 0.5
    );
    this.offsetRot.set(
      n(23, 41, 5) * MAX_ROT * s,
      n(29, 43, 7) * MAX_ROT * s,
      n(31, 47, 13) * MAX_ROT * s
    );
  }
}
