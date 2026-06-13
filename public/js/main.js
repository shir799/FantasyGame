/**
 * main.js — Bootstrap, Game-Kontext, Render-Loop und Phasen-Orchestrierung.
 * Erzeugt Renderer/Szene/Kamera, instanziiert alle Subsysteme, verdrahtet die
 * UI-Callbacks und Netz-Handler (S_*), baut bei jedem Reset lokalen Spieler und
 * Gegner/Dummy auf und treibt pro Frame Controller, Kamera, Kampf, VFX, Audio
 * und HUD an. Server ist Autorität; Bewegung ist clientseitig.
 */
import * as THREE from 'three';
import { MSG, PHASE } from '/shared/protocol.js';
import { getClass } from '/shared/classes.js';

import { Input } from './core/Input.js';
import { NetworkClient } from './net/NetworkClient.js';
import { PlayerController } from './player/PlayerController.js';
import { CameraController } from './player/CameraController.js';
import { RemotePlayer } from './player/RemotePlayer.js';
import { AbilitySystem } from './combat/AbilitySystem.js';
import { HealthSystem } from './combat/HealthSystem.js';
import { ProjectileManager } from './combat/Projectiles.js';
import { CombatSystem } from './combat/CombatSystem.js';
import { Colliders } from './world/Colliders.js';
import { buildArena } from './world/ArenaManager.js';
import { buildRig } from './characters/CharacterRig.js';
import { VFXManager } from './fx/VFXManager.js';
import { ScreenShake } from './fx/ScreenShake.js';
import { PostFX } from './fx/PostFX.js';
import { AudioFeedback } from './audio/AudioFeedback.js';
import { UIManager } from './ui/UIManager.js';

const ORIGIN = new THREE.Vector3(0, 0.7, 0);

// ---------------------------------------------------------------------------
// Renderer / Szene / Kamera
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 600);
scene.add(camera);

// ---------------------------------------------------------------------------
// Zentraler Game-Kontext (von allen Subsystemen geteilt)
// ---------------------------------------------------------------------------
const game = {
  renderer, scene, camera,
  time: { dt: 0, now: 0 },
  net: null, input: null, ui: null, audio: null, vfx: null, postfx: null, shake: null,
  colliders: null, arena: null, projectiles: null, health: null, combat: null,
  local: null, remote: null,
  phase: PHASE.LOBBY, myId: null, myClassId: null, myName: 'Namenlos',
  roster: new Map(),
  round: 0, lastScores: {},
  fightEndsAt: null, countdownEndsAt: null, _lastCount: null, _orbit: 0,
  settings: { sensitivity: 1, quality: 'medium', volume: 0.8 },
};

// ---------------------------------------------------------------------------
// Subsysteme instanziieren
// ---------------------------------------------------------------------------
game.ui = new UIManager();
const s0 = game.ui.getSettings();
game.settings = { sensitivity: s0.sensitivity, quality: s0.quality, volume: s0.volume };

game.audio = new AudioFeedback();
game.audio.setVolume(game.settings.volume);
game.shake = new ScreenShake();
game.colliders = new Colliders();
game.vfx = new VFXManager(scene);
game.postfx = new PostFX(renderer, scene, camera);
game.postfx.setQuality(game.settings.quality);
game.projectiles = new ProjectileManager(game);
game.health = new HealthSystem(game);
game.input = new Input(canvas);
game.input.setPointerLockTarget(canvas);
game.net = new NetworkClient();
game.combat = new CombatSystem(game);
game.arena = buildArena(game, 'ruinenburg');

game.ui.showScreen('menu');

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
const _tmpFwd = new THREE.Vector3();

function isInMatch() {
  return game.phase === PHASE.COUNTDOWN || game.phase === PHASE.FIGHTING || game.phase === PHASE.ROUND_END;
}

function isSolo() {
  return !!(game.remote && game.remote.id === 'dummy');
}

function setMovementLocked(locked) {
  if (game.local) game.local.controller.inputLocked = locked;
}

