/**
 * @file RemotePlayer — Darstellung des Gegners (oder Trainings-Dummys).
 * Puffert S_STATE-Snapshots (gestempelt mit net.serverNow()) in einem Ringpuffer
 * und interpoliert auf serverNow() - INTERP_DELAY_MS. Trägt Charakter-Rig,
 * Nameplate und Hit-Flash. Dummy-Variante ist statisch ohne Interpolation.
 */

import * as THREE from 'three';
import { INTERP_DELAY_MS } from '../../shared/protocol.js';
import { getClass } from '../../shared/classes.js';
import { buildRig, makeNameplate } from '../characters/CharacterRig.js';

const BUFFER_MAX = 90;        // Snapshots im Ringpuffer (~3 s bei 30 Hz)
const FLASH_TIME = 0.12;      // s Dauer des Hit-Flash
const FLASH_COLOR = new THREE.Color(0xff6644);
const TWO_PI = Math.PI * 2;

// Winkel-Lerp über den kürzesten Weg
function lerpAngle(a, b, t) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

export class RemotePlayer {
  constructor(game, { id, name, classId } = {}) {
    this.game = game || {};
    this.id = id != null ? id : 'remote';
    this.classId = classId || 'knight';
    this.isDummy = this.classId === 'dummy';
    this.name = name || (this.isDummy ? 'Trainingsgolem' : 'Gegner');

    // Klassendaten; Dummy hat keinen Eintrag in CLASSES → Fallback-Maße
    const def = typeof getClass === 'function' ? getClass(this.classId) : null;
    this.def = def || {
      radius: 0.45, height: 1.9, eyeHeight: 1.6, moveSpeed: 5.5, sprintMult: 1.3,
    };

    // Szenen-Aufbau: Gruppe trägt Rig + Nameplate, Gruppe steht am Fußpunkt
    this.group = new THREE.Group();
    this.group.name = 'remote_' + this.id;
    this.rig = typeof buildRig === 'function'
      ? buildRig(this.classId, { firstPerson: false })
      : null;
    if (this.rig && this.rig.group) this.group.add(this.rig.group);

    this.nameplate = typeof makeNameplate === 'function'
      ? makeNameplate(this.name)
      : null;
    if (this.nameplate && this.nameplate.sprite) {
      this.nameplate.sprite.position.set(0, this.def.height + 0.45, 0);
      this.group.add(this.nameplate.sprite);
    }
    if (this.game.scene) this.game.scene.add(this.group);

    // Optionale Pitch-Weitergabe ans Rig (Kopf), falls unterstützt
    this._head = this.rig && this.rig.group
      ? (this.rig.group.getObjectByName('head') ||
         this.rig.group.getObjectByName('Head'))
      : null;

    // Materialien mit Emissive für den Hit-Flash einsammeln (dedupliziert)
    this._flashMats = [];
    const seen = new Set();
    this.group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || !m.emissive || seen.has(m)) continue;
        seen.add(m);
        this._flashMats.push({
          m,
          base: m.emissive.clone(),
          baseI: typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 1,
        });
      }
    });

    // Snapshot-Ringpuffer + Interpolations-Zustand
    this._buf = [];
    this._lastAnim = null;
    this._pitch = 0;
    this._move01 = 0;
    this._lastPos = this.group.position.clone();
    this._healthFrac = 1;
    this._dead = false;
    this._flashT = 0;
    this._disposed = false;
    // Kapsel-Objekt wiederverwenden; p referenziert die Live-Position
    this._capsule = {
      p: this.group.position,
      radius: this.def.radius,
      height: this.def.height,
    };
  }

  // Serverzeit (Fallback: lokale Zeit, falls Netz fehlt)
  _now() {
    const net = this.game.net;
    return net && typeof net.serverNow === 'function' ? net.serverNow() : Date.now();
  }

  /** Rohe S_STATE-Payload puffern, gestempelt mit der Server-Empfangszeit. */
  pushState(msg) {
    if (this._disposed || !msg) return;
    const p = Array.isArray(msg.p) ? msg.p : null;
    if (!p) return;

    if (this.isDummy) {
      // Dummy ist statisch: Position direkt setzen, keine Interpolation
      this.group.position.set(+p[0] || 0, +p[1] || 0, +p[2] || 0);
      if (typeof msg.ry === 'number') this.group.rotation.y = msg.ry;
      return;
    }

    const snap = {
      t: this._now(),
      p: [+p[0] || 0, +p[1] || 0, +p[2] || 0],
      ry: typeof msg.ry === 'number' ? msg.ry : 0,
      pitch: typeof msg.pitch === 'number' ? msg.pitch : 0,
      anim: msg.anim || null,
    };
    // Zeitstempel strikt monoton halten
    const last = this._buf[this._buf.length - 1];
    if (last && snap.t <= last.t) snap.t = last.t + 1;
    this._buf.push(snap);
    if (this._buf.length > BUFFER_MAX) this._buf.shift();
    if (snap.anim) this._lastAnim = snap.anim;
  }

  // Auf Renderzeit interpolieren; ohne neue Daten am letzten Snapshot halten
  _interpolate() {
    const buf = this._buf;
    if (buf.length === 0) return;
    const rt = this._now() - INTERP_DELAY_MS;

    // Veraltete Snapshots verwerfen, buf[0] bleibt der letzte vor rt
    while (buf.length >= 2 && buf[1].t <= rt) buf.shift();

    const a = buf[0];
    let b = a, k = 0;
    if (buf.length > 1 && buf[1].t > a.t && rt > a.t) {
      b = buf[1];
      k = Math.min(1, (rt - a.t) / (b.t - a.t));
    }
    this.group.position.set(
      a.p[0] + (b.p[0] - a.p[0]) * k,
      a.p[1] + (b.p[1] - a.p[1]) * k,
      a.p[2] + (b.p[2] - a.p[2]) * k
    );
    this.group.rotation.y = lerpAngle(a.ry, b.ry, k);
    this._pitch = a.pitch + (b.pitch - a.pitch) * k;
  }

  // Pitch an den Rig-Kopf weitergeben, sofern das Rig es zulässt
  _applyPitch() {
    if (!this.rig) return;
    if (typeof this.rig.setPitch === 'function') {
      this.rig.setPitch(this._pitch);
    } else if (this._head) {
      // Abgeschwächt, damit es natürlich wirkt
      this._head.rotation.x = THREE.MathUtils.clamp(this._pitch, -1, 1) * 0.6;
    }
  }

  /** Pro Frame: Interpolation, Bewegungs-Schätzung, Rig-Anim, Flash-Abkling. */
  update(dt) {
    if (this._disposed) return;
    if (!(dt > 0)) dt = 0;

    if (!this.isDummy) this._interpolate();

    // Bewegungstempo aus der Positionsdifferenz schätzen (geglättet)
    if (dt > 0 && !this.isDummy) {
      const dx = this.group.position.x - this._lastPos.x;
      const dz = this.group.position.z - this._lastPos.z;
      const maxSpeed = (this.def.moveSpeed || 5.5) * (this.def.sprintMult || 1.3);
      const target = Math.min(1, Math.hypot(dx, dz) / dt / maxSpeed);
      this._move01 += (target - this._move01) * Math.min(1, dt * 8);
    }

    if (this.rig) {
      if (typeof this.rig.setMove === 'function') {
        this.rig.setMove(this.isDummy ? 0 : this._move01);
      }
      const anim = this._lastAnim;
      if (anim) {
        if (typeof this.rig.setBlocking === 'function') {
          this.rig.setBlocking(!!anim.blocking);
        }
        if (typeof this.rig.setBreath === 'function') {
          this.rig.setBreath(!!anim.breath);
        }
        if (typeof this.rig.setCharging === 'function') {
          const c = anim.charging;
          this.rig.setCharging(typeof c === 'number' ? c : (c ? 1 : 0));
        }
      }
      if (typeof this.rig.update === 'function') this.rig.update(dt);
      this._applyPitch();
    }

    // Hit-Flash abklingen lassen, am Ende exakt zurücksetzen
    if (this._flashT > 0) {
      this._flashT = Math.max(0, this._flashT - dt);
      const k = this._flashT / FLASH_TIME;
      for (const e of this._flashMats) {
        if (k > 0) {
          e.m.emissive.copy(e.base).lerp(FLASH_COLOR, k);
          e.m.emissiveIntensity = e.baseI + 2.5 * k;
        } else {
          e.m.emissive.copy(e.base);
          e.m.emissiveIntensity = e.baseI;
        }
      }
    }

    this._lastPos.copy(this.group.position);
  }

  /** Angriffs-Animation am Rig auslösen. */
  playAttack(slot) {
    if (this._disposed) return;
    if (this.rig && typeof this.rig.playAttack === 'function') {
      this.rig.playAttack(slot);
    }
  }

  /** HP-Anteil 0..1 für Nameplate; 0 löst die Sterbe-Pose aus. */
  setHealth(frac) {
    if (this._disposed) return;
    this._healthFrac = THREE.MathUtils.clamp(+frac || 0, 0, 1);
    if (this.nameplate && typeof this.nameplate.setHealth === 'function') {
      this.nameplate.setHealth(this._healthFrac);
    }
    if (this._healthFrac <= 0 && !this._dead) {
      this._dead = true;
      if (this.rig && typeof this.rig.die === 'function') this.rig.die();
    } else if (this._healthFrac > 0 && this._dead) {
      this._dead = false;
      if (this.rig && typeof this.rig.reset === 'function') this.rig.reset();
    }
  }

  /** Kurzer Emissive-Flash am Rig als Treffer-Feedback. */
  onDamaged(point) {
    if (this._disposed) return;
    this._flashT = FLASH_TIME;
  }

  /** Interpolierte Fußpunkt-Position (Live-Vektor — bei Bedarf kopieren). */
  get position() {
    return this.group.position;
  }

  /** Kapsel für Treffertests: {p (Fußpunkt), radius, height}. */
  get capsule() {
    return this._capsule;
  }

  /** Aus der Szene entfernen; Nameplate-Ressourcen freigeben. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.group.parent) this.group.parent.remove(this.group);
    if (this.nameplate && typeof this.nameplate.dispose === 'function') {
      this.nameplate.dispose();
    }
    this._buf.length = 0;
    this._flashMats.length = 0;
  }
}
