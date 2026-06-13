/**
 * CombatSystem.js — Integrator des Kampfes: liest Input, führt je Klasse/Slot die
 * Fähigkeiten lokal aus (Melee, Projektil, Charge, Atem, Blink, Dash, Schild, Leap,
 * Flächenangriffe inkl. Windup/Telegraph), sendet die Netz-Events (C_ATTACK/C_HIT/
 * C_BREATH/C_AOE) und verarbeitet S_ATTACK/S_DAMAGE/S_SHIELD/S_DEATH inkl. VFX,
 * Audio, Screenshake, Hitmarker und Knockback. Server bleibt Schadensautorität.
 */
import * as THREE from 'three';
import { MSG } from '/shared/protocol.js';
import { getClass } from '/shared/classes.js';
import { coneHit } from './MeleeHitbox.js';

const UP = new THREE.Vector3(0, 1, 0);

// Hilfen: Vektor ↔ Array
function arr(v) { return [v.x, v.y, v.z]; }
function vec(a) {
  if (a && a.isVector3) return a.clone();
  if (Array.isArray(a)) return new THREE.Vector3(+a[0] || 0, +a[1] || 0, +a[2] || 0);
  return new THREE.Vector3();
}

export class CombatSystem {
  constructor(game) {
    this.game = game;
    this.combatEnabled = false;

    // Zustände
    this._blocking = false;
    this._charging = false;
    this._breathing = false;
    this._breathTimer = 0;
    this._cast = null;          // { t, run } verzögerter eigener Cast (Windup)
    this._remoteFx = [];        // [{ t, run }] verzögerte Gegner-Effekte (Telegraph→Blast)
    this._dashSlot = null;
    this._dashHit = false;

    // VFX-/Audio-Handles
    this._chargeLoop = null;
    this._breathCone = null;
    this._breathLoop = null;
    this._myShield = null;
    this._remoteShield = null;
    this._remoteBreath = null;
    this._remoteBreathLoop = null;

    // Hilfsobjekte
    this._remoteAnim = null;
    this._localMuzzle = null;   // Mündung am Kamera-Kind (für Atem-Kegel)
    this._remoteMuzzle = null;
    this._anchor = new THREE.Object3D(); // folgt dem lokalen Spieler (Schildblase)
    if (game && game.scene) game.scene.add(this._anchor);

    this._ndc = new THREE.Vector3();
  }

  // --- Kurzzugriffe ---------------------------------------------------------
  get _local() { return this.game.local; }
  get _ab() { return this.game.local ? this.game.local.abilities : null; }
  get _ctrl() { return this.game.local ? this.game.local.controller : null; }
  get _camCtl() { return this.game.local ? this.game.local.cameraCtl : null; }
  get _vm() { return this.game.local ? this.game.local.viewmodel : null; }

  _eye() { return this._ctrl.eyePos.clone(); }
  _look() { return this._camCtl.lookDir.clone(); }
  _flatLook() {
    const d = this._camCtl.lookDir.clone(); d.y = 0;
    if (d.lengthSq() < 1e-6) { const y = this._ctrl.yaw; d.set(-Math.sin(y), 0, -Math.cos(y)); }
    return d.normalize();
  }

  // =========================================================================
  // Frame-Update
  // =========================================================================
  update(dt) {
    this._tickScheduled(dt);
    this._updateRemoteFx(dt);

    // Anker dem lokalen Spieler nachführen (für Schildblase)
    if (this._ctrl) this._anchor.position.copy(this._ctrl.position);

    const local = this._local;
    if (!local) { this._stopBreath(); this._cancelCharge(); this._blocking = false; return; }

    const input = this.game.input;
    const active = this.combatEnabled && input && input.locked && !local.controller.inputLocked;

    // Block (Halten) — nur Klassen mit block-Fähigkeit (Ritter: Q)
    let blocking = false;
    if (active && this._blockSlot) blocking = input.isDown(this._blockSlot);
    if (blocking !== this._blocking) {
      this._blocking = blocking;
      if (this._vm) this._vm.setBlocking(blocking);
    }
    local.controller.blocking = blocking;

    this._updateDash();

    if (!active) { this._stopBreath(); this._cancelCharge(); return; }

    // Laufende Kanäle (Atem/Ladung) abhängig vom Sekundär-Kind
    this._handleChannels(dt);

    // Keine neuen Aktionen während eines Windups
    if (this._cast) return;

    const a = local.def.abilities;
    if (input.wasPressed('primary') && a.primary) this._tryPrimary(a.primary);
    if (input.wasPressed('secondary') && a.secondary) this._trySecondary(a.secondary);
    if (input.wasPressed('skill1') && a.skill1) this._trySkill('skill1', a.skill1);
    if (input.wasPressed('skill2') && a.skill2) this._trySkill('skill2', a.skill2);
    if (input.wasPressed('ultimate') && a.ultimate) this._tryUltimate(a.ultimate);
  }

