/**
 * Projectiles — gepoolter Projektil-Manager (max. 16) fuer Arkanblitz/Feuerball.
 * Eigene Projektile loesen Treffer auf (C_HIT bei Direkttreffer, Feuerball IMMER
 * C_AOE + Explosion) via Substep-Tests: erst Gegner-Kapsel, dann Welt-Raycast.
 * Remote-Projektile sind rein visuell. Max. 2 PointLights aus festem Pool.
 */
import * as THREE from 'three';
import { MSG } from '/shared/protocol.js';
import { segmentCapsuleHit } from './MeleeHitbox.js';

const POOL_SIZE = 16;
const LIGHT_POOL_SIZE = 2;
const SUBSTEP_LEN = 0.75;     // max. Substep-Laenge in m
const LIFETIME_PAD = 1.2;     // Lebenszeit = range/speed +20 %
const FIREBALL_R_MAX = 3.2;   // Fallback Explosionsradius (voll geladen)
const FIREBALL_R_MIN_FRAC = 1.2 / 3.2; // Verhaeltnis min/max (ungeladen)

// Modul-Temporaries (Hot Path)
const _from = new THREE.Vector3();
const _step = new THREE.Vector3();
const _impact = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _myCapsule = { p: new THREE.Vector3(), radius: 0.4, height: 1.8 };

// Quelle (Vector3 oder [x,y,z]) defensiv nach out kopieren
function toVec3(src, out) {
  if (src && typeof src.x === 'number') out.set(src.x, src.y, src.z);
  else if (Array.isArray(src) && src.length >= 3) out.set(src[0], src[1], src[2]);
  else out.set(0, 0, 0);
  return out;
}

export class ProjectileManager {
  constructor(game) {
    this.game = game || null;
    this._seq = 0;
    this._geo = new THREE.SphereGeometry(1, 16, 12);

    // Projektil-Pool: Meshes einmalig anlegen, unsichtbar parken
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const mesh = new THREE.Mesh(this._geo, mat);
      mesh.visible = false;
      if (game && game.scene) game.scene.add(mesh);
      this.pool.push({
        active: false, seq: 0, mesh,
        dir: new THREE.Vector3(),
        speed: 0, life: 0, maxLife: 0,
        slot: 'primary', kind: 'projectile', isLocal: false,
        charge: 0, bodyRadius: 0.25, explosionRadius: 0, color: 0xffffff,
        light: null, trail: null,
      });
    }