function tryLock() {
  if (game.input && !game.input.locked) game.input.requestLock();
}

function applyScores() {
  if (game.myId == null) return;
  const s = game.lastScores || {};
  const mine = s[game.myId] || 0;
  let theirs = 0;
  for (const id in s) { if (id !== game.myId) theirs = s[id]; }
  game.ui.setScores(mine, theirs, game.round);
}

function disposeRemote() {
  if (game.remote) { game.remote.dispose(); game.remote = null; }
}

function buildLocal(classId) {
  // Altes Viewmodel entfernen
  if (game.local && game.local.viewmodel && game.local.viewmodel.group.parent) {
    game.local.viewmodel.group.parent.remove(game.local.viewmodel.group);
  }
  const def = getClass(classId) || getClass('knight');
  const controller = new PlayerController(game, def);
  const cameraCtl = new CameraController(game, controller);
  const abilities = new AbilitySystem(def);
  const viewmodel = buildRig(classId, { firstPerson: true });
  camera.add(viewmodel.group);
  game.local = { classId, def, controller, cameraCtl, abilities, viewmodel };
}

function ensureLocal(classId) {
  if (!game.local || game.local.classId !== classId) buildLocal(classId);
}

function teardownMatchVisualState() {
  game.postfx.deathFade(false);
  if (game.local) {
    game.local.cameraCtl.setDeathCam(false);
    game.local.controller.inputLocked = true;
    game.local.cameraCtl.active = false;
  }
  game.combat.combatEnabled = false;
  game.combat.cancelChannels();
  game.ui.setTimer(null);
  game.fightEndsAt = null;
}

// ---------------------------------------------------------------------------
// Netz-Handler
// ---------------------------------------------------------------------------
game.net.on(MSG.S_WELCOME, (msg) => {
  game.myId = msg.id;
  game.ui.setJoinInfo(msg.lanIp, msg.port);
});

game.net.on(MSG.S_ROSTER, (msg) => {
  const players = Array.isArray(msg.players) ? msg.players : [];
  game.roster.clear();
  for (const p of players) game.roster.set(p.id, { id: p.id, name: p.name, classId: p.classId, ready: p.ready });
  game.ui.setRoster(players, game.myId);
  const enemy = players.find((p) => p.id !== game.myId);
  if (enemy && enemy.classId) game.ui.setEnemyInfo(enemy.name, enemy.classId);
  const me = players.find((p) => p.id === game.myId);
  if (me && me.classId) game.myClassId = me.classId;
});

game.net.on(MSG.S_PHASE, (msg) => onPhase(msg));
game.net.on(MSG.S_RESET, (msg) => onReset(msg));

game.net.on(MSG.S_STATE, (msg) => {
  if (game.remote && game.remote.id === msg.id) {
    game.remote.pushState(msg);
    game.combat.onRemoteState(msg);
  }
});

game.net.on(MSG.S_ATTACK, (msg) => game.combat.handleAttack(msg));
game.net.on(MSG.S_DAMAGE, (msg) => game.combat.handleDamage(msg));
game.net.on(MSG.S_SHIELD, (msg) => game.combat.handleShield(msg));
game.net.on(MSG.S_DEATH, (msg) => game.combat.handleDeath(msg));

game.net.on(MSG.S_ROUND_END, (msg) => {
  game.lastScores = msg.scores || game.lastScores;
  applyScores();
  if (!msg.winnerId) {
    game.ui.announce('UNENTSCHIEDEN', { ms: 2400, big: true });
  } else if (msg.winnerId === game.myId) {
    game.ui.announce('RUNDE GEWONNEN', { ms: 2400, big: true });
    game.audio.play('round_win');
  } else {
    game.ui.announce('RUNDE VERLOREN', { ms: 2400, big: true });
    game.audio.play('round_lose');
  }
});