  // Slot der block-Fähigkeit (oder null) – einmalig je Klasse bestimmt
  get _blockSlot() {
    const a = this._local && this._local.def ? this._local.def.abilities : null;
    if (!a) return null;
    for (const s of ['primary', 'secondary', 'skill1', 'skill2', 'ultimate']) {
      if (a[s] && a[s].kind === 'block') return s;
    }
    return null;
  }

  // --- Eingaben → Aktionen --------------------------------------------------
  _tryPrimary(def) {
    if (!this._ab.isReady('primary')) return;
    if (def.kind === 'projectile') this._fireProjectile('primary', def, def.kind === 'projectile' ? this._color('primary') : 0xffffff);
    else if (def.kind === 'melee') this._doMelee('primary', def);
  }

  _trySecondary(def) {
    if (def.kind === 'charged_projectile') {
      if (this._ab.isReady('secondary') && !this._charging) this._beginCharge();
    } else if (def.kind === 'melee') {
      if (this._ab.isReady('secondary')) {
        this.game.audio.play('heavy_swing', { vol: 0.6 });
        this._beginCast(def.windup || 0.3, () => this._doMelee('secondary', def));
      }
    }
    // breath: über Halten in _handleChannels
  }

  _trySkill(slot, def) {
    if (def.kind === 'block') return;          // Block über Halten
    if (!this._ab.isReady(slot)) return;
    switch (def.kind) {
      case 'blink': this._doBlink(slot, def); break;
      case 'dash': this._doDash(slot, def); break;
      case 'shield': this._doShield(slot, def); break;
      case 'leap': this._doLeap(slot, def); break;
      case 'aoe_self': this._doAoeSelf(slot, def); break;
      default: break;
    }
  }

  _tryUltimate(def) {
    if (!this._ab.isReady('ultimate')) return;
    if (def.kind === 'aoe_target') this._doNova('ultimate', def);
    else if (def.kind === 'aoe_self') this._doAoeSelf('ultimate', def);
  }

  // --- Kanäle: Ladung (Feuerball) & Atem (Drache) ---------------------------
  _handleChannels(dt) {
    const local = this._local, ab = this._ab, input = this.game.input;
    const sec = local.def.abilities.secondary;
    if (!sec) return;

    if (sec.kind === 'charged_projectile' && this._charging) {
      if (this._vm) this._vm.setCharging(ab.charge01);
      if (!input.isDown('secondary')) this._releaseFireball(sec);
    } else if (sec.kind === 'breath') {
      if (input.isDown('secondary') && !this._cast) {
        if (ab.drainBreath(dt)) {
          this._startBreath();
          this._breathTimer += dt;
          if (this._breathTimer >= 0.25) { this._breathTimer -= 0.25; this._breathHitCheck(sec); }
        } else {
          this._stopBreath();
        }
      } else {
        this._stopBreath();
      }
    }
  }

  _beginCharge() {
    this._ab.beginCharge();
    this._charging = true;
    if (this._vm) this._vm.setCharging(0);
    this._chargeLoop = this.game.audio.loop('charge_loop', { vol: 0.5 });
  }

  _cancelCharge() {
    if (!this._charging) return;
    if (this._ab) this._ab.endCharge();
    this._charging = false;
    if (this._vm) this._vm.setCharging(0);
    if (this._chargeLoop) { this._chargeLoop.stop(); this._chargeLoop = null; }
  }