    // Licht-Pool: maximal 2 dynamische PointLights gleichzeitig
    this.lights = [];
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 8, 2);
      light.visible = false;
      if (game && game.scene) game.scene.add(light);
      this.lights.push({ light, owner: null });
    }
  }

  // Eigenes Projektil: loest spaeter C_HIT/C_AOE aus
  spawnLocal({ slot, def, origin, dir, charge, color } = {}) {
    this._spawn({ slot, def, origin, dir, charge, color }, true);
  }

  // Gegner-Projektil: nur Visual + kosmetische Explosion, keine Nachrichten
  spawnRemote({ slot, def, origin, dir, charge, color } = {}) {
    this._spawn({ slot, def, origin, dir, charge, color }, false);
  }

  _spawn(opts, isLocal) {
    const def = opts.def || {};
    const p = this._acquire();
    p.active = true;
    p.seq = ++this._seq;
    p.isLocal = isLocal;
    p.slot = opts.slot || 'primary';
    p.kind = def.kind === 'charged_projectile' ? 'charged_projectile' : 'projectile';
    p.charge = Math.min(1, Math.max(0, opts.charge || 0));

    toVec3(opts.origin, p.mesh.position);
    toVec3(opts.dir, p.dir);
    if (p.dir.lengthSq() < 1e-9) p.dir.set(0, 0, -1);
    p.dir.normalize();

    p.speed = def.speed || 30;
    const range = def.range || 40;
    p.maxLife = (range / p.speed) * LIFETIME_PAD;
    p.life = 0;

    const charged = p.kind === 'charged_projectile';
    if (charged) {
      // Feuerball: Kugelgroesse und Explosionsradius wachsen mit charge
      p.bodyRadius = 0.22 + 0.28 * p.charge;
      const maxR = def.radius || FIREBALL_R_MAX;
      const minR = maxR * FIREBALL_R_MIN_FRAC;
      p.explosionRadius = minR + (maxR - minR) * p.charge;
    } else {
      p.bodyRadius = def.radius || 0.25;
      p.explosionRadius = 0;
    }

    p.color = (opts.color != null) ? opts.color : (charged ? 0xff7733 : 0x66ccff);
    p.mesh.material.color.setHex(p.color);
    p.mesh.scale.setScalar(p.bodyRadius);
    p.mesh.visible = true;

    // Schweif + Lichtzuteilung (Feuerball hat Vorrang)
    const vfx = this.game && this.game.vfx;
    p.trail = (vfx && typeof vfx.trail === 'function') ? vfx.trail(p.mesh, p.color) : null;
    this._assignLight(p, charged);
  }

  // Freien Pool-Eintrag holen, sonst aeltestes aktives Projektil recyceln
  _acquire() {
    let oldest = null;
    for (const p of this.pool) {
      if (!p.active) return p;
      if (!oldest || p.seq < oldest.seq) oldest = p;
    }
    this._despawn(oldest);
    return oldest;
  }

  _assignLight(p, priority) {
    let slot = null;
    for (const s of this.lights) {
      if (!s.owner) { slot = s; break; }
    }
    if (!slot && priority) {
      // Feuerball darf einem gewoehnlichen Projektil das Licht nehmen
      for (const s of this.lights) {
        if (s.owner && s.owner.kind !== 'charged_projectile') { slot = s; break; }
      }
    }
    if (!slot) return;
    if (slot.owner) slot.owner.light = null;
    slot.owner = p;
    p.light = slot.light;
    const charged = p.kind === 'charged_projectile';
    slot.light.color.setHex(p.color);
    slot.light.intensity = charged ? 2.5 + 3.5 * p.charge : 1.8;
    slot.light.distance = charged ? 7 + 5 * p.charge : 6;
    slot.light.position.copy(p.mesh.position);
    slot.light.visible = true;
  }

  _releaseLight(p) {
    if (!p.light) return;
    for (const s of this.lights) {
      if (s.owner === p) {
        s.owner = null;
        s.light.visible = false;
        s.light.intensity = 0;
      }
    }
    p.light = null;
  }

  // Gegner-Kapsel fuer eigene Projektile (kann null sein)
  _enemyCapsule() {
    const remote = this.game && this.game.remote;
    const c = remote ? remote.capsule : null;
    return (c && c.p) ? c : null;
  }

  // Eigene Kapsel fuer kosmetische Treffer von Remote-Projektilen
  _localCapsule() {
    const local = this.game && this.game.local;
    if (!local || !local.controller || !local.controller.position || !local.def) return null;
    _myCapsule.p.copy(local.controller.position);
    _myCapsule.radius = local.def.radius || 0.4;
    _myCapsule.height = local.def.height || 1.8;
    return _myCapsule;
  }

  update(dt) {
    if (!(dt > 0)) return;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life += dt;

      // Strecke segmentiert pruefen: erst Kapsel, dann Welt — pro Substep
      const travel = p.speed * dt;
      const steps = Math.max(1, Math.ceil(travel / SUBSTEP_LEN));
      const stepLen = travel / steps;
      const capsule = p.isLocal ? this._enemyCapsule() : this._localCapsule();
      const colliders = this.game && this.game.colliders;
      let resolved = false;

      for (let i = 0; i < steps; i++) {
        _from.copy(p.mesh.position);
        _step.copy(p.dir).multiplyScalar(stepLen);
        p.mesh.position.add(_step);

        if (capsule) {
          const hit = segmentCapsuleHit(_from, p.mesh.position, p.bodyRadius, capsule);
          if (hit.hit) {
            this._onImpact(p, hit.point, true, null);
            resolved = true;
            break;
          }
        }
        if (colliders && typeof colliders.raycast === 'function') {
          const rc = colliders.raycast(_from, p.dir, stepLen + p.bodyRadius);
          if (rc && rc.hit) {
            this._onImpact(p, rc.point, false, rc.normal);
            resolved = true;
            break;
          }
        }
      }
      if (resolved) continue;

      if (p.life >= p.maxLife) {
        this._onExpire(p);
        continue;
      }
      if (p.light) p.light.position.copy(p.mesh.position);
    }
  }

  // Einschlag (Kapsel oder Welt) aufloesen
  _onImpact(p, pointV3, hitEnemy, normal) {
    _impact.copy(pointV3);
    const game = this.game;
    const charged = p.kind === 'charged_projectile';

    if (charged) {
      // Feuerball: lokal IMMER als Flaechenschaden melden, remote nur Kosmetik
      if (p.isLocal && game && game.net && typeof game.net.send === 'function') {
        game.net.send(MSG.C_AOE, { slot: p.slot, center: [_impact.x, _impact.y, _impact.z] });
      }
      this._explode(p, _impact);
    } else {
      if (p.isLocal && hitEnemy && game && game.remote && game.net &&
          typeof game.net.send === 'function') {
        game.net.send(MSG.C_HIT, {
          slot: p.slot,
          targetId: game.remote.id,
          point: [_impact.x, _impact.y, _impact.z],
          charge: p.charge,
        });
      }
      if (game && game.vfx && typeof game.vfx.hitSparks === 'function') {
        if (normal && typeof normal.x === 'number') _normal.copy(normal);
        else _normal.copy(p.dir).negate();
        game.vfx.hitSparks(_impact, _normal, p.color);
      }
    }
    this._despawn(p);
  }

  // Lebenszeit abgelaufen: Feuerball detoniert am Ende der Reichweite
  _onExpire(p) {
    if (p.kind === 'charged_projectile') {
      _impact.copy(p.mesh.position);
      const game = this.game;
      if (p.isLocal && game && game.net && typeof game.net.send === 'function') {
        game.net.send(MSG.C_AOE, { slot: p.slot, center: [_impact.x, _impact.y, _impact.z] });
      }
      this._explode(p, _impact);
    }
    this._despawn(p);
  }

  _explode(p, pointV3) {
    const game = this.game;
    const radius = p.explosionRadius || 1.2;
    if (game && game.vfx && typeof game.vfx.explosion === 'function') {
      game.vfx.explosion(pointV3, radius, 'fire');
    }
    if (game && game.audio && typeof game.audio.play === 'function') {
      const id = p.charge >= 0.5 ? 'explosion_big' : 'explosion_small';
      game.audio.play(id, { pos: { x: pointV3.x, y: pointV3.y, z: pointV3.z } });
    }
  }

  // Projektil deaktivieren, Handles freigeben
  _despawn(p) {
    p.active = false;
    p.mesh.visible = false;
    if (p.trail && typeof p.trail.dispose === 'function') p.trail.dispose();
    p.trail = null;
    this._releaseLight(p);
  }

  // Rundenwechsel: alles still entfernen (keine Nachrichten, keine Explosionen)
  clear() {
    for (const p of this.pool) {
      if (p.active) this._despawn(p);
    }
  }
}