game.net.on(MSG.S_MATCH_END, (msg) => {
  const sc = msg.scores || {};
  const mine = sc[game.myId] || 0;
  let theirs = 0;
  for (const id in sc) { if (id !== game.myId) theirs = sc[id]; }
  const victory = msg.winnerId === game.myId;
  game.audio.play(victory ? 'match_win' : 'match_lose');
  game.ui.showResult({ victory, scoreMine: mine, scoreTheirs: theirs, soloAllowed: false });
  game.input.exitLock();
});

game.net.on(MSG.S_EVENT, (msg) => {
  if (msg.kind === 'dummy_respawn') {
    game.ui.announce('Der Golem erhebt sich erneut', { ms: 1300 });
    const hp = msg.hp || 200;
    setTimeout(() => {
      if (game.remote && game.remote.id === 'dummy') {
        game.health.applyDamage({ targetId: 'dummy', hp, shield: 0 });
        game.remote.setHealth(1);
      }
    }, msg.inMs || 2000);
  } else if (msg.kind === 'announce' && msg.text) {
    game.ui.announce(msg.text, { ms: 1600 });
  }
});

game.net.on(MSG.S_LEFT, () => {
  game.ui.toast('Der Herausforderer hat die Arena verlassen.');
  disposeRemote();
  teardownMatchVisualState();
});

game.net.on(MSG.S_FULL, () => {
  game.ui.showScreen('disconnected');
  game.ui.toast('Die Arena ist bereits voll (max. 2 Kämpfer).', 4000);
});

game.net.on(MSG.S_ERROR, (msg) => game.ui.toast(msg.msg || 'Serverfehler', 3000));

game.net.onClose(() => {
  if (game.ui.currentScreen !== 'menu') game.ui.showScreen('disconnected');
});

// Eigenen Zustand mit STATE_HZ senden (nur während Countdown/Kampf)
game.net.startStateLoop(() => {
  if (!game.local) return null;
  if (game.phase !== PHASE.FIGHTING && game.phase !== PHASE.COUNTDOWN) return null;
  const c = game.local.controller, cam = game.local.cameraCtl, input = game.input;
  const moving = c.speed01 > 0.05;
  const sprinting = !!input.isDown('sprint') && moving;
  return {
    p: [c.position.x, c.position.y, c.position.z],
    ry: c.yaw,
    pitch: cam.pitch,
    anim: Object.assign({ moving, sprinting, grounded: c.grounded }, game.combat.netAnim()),
  };
});

// ---------------------------------------------------------------------------
// Phasen-Logik
// ---------------------------------------------------------------------------
function onPhase(msg) {
  const prev = game.phase;
  game.phase = msg.phase;
  game.round = msg.round || 0;
  game.lastScores = msg.scores || {};
  applyScores();

  switch (msg.phase) {
    case PHASE.LOBBY:
      game.ui.setSoloAvailable(true);
      game.ui.showScreen('lobby');
      teardownMatchVisualState();
      break;
    case PHASE.CLASS_SELECT:
      game.ui.showScreen('class');
      teardownMatchVisualState();
      break;
    case PHASE.COUNTDOWN:
      game.ui.showScreen('hud');
      game.countdownEndsAt = msg.endsAt;
      game._lastCount = null;
      setMovementLocked(true);
      game.combat.combatEnabled = false;
      if (game.local) game.local.cameraCtl.active = true;
      tryLock();
      break;
    case PHASE.FIGHTING:
      game.ui.showScreen('hud');
      setMovementLocked(false);
      game.combat.combatEnabled = true;
      if (game.local) game.local.controller.inputLocked = false;
      game.fightEndsAt = isSolo() ? null : msg.endsAt;
      if (prev !== PHASE.FIGHTING) {
        game.ui.announce('KAMPF!', { ms: 1100, big: true });
        game.audio.play('round_start');
      }
      tryLock();
      break;
    case PHASE.ROUND_END:
      setMovementLocked(true);
      game.combat.combatEnabled = false;
      game.combat.cancelChannels();
      game.ui.setTimer(null);
      game.fightEndsAt = null;
      break;
    case PHASE.MATCH_END:
      setMovementLocked(true);
      game.combat.combatEnabled = false;
      game.combat.cancelChannels();
      game.ui.setTimer(null);
      game.input.exitLock();
      break;
    default:
      break;
  }
}