  _releaseFireball(def) {
    const c = this._ab.endCharge();
    this._charging = false;
    if (this._chargeLoop) { this._chargeLoop.stop(); this._chargeLoop = null; }
    if (this._vm) this._vm.setCharging(0);
    this._ab.trigger('secondary');
    const origin = this._eye().addScaledVector(this._look(), 0.6);
    const dir = this._look();
    this.game.projectiles.spawnLocal({ slot: 'secondary', def, origin, dir, charge: c, color: 0xff7733 });
    this.game.net.send(MSG.C_ATTACK, { slot: 'secondary', origin: arr(origin), dir: arr(dir), charge: c });
    if (this._vm) this._vm.playAttack('secondary');
    this.game.audio.play('fireball_launch');
    this._camCtl.fovPunch(2 + c * 3); this._camCtl.kick(1.5 + c * 2);
  }

  _startBreath() {
    if (this._breathing) return;
    this._breathing = true;
    this._ensureLocalMuzzle();
    this._breathCone = this.game.vfx.breathCone(this._localMuzzle, 0xff7a22);
    this._breathCone.set(true);
    this._breathLoop = this.game.audio.loop('breath_loop', { vol: 0.7 });
    if (this._vm) this._vm.setBreath(true);
  }

  _stopBreath() {
    if (!this._breathing) return;
    this._breathing = false;
    this._breathTimer = 0;
    if (this._breathCone) { this._breathCone.dispose(); this._breathCone = null; }
    if (this._breathLoop) { this._breathLoop.stop(); this._breathLoop = null; }
    if (this._vm) this._vm.setBreath(false);
  }

  _breathHitCheck(def) {
    const remote = this.game.remote;
    if (!remote) return;
    const origin = this._eye(), dir = this._look();
    const hit = coneHit(origin, dir, def.range, def.arcDeg, remote.capsule);
    if (hit.hit) this.game.net.send(MSG.C_BREATH, { targetId: remote.id, point: arr(hit.point) });
  }

  // --- Konkrete Aktionen ----------------------------------------------------
  _doMelee(slot, def) {
    this._ab.trigger(slot);
    const origin = this._eye(), dir = this._look();
    this.game.net.send(MSG.C_ATTACK, { slot, origin: arr(origin), dir: arr(dir), charge: 0 });
    if (this._vm) this._vm.playAttack(slot);
    const cls = this._local.classId;
    const swing = slot === 'secondary' ? 'heavy_swing' : (cls === 'dragon' ? 'claw' : 'sword_swing');
    this.game.audio.play(swing);
    this._camCtl.fovPunch(slot === 'secondary' ? 2.5 : 1.2);
    this._camCtl.kick(slot === 'secondary' ? 2 : 0.8);
    const remote = this.game.remote;
    if (remote) {
      const hit = coneHit(origin, dir, def.range, def.arcDeg || 60, remote.capsule);
      if (hit.hit) {
        this.game.net.send(MSG.C_HIT, { slot, targetId: remote.id, point: arr(hit.point), charge: 0 });
      }
    }
  }

  _fireProjectile(slot, def, color) {
    this._ab.trigger(slot);
    const origin = this._eye().addScaledVector(this._look(), 0.5);
    const dir = this._look();
    this.game.projectiles.spawnLocal({ slot, def, origin, dir, charge: 0, color });
    this.game.net.send(MSG.C_ATTACK, { slot, origin: arr(origin), dir: arr(dir), charge: 0 });
    if (this._vm) this._vm.playAttack(slot);
    this.game.audio.play('cast_arcane');
    this.game.vfx.muzzleFlash(origin, color);
    this._camCtl.fovPunch(1); this._camCtl.kick(0.6);
  }

  _doBlink(slot, def) {
    this._ab.trigger(slot);
    const from = this._ctrl.position.clone();
    const dir = this._flatLook();
    let dist = def.range;
    const rc = this.game.colliders.raycast(this._eye(), dir, def.range + 0.5);
    if (rc && rc.hit) dist = Math.max(0, rc.dist - 0.6);
    const to = from.clone().addScaledVector(dir, dist);
    this._ctrl.teleport(to, this._ctrl.yaw);
    this.game.net.send(MSG.C_ATTACK, { slot, origin: arr(from), dir: arr(dir), charge: 0 });
    this.game.vfx.blinkFlash(from, to, 0x9b5cff);
    this.game.audio.play('blink');
    this._camCtl.fovPunch(3);
    if (this._vm) this._vm.playAttack(slot);
  }