function onReset(msg) {
  const myId = game.myId;
  const myClass = (game.roster.get(myId) || {}).classId || game.myClassId || 'mage';
  ensureLocal(myClass);

  // Lokalen Spieler an Spawn setzen
  const sp = msg.spawns ? msg.spawns[myId] : null;
  if (sp) {
    game.local.controller.teleport(sp.p, sp.ry);
  }
  game.local.cameraCtl.pitch = 0;
  game.local.cameraCtl.active = true;
  game.local.cameraCtl.setDeathCam(false);
  game.local.controller.inputLocked = true;
  game.postfx.deathFade(false);
  game.local.abilities.resetForRound();

  // Gegner bzw. Dummy aufbauen
  setupRemoteFromReset(msg);

  // Gesundheit, Projektile, transiente VFX, Kanäle zurücksetzen
  game.health.resetFromRoster();
  if (game.remote) game.remote.setHealth(1);
  game.projectiles.clear();
  game.vfx.clearTransient();
  game.combat.cancelChannels();
  applyScores();
}

function setupRemoteFromReset(msg) {
  let oppId = null, oppClass = null, oppName = 'Gegner';
  for (const [id, info] of game.roster) {
    if (id !== game.myId) { oppId = id; oppClass = info.classId; oppName = info.name; }
  }

  if (msg.dummy) {
    // Solo-Training: Gegner ist der Dummy
    if (!game.remote || game.remote.id !== 'dummy') {
      disposeRemote();
      game.remote = new RemotePlayer(game, { id: 'dummy', name: 'Trainingsgolem', classId: 'dummy' });
    }
    game.remote.pushState({ p: msg.dummy.p, ry: 0 });
    game.ui.setEnemyInfo('Trainingsgolem', 'dummy');
  } else if (oppId && oppClass) {
    if (!game.remote || game.remote.id !== oppId || game.remote.classId !== oppClass) {
      disposeRemote();
      game.remote = new RemotePlayer(game, { id: oppId, name: oppName, classId: oppClass });
    }
    const osp = msg.spawns ? msg.spawns[oppId] : null;
    if (osp) game.remote.pushState({ p: osp.p, ry: osp.ry, pitch: 0, anim: null });
    game.ui.setEnemyInfo(oppName, oppClass);
  } else {
    disposeRemote();
  }
}

// ---------------------------------------------------------------------------
// UI-Callbacks
// ---------------------------------------------------------------------------
game.ui.callbacks.onEnter = (name) => {
  game.myName = name;
  game.audio.unlock();
  game.audio.startAmbience();
  game.net.connect().then(() => {
    game.net.send(MSG.C_HELLO, { name });
  }).catch(() => {
    game.ui.showScreen('disconnected');
  });
};

game.ui.callbacks.onSelectClass = (classId) => {
  game.myClassId = classId;
  game.audio.unlock();
  game.audio.play('ui_click');
  game.net.send(MSG.C_SELECT, { classId });
};

game.ui.callbacks.onReady = (ready) => {
  game.audio.play('ui_click');
  game.net.send(MSG.C_READY, { ready });
};

game.ui.callbacks.onSolo = () => {
  game.audio.unlock();
  game.audio.play('ui_click');
  game.net.send(MSG.C_SOLO, {});
};

game.ui.callbacks.onLeaveSolo = () => {
  game.audio.play('ui_click');
  game.input.exitLock();
  game.net.send(MSG.C_LEAVE_SOLO, {});
};

game.ui.callbacks.onRematch = () => {
  game.audio.play('ui_click');
  game.net.send(MSG.C_REMATCH, {});
};

game.ui.callbacks.onResume = () => {
  game.ui.showScreen('hud');
  tryLock();
};

game.ui.callbacks.onLeave = () => {
  // „Verlassen" im PvP-Pause-Menü: sauberer Neustart
  window.location.reload();
};

game.ui.callbacks.onSettings = (s) => {
  game.settings.sensitivity = s.sensitivity;
  game.settings.quality = s.quality;
  game.settings.volume = s.volume;
  game.postfx.setQuality(s.quality);
  game.audio.setVolume(s.volume);
};

// ---------------------------------------------------------------------------
// Pointer-Lock-Fluss
// ---------------------------------------------------------------------------
game.input.onLockChange((locked) => {
  if (locked) {
    if (game.ui.currentScreen === 'pause') game.ui.showScreen('hud');
  } else if (game.phase === PHASE.FIGHTING && game.ui.currentScreen === 'hud') {
    // Lock verloren (ESC) mitten im Kampf → Pause anbieten
    game.ui.showScreen('pause');
  }
});

// Klick ins Bild fängt den Lock wieder ein (z. B. nach ESC oder Auto-Lock-Block)
canvas.addEventListener('click', () => {
  game.audio.unlock();
  if (isInMatch() && !game.input.locked && game.ui.currentScreen !== 'pause') game.input.requestLock();
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  game.postfx.resize(w, h);
});

// ---------------------------------------------------------------------------
// Menü-Orbit-Kamera (wenn kein Kampf läuft)
// ---------------------------------------------------------------------------
function updateMenuCam(dt) {
  game._orbit += dt * 0.07;
  const c = game.arena ? game.arena.center : ORIGIN;
  const r = 25;
  camera.position.set(c.x + Math.cos(game._orbit) * r, 13, c.z + Math.sin(game._orbit) * r);
  camera.lookAt(c.x, 2.2, c.z);
}

function updateListener(inMatch) {
  if (game.local && inMatch) _tmpFwd.copy(game.local.cameraCtl.lookDir);
  else _tmpFwd.copy(game.arena ? game.arena.center : ORIGIN).sub(camera.position).normalize();
  game.audio.setListener(camera.position, _tmpFwd);
}

// ---------------------------------------------------------------------------
// Countdown-Ansagen
// ---------------------------------------------------------------------------
function handleCountdownTick() {
  if (game.phase !== PHASE.COUNTDOWN || !game.countdownEndsAt) return;
  const rem = Math.ceil((game.countdownEndsAt - game.net.serverNow()) / 1000);
  if (rem !== game._lastCount) {
    game._lastCount = rem;
    if (rem >= 1 && rem <= 3) {
      game.ui.countdown(rem);
      game.audio.play('countdown_tick');
    }
  }
}

// ---------------------------------------------------------------------------
// Haupt-Loop
// ---------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.05) dt = 0.05;
  if (dt < 0) dt = 0;
  game.time.dt = dt;
  game.time.now = now / 1000;

  game.input.update();
  handleCountdownTick();

  const inMatch = isInMatch();
  if (game.local && inMatch) {
    game.local.cameraCtl.active = true;
    game.local.controller.update(dt);
    game.local.cameraCtl.update(dt);
    game.combat.update(dt);
    game.local.abilities.update(dt);
    game.local.viewmodel.update(dt);
  } else {
    if (game.local) game.local.cameraCtl.active = false;
    updateMenuCam(dt);
  }

  if (game.remote) game.remote.update(dt);
  game.projectiles.update(dt);
  game.vfx.update(dt);
  if (game.arena) game.arena.update(dt);
  game.shake.update(dt);

  updateListener(inMatch);
  game.ui.tickHud(game);

  // Kampf-Timer (nicht im Solo)
  if (game.phase === PHASE.FIGHTING && game.fightEndsAt != null) {
    game.ui.setTimer(Math.max(0, (game.fightEndsAt - game.net.serverNow()) / 1000));
  } else if (game.phase === PHASE.FIGHTING) {
    game.ui.setTimer(null);
  }

  game.postfx.render(dt);
}
requestAnimationFrame(frame);

// Debug-Zugriff in der Konsole
window.__ASCHENTHRON__ = game;