  _doDash(slot, def) {
    this._ab.trigger(slot);
    const dir = this._flatLook();
    this._ctrl.startDash(dir, def.range, def.duration || 0.35);
    this.game.net.send(MSG.C_ATTACK, { slot, origin: arr(this._eye()), dir: arr(dir), charge: 0 });
    this.game.audio.play('dash');
    this._camCtl.fovPunch(4);
    if (this._vm) this._vm.playAttack(slot);
    this._dashSlot = slot; this._dashHit = false;
  }

  _updateDash() {
    if (!this._dashSlot) return;
    const ctrl = this._ctrl, remote = this.game.remote;
    if (!ctrl || !ctrl.isDashing) { this._dashSlot = null; return; }
    if (this._dashHit || !remote) return;
    const reach = (this._local.def.radius || 0.4) + (remote.def.radius || 0.5) + 1.2;
    if (ctrl.position.distanceTo(remote.position) < reach) {
      this._dashHit = true;
      const point = remote.position.clone(); point.y += 1.0;
      this.game.net.send(MSG.C_HIT, { slot: this._dashSlot, targetId: remote.id, point: arr(point), charge: 0 });
    }
  }

  _doShield(slot, def) {
    this._ab.trigger(slot);
    this.game.net.send(MSG.C_ATTACK, { slot, origin: arr(this._eye()), dir: arr(this._look()), charge: 0 });
    if (this._vm) this._vm.playAttack(slot);
    // Sichtbare Blase kommt über S_SHIELD (handleShield)
  }

  _doLeap(slot, def) {
    this._ab.trigger(slot);
    const dir = this._flatLook();
    this._ctrl.addImpulse({ x: dir.x * (def.impulseForward || 9), y: def.impulseUp || 7, z: dir.z * (def.impulseForward || 9) });
    this.game.net.send(MSG.C_ATTACK, { slot, origin: arr(this._eye()), dir: arr(dir), charge: 0 });
    this.game.audio.play('tail_whoosh');
    this._camCtl.fovPunch(4);
    if (this._vm) this._vm.playAttack(slot);
  }

  _doAoeSelf(slot, def) {
    this._ab.trigger(slot);
    const origin = this._eye(), dir = this._look();
    this.game.net.send(MSG.C_ATTACK, { slot, origin: arr(origin), dir: arr(dir), charge: 0 });
    if (this._vm) this._vm.playAttack(slot);
    const cls = this._local.classId;
    const fire = () => {
      const center = this._ctrl.position.clone();
      this.game.net.send(MSG.C_AOE, { slot, center: arr(center) });
      this._aoeBlastLocal(cls, slot, def, center);
    };
    const windup = def.windup || 0;
    if (windup > 0) {
      this.game.audio.play(cls === 'dragon' ? 'roar' : 'nova_cast');
      this.game.vfx.novaTelegraph(this._ctrl.position.clone(), def.radius, windup);
      this._beginCast(windup, fire);
    } else {
      fire();
    }
  }

  _aoeBlastLocal(cls, slot, def, center) {
    const vfx = this.game.vfx, audio = this.game.audio, cam = this._camCtl;
    if (cls === 'dragon' && slot === 'ultimate') {
      vfx.explosion(center, def.radius, 'fire'); vfx.groundSlam(center, def.radius);
      audio.play('explosion_big'); audio.play('roar');
      this.game.shake.add(1.0); cam.fovPunch(7); cam.kick(3);
    } else if (cls === 'dragon') {
      vfx.shockwave(center, def.radius, 0xff7a22); vfx.groundSlam(center, def.radius * 0.7);
      audio.play('tail_whoosh'); audio.play('slam', { vol: 0.6 });
      this.game.shake.add(0.55); cam.fovPunch(4); cam.kick(1.5);
    } else {
      vfx.groundSlam(center, def.radius); vfx.shockwave(center, def.radius, 0xff9a3d);
      audio.play('slam');
      this.game.shake.add(0.85); cam.fovPunch(6); cam.kick(2.5);
    }
  }

  _doNova(slot, def) {
    this._ab.trigger(slot);
    const origin = this._eye(), dir = this._look();
    const center = this._aimGround(origin, dir, def.range);
    this.game.net.send(MSG.C_ATTACK, { slot, origin: arr(origin), dir: arr(dir), charge: 0 });
    if (this._vm) this._vm.playAttack(slot);
    this.game.vfx.novaTelegraph(center, def.radius, def.windup || 0.8);
    this.game.audio.play('nova_cast');
    this._beginCast(def.windup || 0.8, () => {
      this.game.net.send(MSG.C_AOE, { slot, center: arr(center) });
      this.game.vfx.explosion(center, def.radius, 'arcane');
      this.game.vfx.shockwave(center, def.radius, 0x6fd3e8);
      this.game.audio.play('nova_blast');
      this.game.shake.add(0.8); this._camCtl.fovPunch(5); this._camCtl.kick(2);
    });
  }

  // Zielpunkt am Boden aus Blickstrahl (Raycast, sonst Reichweiten-Ende)
  _aimGround(origin, dir, range) {
    const rc = this.game.colliders.raycast(origin, dir, range);
    const c = (rc && rc.hit) ? rc.point.clone() : origin.clone().addScaledVector(dir, range);
    c.y = Math.max(0, this.game.colliders.groundHeight(c.x, c.z, c.y + 2));
    return c;
  }

  // --- Verzögerte Casts -----------------------------------------------------
  _beginCast(delay, run) { this._cast = { t: Math.max(0, delay), run }; }

  _tickScheduled(dt) {
    if (this._cast) {
      this._cast.t -= dt;
      if (this._cast.t <= 0) { const run = this._cast.run; this._cast = null; run(); }
    }
    for (let i = this._remoteFx.length - 1; i >= 0; i--) {
      this._remoteFx[i].t -= dt;
      if (this._remoteFx[i].t <= 0) { const run = this._remoteFx[i].run; this._remoteFx.splice(i, 1); run(); }
    }
  }

  _scheduleRemoteBlast(delay, run) {
    if (delay > 0) this._remoteFx.push({ t: delay, run });
    else run();
  }

  // =========================================================================
  // Eingehende Server-Nachrichten
  // =========================================================================
  handleAttack(msg) {
    const game = this.game, remote = game.remote;
    if (!msg || msg.id == null) return;
    const info = game.roster.get(msg.id);
    const classId = (info && info.classId) || (remote ? remote.classId : 'knight');
    const def = (getClass(classId) || {}).abilities ? getClass(classId).abilities[msg.slot] : null;
    if (remote && msg.id === remote.id) remote.playAttack(msg.slot);
    if (!def) return;

    const origin = vec(msg.origin), dir = vec(msg.dir);
    const rpos = remote ? remote.position.clone() : origin.clone();

    switch (def.kind) {
      case 'projectile':
        game.projectiles.spawnRemote({ slot: msg.slot, def, origin, dir, charge: 0, color: 0x66ccff });
        game.vfx.muzzleFlash(origin, 0x66ccff);
        game.audio.play('cast_arcane', { pos: origin });
        break;
      case 'charged_projectile':
        game.projectiles.spawnRemote({ slot: msg.slot, def, origin, dir, charge: msg.charge || 0, color: 0xff7733 });
        game.vfx.muzzleFlash(origin, 0xff7733);
        game.audio.play('fireball_launch', { pos: origin });
        break;
      case 'melee':
        game.audio.play(msg.slot === 'secondary' ? 'heavy_swing' : (classId === 'dragon' ? 'claw' : 'sword_swing'), { pos: rpos });
        break;
      case 'blink':
        game.vfx.blinkFlash(origin, rpos, 0x9b5cff);
        game.audio.play('blink', { pos: origin });
        break;
      case 'dash':
        game.audio.play('dash', { pos: rpos });
        break;
      case 'leap':
        game.audio.play('tail_whoosh', { pos: rpos });
        break;
      case 'shield':
        break; // Blase via S_SHIELD
      case 'aoe_self': {
        const center = rpos.clone();
        const windup = def.windup || 0;
        if (windup > 0) {
          game.vfx.novaTelegraph(center, def.radius, windup);
          game.audio.play(classId === 'dragon' ? 'roar' : 'nova_cast', { pos: center });
        }
        this._scheduleRemoteBlast(windup, () => this._remoteAoeBlast(classId, msg.slot, def, remote ? remote.position.clone() : center));
        break;
      }
      case 'aoe_target': {
        const center = this._aimGround(origin, dir, def.range);
        game.vfx.novaTelegraph(center, def.radius, def.windup || 0.8);
        game.audio.play('nova_cast', { pos: center });
        this._scheduleRemoteBlast(def.windup || 0.8, () => {
          game.vfx.explosion(center, def.radius, 'arcane');
          game.vfx.shockwave(center, def.radius, 0x6fd3e8);
          game.audio.play('nova_blast', { pos: center });
          this._proximityShake(center, def.radius);
        });
        break;
      }
      default: break;
    }
  }

  _remoteAoeBlast(cls, slot, def, center) {
    const vfx = this.game.vfx, audio = this.game.audio;
    if (cls === 'dragon' && slot === 'ultimate') {
      vfx.explosion(center, def.radius, 'fire'); vfx.groundSlam(center, def.radius);
      audio.play('explosion_big', { pos: center }); audio.play('roar', { pos: center });
    } else if (cls === 'dragon') {
      vfx.shockwave(center, def.radius, 0xff7a22); audio.play('tail_whoosh', { pos: center });
    } else {
      vfx.groundSlam(center, def.radius); vfx.shockwave(center, def.radius, 0xff9a3d);
      audio.play('slam', { pos: center });
    }
    this._proximityShake(center, def.radius);
  }

  // Kleiner Shake, wenn eine Gegner-Explosion nah am eigenen Spieler ist
  _proximityShake(center, radius) {
    const ctrl = this._ctrl;
    if (!ctrl) return;
    const d = ctrl.position.distanceTo(center);
    if (d < radius + 3) this.game.shake.add(0.4 * (1 - d / (radius + 3)));
  }

  handleDamage(msg) {
    const game = this.game;
    game.health.applyDamage(msg);
    const point = vec(msg.point);
    const myId = game.myId, remote = game.remote, local = this._local;

    if (remote && msg.targetId === remote.id) {
      remote.setHealth(game.health.theirFrac);
      remote.onDamaged(point);
    }

    // Treffer-VFX am Punkt
    if (msg.blocked) {
      game.vfx.hitSparks(point, UP, 0xcfe0ff);
    } else {
      game.vfx.hitSparks(point, UP, 0xffd080);
      game.vfx.bloodPuff(point);
    }

    // Ich bin Ziel
    if (msg.targetId === myId && local) {
      const amt = msg.amount || 0;
      if (msg.blocked) {
        game.audio.play('block_impact');
        game.shake.add(0.15 + Math.min(0.3, amt / 120));
        game.postfx.damagePulse(Math.min(0.5, amt / 80 + 0.1));
      } else {
        game.audio.play('hurt');
        game.shake.add(0.2 + Math.min(0.6, amt / 60));
        game.postfx.damagePulse(Math.min(1, amt / 40 + 0.2));
      }
      // Richtungsanzeige relativ zur Blickrichtung
      const kb = vec(msg.knockback);
      let src = null;
      if (remote && msg.attackerId === remote.id) src = remote.position.clone().sub(local.controller.position);
      else if (kb.lengthSq() > 1e-4) src = kb.clone();
      if (src) {
        src.y = 0;
        const fAng = Math.atan2(-Math.sin(local.controller.yaw), -Math.cos(local.controller.yaw));
        let rel = Math.atan2(src.x, src.z) - fAng;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        game.ui.damageDirection(rel);
      }
      // Knockback clientseitig anwenden (Spielgefühl; HP bleibt serverautoritativ)
      if (kb.lengthSq() > 1e-4) local.controller.addImpulse(kb);
    }

    // Ich bin Angreifer
    if (msg.attackerId === myId && local) {
      game.ui.hitmarker();
      game.audio.play('hitmarker');
      this._ndc.copy(point).project(game.camera);
      if (this._ndc.z < 1) {
        game.ui.showDamageNumber(msg.amount, this._ndc.x * 0.5 + 0.5, (1 - this._ndc.y) * 0.5);
      }
    }
  }

  handleShield(msg) {
    const game = this.game;
    if (!msg || msg.id == null) return;
    game.health.setShield(msg.id, msg.amount);
    const remote = game.remote;
    if (msg.id === game.myId && this._local) {
      if (this._myShield) this._myShield.dispose();
      this._myShield = game.vfx.shieldBubble(this._anchor, 1.4, 0x6fd3e8, msg.duration || 4);
      game.audio.play('shield_up');
    } else if (remote && msg.id === remote.id) {
      if (this._remoteShield) this._remoteShield.dispose();
      this._remoteShield = game.vfx.shieldBubble(remote.group, (remote.def.radius || 0.5) * 2.6, 0x6fd3e8, msg.duration || 4);
      game.audio.play('shield_up', { pos: remote.position });
    }
  }

  handleDeath(msg) {
    const game = this.game, remote = game.remote, local = this._local;
    const atRemote = remote && msg.targetId === remote.id;
    game.audio.play('death', { pos: atRemote ? remote.position : null });
    if (msg.targetId === game.myId && local) {
      this.combatEnabled = false;
      this.cancelChannels();
      local.cameraCtl.setDeathCam(true);
      local.controller.inputLocked = true;
      game.postfx.deathFade(true);
    } else if (atRemote) {
      remote.setHealth(0);
    }
  }

  // Remote-Zustand (aus S_STATE) für Atem-Kegel des Gegners spiegeln
  onRemoteState(msg) {
    this._remoteAnim = msg ? msg.anim || null : null;
  }

  _updateRemoteFx() {
    const game = this.game, remote = game.remote, anim = this._remoteAnim;
    const wantBreath = !!(remote && anim && anim.breath && remote.classId === 'dragon');
    if (wantBreath && !this._remoteBreath) {
      this._ensureRemoteMuzzle(remote);
      this._remoteBreath = game.vfx.breathCone(this._remoteMuzzle, 0xff7a22);
      this._remoteBreath.set(true);
      this._remoteBreathLoop = game.audio.loop('breath_loop', { pos: remote.position, vol: 0.6 });
    } else if (!wantBreath && this._remoteBreath) {
      this._stopRemoteBreath();
    }
    if (this._remoteBreathLoop && remote) this._remoteBreathLoop.setPos(remote.position);
  }

  _stopRemoteBreath() {
    if (this._remoteBreath) { this._remoteBreath.dispose(); this._remoteBreath = null; }
    if (this._remoteBreathLoop) { this._remoteBreathLoop.stop(); this._remoteBreathLoop = null; }
  }

  _ensureLocalMuzzle() {
    if (this._localMuzzle && this._localMuzzle.parent === this.game.camera) return;
    this._localMuzzle = new THREE.Object3D();
    this._localMuzzle.rotation.y = Math.PI;     // +Z des Objekts zeigt nach vorn (Kamera blickt -Z)
    this._localMuzzle.position.set(0, -0.1, -0.5);
    this.game.camera.add(this._localMuzzle);
  }

  _ensureRemoteMuzzle(remote) {
    if (this._remoteMuzzle && this._remoteMuzzle.parent === remote.group) return;
    if (this._remoteMuzzle && this._remoteMuzzle.parent) this._remoteMuzzle.parent.remove(this._remoteMuzzle);
    this._remoteMuzzle = new THREE.Object3D();
    this._remoteMuzzle.rotation.y = Math.PI;     // mit der ry-gedrehten Gruppe → Weltrichtung = vorn
    this._remoteMuzzle.position.set(0, (remote.def.height || 1.9) * 0.72, 0);
    remote.group.add(this._remoteMuzzle);
  }

  _color(slot) {
    const def = this._local && this._local.def ? this._local.def : null;
    return def ? def.colorEmissive || def.color || 0x66ccff : 0x66ccff;
  }

  // Alle Kanäle/Windups/Handles sauber beenden (Phasenwechsel/Tod/Reset)
  cancelChannels() {
    this._cast = null;
    this._remoteFx.length = 0;
    this._stopBreath();
    this._cancelCharge();
    this._stopRemoteBreath();
    this._dashSlot = null; this._dashHit = false;
    this._breathTimer = 0;
    this._remoteAnim = null;
    if (this._remoteMuzzle && this._remoteMuzzle.parent) {
      this._remoteMuzzle.parent.remove(this._remoteMuzzle);
      this._remoteMuzzle = null;
    }
    if (this._myShield) { this._myShield.dispose(); this._myShield = null; }
    if (this._remoteShield) { this._remoteShield.dispose(); this._remoteShield = null; }
    this._blocking = false;
    if (this._ctrl) this._ctrl.blocking = false;
    if (this._vm) this._vm.setBlocking(false);
  }

  // Netz-Anteil des C_STATE (von main.js mit Bewegungsflags zusammengeführt)
  netAnim() {
    return {
      blocking: this._blocking,
      breath: this._breathing,
      charging: this._ab ? this._ab.charge01 : 0,
    };
  }
}
