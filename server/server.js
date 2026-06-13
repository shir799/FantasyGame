/**
 * server.js — Statik-Server + WebSocket-Matchautorität für ASCHENTHRON.
 * Liefert Client-, Shared- und three-Dateien aus und führt als Autorität die
 * Phasenmaschine, Schadens-/Block-/Schild-Logik, Best-of-3, Solo-Training,
 * Timeout-/Fallschutz-Regeln und das Disconnect-Handling.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PORT, PHASE, MSG } from '../shared/protocol.js';
import { CLASS_IDS, MATCH, SLOT, getClass } from '../shared/classes.js';

// ---------------------------------------------------------------------------
// Statik-Server
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const THREE_BUILD = path.join(ROOT, 'node_modules', 'three', 'build');
const THREE_ADDONS = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glsl': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/** Bildet einen URL-Pfad auf eine Datei ab; null bei ungültigem/ausbrechendem Pfad. */
function resolveStatic(rawUrl) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((rawUrl || '/').split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (urlPath.includes('\0')) return null;
  if (urlPath === '/') urlPath = '/index.html';

  let base;
  let rest;
  if (urlPath.startsWith('/vendor/three/addons/')) {
    base = THREE_ADDONS;
    rest = urlPath.slice('/vendor/three/addons/'.length);
  } else if (urlPath.startsWith('/vendor/three/')) {
    base = THREE_BUILD;
    rest = urlPath.slice('/vendor/three/'.length);
  } else if (urlPath.startsWith('/shared/')) {
    base = SHARED_DIR;
    rest = urlPath.slice('/shared/'.length);
  } else {
    base = PUBLIC_DIR;
    rest = urlPath.slice(1);
  }
  const abs = path.resolve(base, rest);
  // Pfad-Traversal-Schutz: aufgelöster Pfad muss im Basisordner bleiben.
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }
  const filePath = resolveStatic(req.url);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

// ---------------------------------------------------------------------------
// Match-Zustand
// ---------------------------------------------------------------------------

// Spawn-Podeste gegenüber, Blick zur Mitte (forward = (-sin ry, 0, -cos ry)).
const SPAWNS = [
  { p: [-16, 0.6, 0], ry: -Math.PI / 2 },
  { p: [16, 0.6, 0], ry: Math.PI / 2 },
];
const DUMMY_POS = [0, 0.8, 0];
const DUMMY_CAPSULE = { radius: 0.5, height: 2.0 };
const SOLO_PHASE_MS = 3600 * 1000;       // Solo: „Timer“ eine Stunde in der Zukunft
const BREATH_MIN_INTERVAL_MS = 200;      // Rate-Limit Feueratem-Ticks
const FALL_GRACE_MS = 1500;              // Karenz nach Spawn/Reset gegen Alt-Pakete

let playerSeq = 0;
const players = new Map();               // id → Spieler-Record
const state = {
  phase: PHASE.LOBBY,
  endsAt: 0,
  round: 0,
  scores: {},
  solo: false,
  dummy: null,                           // {id:'dummy', hp, maxHp, alive, p}
  dummyTimer: null,
};

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

function num(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, num(v, 0)));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Validiert ein [x,y,z]-Array mit endlichen Zahlen; sonst null. */
function arr3(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const x = Number(v[0]);
  const y = Number(v[1]);
  const z = Number(v[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ type, ...payload }));
  } catch {
    // Socket im Abbau — ignorieren.
  }
}

function broadcast(type, payload = {}) {
  for (const pl of players.values()) send(pl.ws, type, payload);
}

function broadcastRoster() {
  broadcast(MSG.S_ROSTER, {
    players: [...players.values()].map((p) => ({ id: p.id, name: p.name, classId: p.classId, ready: p.ready })),
  });
}

function setPhase(phase, endsAt = 0) {
  state.phase = phase;
  state.endsAt = endsAt;
  broadcast(MSG.S_PHASE, { phase, endsAt, round: state.round, scores: { ...state.scores }, now: Date.now() });
}

function opponentOf(player) {
  for (const pl of players.values()) {
    if (pl.id !== player.id) return pl;
  }
  return null;
}

function abilityOf(player, slot) {
  const cls = getClass(player.classId);
  return cls && cls.abilities[slot] ? cls.abilities[slot] : null;
}

/** Position eines Ziels (Spieler oder Dummy) als [x,y,z]. */
function posOf(target) {
  return target.id === 'dummy' ? target.p : target.lastState.p;
}

/** Kapsel eines Ziels für AoE-Distanztests. */
function capsuleOf(target) {
  if (target.id === 'dummy') return { p: target.p, radius: DUMMY_CAPSULE.radius, height: DUMMY_CAPSULE.height };
  const cls = getClass(target.classId);
  return { p: target.lastState.p, radius: cls ? cls.radius : 0.4, height: cls ? cls.height : 1.8 };
}

/** Abstand Punkt → Kapseloberfläche (0 bei Berührung/Durchdringung). */
function distToCapsule(point, foot, radius, height) {
  const y0 = foot[1] + radius;
  const y1 = foot[1] + Math.max(radius, height - radius);
  const cy = Math.min(Math.max(point[1], y0), y1);
  const d = Math.hypot(point[0] - foot[0], point[1] - cy, point[2] - foot[2]);
  return Math.max(0, d - radius);
}

/** Knockback-Vektor: flache Richtung Ziel−Quelle × kb + (0, kb·0.35, 0). */
function knockbackVec(source, targetPos, kb) {
  if (!(kb > 0)) return [0, 0, 0];
  const dx = targetPos[0] - source[0];
  const dz = targetPos[2] - source[2];
  const len = Math.hypot(dx, dz);
  const nx = len > 1e-4 ? dx / len : 0;
  const nz = len > 1e-4 ? dz / len : 0;
  return [nx * kb, kb * 0.35, nz * kb];
}

/** Clamp eines Punkts auf maxDist um origin (3D). */
function clampToRange(point, origin, maxDist) {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const dz = point[2] - origin[2];
  const len = Math.hypot(dx, dy, dz);
  if (len <= maxDist || len < 1e-4) return point;
  const s = maxDist / len;
  return [origin[0] + dx * s, origin[1] + dy * s, origin[2] + dz * s];
}

function sanitizeAnim(anim) {
  const a = anim && typeof anim === 'object' ? anim : {};
  return {
    moving: !!a.moving,
    sprinting: !!a.sprinting,
    grounded: !!a.grounded,
    blocking: !!a.blocking,
    breath: !!a.breath,
    charging: typeof a.charging === 'number' ? clamp01(a.charging) : !!a.charging,
  };
}

// ---------------------------------------------------------------------------
// Phasenmaschine
// ---------------------------------------------------------------------------

function startMatch() {
  state.round = 0;
  state.scores = {};
  for (const pl of players.values()) state.scores[pl.id] = 0;
  prepareRound();
}

/** Neue Runde: Spieler zurücksetzen, S_RESET senden, Countdown starten. */
function prepareRound() {
  state.round += 1;
  const now = Date.now();
  const list = [...players.values()];
  const swap = state.round % 2 === 0;      // Seitenwechsel pro Runde
  const spawns = {};
  const hp = {};
  list.forEach((pl, i) => {
    const cls = getClass(pl.classId);
    const spawn = SPAWNS[swap ? 1 - i : i] || SPAWNS[0];
    pl.maxHp = cls.maxHealth;
    pl.hp = cls.maxHealth;
    pl.shield = 0;
    pl.shieldUntil = 0;
    pl.alive = true;
    pl.cooldowns = { [SLOT.ULTIMATE]: now };   // Ultimate startet auf vollem Cooldown
    pl.pendingCasts = {};
    pl.lastBreathAt = 0;
    pl.fallGraceUntil = now + FALL_GRACE_MS;
    pl.lastState = { p: spawn.p.slice(), ry: spawn.ry, pitch: 0, anim: sanitizeAnim(null), at: now };
    spawns[pl.id] = { p: spawn.p.slice(), ry: spawn.ry };
    hp[pl.id] = pl.hp;
  });
  broadcast(MSG.S_RESET, { spawns, hp, dummy: null });
  setPhase(PHASE.COUNTDOWN, now + MATCH.COUNTDOWN_SECONDS * 1000);
}

function endRound(winnerId) {
  if (state.phase !== PHASE.FIGHTING || state.solo) return;
  if (winnerId && winnerId in state.scores) state.scores[winnerId] += 1;
  broadcast(MSG.S_ROUND_END, { winnerId: winnerId || null, scores: { ...state.scores }, round: state.round });
  setPhase(PHASE.ROUND_END, Date.now() + MATCH.ROUND_END_SECONDS * 1000);
}

/** Nach der round_end-Pause: Match-Ende prüfen oder nächste Runde starten. */
function afterRoundEnd() {
  const winner = Object.keys(state.scores).find((id) => state.scores[id] >= MATCH.ROUNDS_TO_WIN);
  if (winner) {
    broadcast(MSG.S_MATCH_END, { winnerId: winner, scores: { ...state.scores } });
    setPhase(PHASE.MATCH_END, 0);
  } else if (players.size === 2) {
    prepareRound();
  } else {
    setPhase(PHASE.LOBBY, 0);
  }
}

/** Rundentimeout: mehr HP-Prozent gewinnt, Gleichstand zählt nicht. */
function resolveTimeout() {
  const list = [...players.values()];
  if (list.length < 2) {
    setPhase(PHASE.LOBBY, 0);
    return;
  }
  const [a, b] = list;
  const fa = a.maxHp > 0 ? a.hp / a.maxHp : 0;
  const fb = b.maxHp > 0 ? b.hp / b.maxHp : 0;
  let winnerId = null;
  if (fa > fb) winnerId = a.id;
  else if (fb > fa) winnerId = b.id;
  endRound(winnerId);
}

// Phasen-Tick: prüft ablaufende Timer.
setInterval(() => {
  if (!state.endsAt) return;
  const now = Date.now();
  if (now < state.endsAt) return;
  switch (state.phase) {
    case PHASE.COUNTDOWN:
      setPhase(PHASE.FIGHTING, now + MATCH.ROUND_SECONDS * 1000);
      break;
    case PHASE.FIGHTING:
      if (state.solo) state.endsAt = now + SOLO_PHASE_MS;  // Solo läuft ohne Ende weiter
      else resolveTimeout();
      break;
    case PHASE.ROUND_END:
      afterRoundEnd();
      break;
    default:
      state.endsAt = 0;
  }
}, 200);

// ---------------------------------------------------------------------------
// Solo-Training
// ---------------------------------------------------------------------------

function startSolo(player) {
  if (players.size !== 1 || state.solo) return;
  if (state.phase !== PHASE.LOBBY && state.phase !== PHASE.CLASS_SELECT && state.phase !== PHASE.MATCH_END) return;
  if (!player.classId) player.classId = 'mage';   // Fallback ohne vorherige Wahl
  const cls = getClass(player.classId);
  const now = Date.now();
  state.solo = true;
  state.round = 1;
  state.scores = {};
  state.dummy = { id: 'dummy', hp: MATCH.DUMMY_HP, maxHp: MATCH.DUMMY_HP, alive: true, p: DUMMY_POS.slice() };
  player.maxHp = cls.maxHealth;
  player.hp = cls.maxHealth;
  player.shield = 0;
  player.shieldUntil = 0;
  player.alive = true;
  player.cooldowns = { [SLOT.ULTIMATE]: now };
  player.pendingCasts = {};
  player.lastBreathAt = 0;
  player.fallGraceUntil = now + FALL_GRACE_MS;
  player.lastState = { p: SPAWNS[0].p.slice(), ry: SPAWNS[0].ry, pitch: 0, anim: sanitizeAnim(null), at: now };
  broadcastRoster();
  broadcast(MSG.S_RESET, {
    spawns: { [player.id]: { p: SPAWNS[0].p.slice(), ry: SPAWNS[0].ry } },
    hp: { [player.id]: player.hp },
    dummy: { p: state.dummy.p.slice(), hp: state.dummy.hp },
  });
  setPhase(PHASE.FIGHTING, now + SOLO_PHASE_MS);
}

function endSolo() {
  if (!state.solo) return;
  state.solo = false;
  state.dummy = null;
  state.round = 0;
  if (state.dummyTimer) {
    clearTimeout(state.dummyTimer);
    state.dummyTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Kampf-Auflösung
// ---------------------------------------------------------------------------

/** Ziel auflösen: Gegner-Record oder (im Solo) der Dummy; nie der Angreifer. */
function resolveTarget(player, targetId) {
  if (targetId === 'dummy') return state.solo && state.dummy ? state.dummy : null;
  const t = players.get(targetId);
  return t && t.id !== player.id ? t : null;
}

/** Frontal-Check für Block: Quelle innerhalb ±frontArcDeg vor dem Ziel? */
function isFrontal(target, source, frontArcDeg) {
  const st = target.lastState;
  const dx = source[0] - st.p[0];
  const dz = source[2] - st.p[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return true;
  const fx = -Math.sin(st.ry || 0);
  const fz = -Math.cos(st.ry || 0);
  return (dx * fx + dz * fz) / len >= Math.cos((frontArcDeg * Math.PI) / 180);
}

/**
 * Schaden anwenden: Block → Schild → HP, dann S_DAMAGE an beide.
 * `amount` im Broadcast = wirksamer Gesamtschaden (Schild + HP) nach Block.
 */
function applyDamage({ attacker, target, slot, amount, point, knockback, source }) {
  const now = Date.now();
  let dealt = Math.max(0, num(amount, 0));
  let blocked = false;

  if (target.id !== 'dummy') {
    // Block-Check (nur Klassen mit block-Fähigkeit, praktisch der Ritter)
    const cls = getClass(target.classId);
    const blockDef = cls ? Object.values(cls.abilities).find((a) => a.kind === 'block') : null;
    if (blockDef && target.lastState.anim.blocking) {
      blocked = true;
      const front = isFrontal(target, source, blockDef.frontArcDeg || 60);
      dealt *= front ? blockDef.dmgMultFront : blockDef.dmgMultElse;
    }
    // Schild absorbiert vor den HP
    if (!(target.shield > 0 && now <= target.shieldUntil)) target.shield = 0;
    if (target.shield > 0) {
      const absorb = Math.min(target.shield, dealt);
      target.shield = Math.max(0, target.shield - absorb);
      dealt = Math.round(dealt);
      target.hp = Math.max(0, target.hp - Math.max(0, Math.round(dealt - absorb)));
    } else {
      dealt = Math.round(dealt);
      target.hp = Math.max(0, target.hp - dealt);
    }
  } else {
    dealt = Math.round(dealt);
    target.hp = Math.max(0, target.hp - dealt);
  }

  const targetPos = posOf(target);
  broadcast(MSG.S_DAMAGE, {
    targetId: target.id,
    attackerId: attacker.id,
    amount: dealt,
    hp: target.hp,
    shield: target.id === 'dummy' ? 0 : Math.round(target.shield),
    point: arr3(point) || [targetPos[0], targetPos[1] + 1.0, targetPos[2]],
    knockback: knockbackVec(source, targetPos, num(knockback, 0)),
    slot,
    blocked,
  });

  if (target.hp <= 0) onDeath(target, attacker);
}

function onDeath(target, attacker) {
  if (!target.alive) return;
  if (target.id === 'dummy') {
    target.alive = false;
    broadcast(MSG.S_EVENT, { kind: 'dummy_respawn', inMs: MATCH.DUMMY_RESPAWN_SECONDS * 1000, hp: target.maxHp });
    state.dummyTimer = setTimeout(() => {
      state.dummyTimer = null;
      if (state.solo && state.dummy === target) {
        target.hp = target.maxHp;
        target.alive = true;
      }
    }, MATCH.DUMMY_RESPAWN_SECONDS * 1000);
    return;
  }
  target.alive = false;
  broadcast(MSG.S_DEATH, { targetId: target.id, attackerId: attacker ? attacker.id : null });
  const winner = attacker && attacker.id !== target.id && players.has(attacker.id)
    ? attacker.id
    : (opponentOf(target) || {}).id || null;
  endRound(winner);
}

/** Sturz unter KILL_Y: PvP = Tod (Gegner gewinnt), Solo = Reset auf Spawn. */
function handleFall(player) {
  if (state.solo) {
    const cls = getClass(player.classId);
    player.hp = cls.maxHealth;
    player.shield = 0;
    player.alive = true;
    player.fallGraceUntil = Date.now() + FALL_GRACE_MS;
    player.lastState.p = SPAWNS[0].p.slice();
    send(player.ws, MSG.S_RESET, {
      spawns: { [player.id]: { p: SPAWNS[0].p.slice(), ry: SPAWNS[0].ry } },
      hp: { [player.id]: player.hp },
      dummy: state.dummy ? { p: state.dummy.p.slice(), hp: state.dummy.hp } : null,
    });
    return;
  }
  player.alive = false;
  const opp = opponentOf(player);
  broadcast(MSG.S_DEATH, { targetId: player.id, attackerId: opp ? opp.id : null });
  endRound(opp ? opp.id : null);
}

// ---------------------------------------------------------------------------
// Eingehende Nachrichten
// ---------------------------------------------------------------------------

function handleState(player, msg) {
  const p = arr3(msg.p);
  if (!p) return;
  player.lastState = {
    p,
    ry: num(msg.ry, 0),
    pitch: num(msg.pitch, 0),
    anim: sanitizeAnim(msg.anim),
    at: Date.now(),
  };
  // Fallschutz
  if (state.phase === PHASE.FIGHTING && player.alive && p[1] < MATCH.KILL_Y && Date.now() > player.fallGraceUntil) {
    handleFall(player);
    return;
  }
  const opp = opponentOf(player);
  if (opp) {
    send(opp.ws, MSG.S_STATE, {
      id: player.id, p, ry: player.lastState.ry, pitch: player.lastState.pitch, anim: player.lastState.anim,
    });
  }
}

/** Cast-Event: Cooldown buchen, Schild ggf. sofort anwenden, an Gegner relayen. */
function handleAttack(player, msg) {
  if (state.phase !== PHASE.FIGHTING || !player.alive) return;
  const def = abilityOf(player, msg.slot);
  if (!def) return;
  const now = Date.now();
  const cd = num(def.cooldown, 0);
  const last = player.cooldowns[msg.slot] || 0;
  if (cd > 0 && now - last < cd * 0.85 * 1000) return;   // Toleranz: erlaubt ab 0.85×cd
  player.cooldowns[msg.slot] = now;
  const charge = clamp01(msg.charge);
  player.pendingCasts[msg.slot] = { at: now, charge };

  if (def.kind === 'shield') {
    player.shield = def.shieldHp;
    player.shieldUntil = now + def.duration * 1000;
    broadcast(MSG.S_SHIELD, { id: player.id, amount: def.shieldHp, duration: def.duration });
  }

  const opp = opponentOf(player);
  if (opp) {
    send(opp.ws, MSG.S_ATTACK, {
      id: player.id,
      slot: msg.slot,
      origin: arr3(msg.origin) || player.lastState.p.slice(),
      dir: arr3(msg.dir) || [0, 0, -1],
      charge,
    });
  }
}

/** Treffer-Claim (Melee/Direktprojektil/Dash-Kontakt): max. einer pro Cast. */
function handleHit(player, msg) {
  if (state.phase !== PHASE.FIGHTING || !player.alive) return;
  const def = abilityOf(player, msg.slot);
  if (!def || !(def.damage > 0)) return;
  if (def.kind === 'breath' || def.kind === 'aoe_self' || def.kind === 'aoe_target' || def.kind === 'charged_projectile') return;
  const target = resolveTarget(player, msg.targetId);
  if (!target || !target.alive) return;
  if (!player.pendingCasts[msg.slot]) return;       // kein offener Cast → Claim verwerfen
  delete player.pendingCasts[msg.slot];
  const d = dist3(player.lastState.p, posOf(target));
  if (d > num(def.range, 0) * 1.4 + 2.5) return;    // grober Reichweiten-Check mit Slack
  applyDamage({
    attacker: player,
    target,
    slot: msg.slot,
    amount: def.damage,
    point: msg.point,
    knockback: def.knockback,
    source: player.lastState.p,
  });
}

/** Feueratem-Tick: Rate-Limit + Reichweite, kein pending-Cast nötig (Channel). */
function handleBreath(player, msg) {
  if (state.phase !== PHASE.FIGHTING || !player.alive) return;
  const def = abilityOf(player, SLOT.SECONDARY);
  if (!def || def.kind !== 'breath') return;
  const now = Date.now();
  if (now - player.lastBreathAt < BREATH_MIN_INTERVAL_MS) return;
  const target = resolveTarget(player, msg.targetId);
  if (!target || !target.alive) return;
  const d = dist3(player.lastState.p, posOf(target));
  if (d > def.range * 1.4 + 2.5) return;
  player.lastBreathAt = now;
  applyDamage({
    attacker: player,
    target,
    slot: SLOT.SECONDARY,
    amount: def.damage,
    point: msg.point,
    knockback: 0,
    source: player.lastState.p,
  });
}

/** Flächenschaden auflösen (aoe_self, aoe_target, Feuerball-Explosion). */
function handleAoe(player, msg) {
  if (state.phase !== PHASE.FIGHTING || !player.alive) return;
  const def = abilityOf(player, msg.slot);
  if (!def || !(def.radius > 0) || !(def.damage > 0)) return;
  const pending = player.pendingCasts[msg.slot];
  if (!pending) return;
  delete player.pendingCasts[msg.slot];

  const myPos = player.lastState.p;
  let center;
  let damage = def.damage;
  let radius = def.radius;

  if (def.kind === 'aoe_self') {
    // Server-bekannte Angreiferposition als Zentrum
    center = myPos.slice();
  } else if (def.kind === 'aoe_target') {
    // Gesendetes Zentrum auf range + 3 um den Angreifer clampen
    center = clampToRange(arr3(msg.center) || myPos.slice(), myPos, num(def.range, 0) + 3);
  } else if (def.kind === 'charged_projectile') {
    // Feuerball: Explosionsradius und Schaden skalieren mit charge
    center = arr3(msg.center);
    if (!center) return;
    if (dist3(myPos, center) > num(def.range, 60) * 1.4 + 2.5) return;
    const charge = clamp01(pending.charge);
    radius = lerp(num(def.radiusMin, def.radius), def.radius, charge);
    damage = lerp(num(def.minDamage, def.damage), def.damage, charge);
  } else {
    return;
  }

  const edge = Math.min(damage, def.minDamage > 0 ? def.minDamage : damage);
  const targets = [];
  const opp = opponentOf(player);
  if (opp && opp.classId) targets.push(opp);
  if (state.solo && state.dummy) targets.push(state.dummy);

  for (const target of targets) {
    if (!target.alive) continue;
    const cap = capsuleOf(target);
    const d = distToCapsule(center, cap.p, cap.radius, cap.height);
    if (d > radius) continue;
    // Linearer Falloff von Zentrum zu Rand
    const amount = lerp(damage, edge, clamp01(d / radius));
    applyDamage({
      attacker: player,
      target,
      slot: msg.slot,
      amount,
      point: null,
      knockback: def.knockback,
      source: center,
    });
    if (state.phase !== PHASE.FIGHTING) break;   // Tod hat die Runde beendet
  }
}

function handleMessage(player, msg) {
  switch (msg.type) {
    case MSG.C_HELLO: {
      const name = String(msg.name || '').trim().slice(0, 24);
      player.name = name || 'Namenlos';
      broadcastRoster();
      break;
    }
    case MSG.C_SELECT: {
      if (!CLASS_IDS.includes(msg.classId)) {
        send(player.ws, MSG.S_ERROR, { msg: 'Unbekannte Klasse.' });
        break;
      }
      if (state.phase === PHASE.LOBBY || state.phase === PHASE.CLASS_SELECT || state.phase === PHASE.MATCH_END) {
        player.classId = msg.classId;
        player.ready = false;
        broadcastRoster();
      }
      break;
    }
    case MSG.C_READY: {
      if (state.phase !== PHASE.CLASS_SELECT) break;
      player.ready = !!msg.ready;
      broadcastRoster();
      const list = [...players.values()];
      if (list.length === 2 && list.every((p) => p.ready && p.classId)) startMatch();
      break;
    }
    case MSG.C_STATE:
      handleState(player, msg);
      break;
    case MSG.C_ATTACK:
      handleAttack(player, msg);
      break;
    case MSG.C_HIT:
      handleHit(player, msg);
      break;
    case MSG.C_BREATH:
      handleBreath(player, msg);
      break;
    case MSG.C_AOE:
      handleAoe(player, msg);
      break;
    case MSG.C_REMATCH: {
      if (state.phase !== PHASE.MATCH_END || players.size !== 2) break;
      state.round = 0;
      state.scores = {};
      for (const pl of players.values()) {
        state.scores[pl.id] = 0;
        pl.ready = false;
      }
      broadcastRoster();
      setPhase(PHASE.CLASS_SELECT, 0);
      break;
    }
    case MSG.C_SOLO:
      startSolo(player);
      break;
    case MSG.C_LEAVE_SOLO:
      if (state.solo) {
        endSolo();
        player.ready = false;
        broadcastRoster();
        setPhase(PHASE.CLASS_SELECT, 0);
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// WebSocket-Verbindungen
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const lanIp = getLanIp();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});

  if (players.size >= 2) {
    send(ws, MSG.S_FULL, {});
    ws.close();
    return;
  }

  const id = 'p' + (++playerSeq);
  const player = {
    id,
    ws,
    name: 'Namenlos',
    classId: null,
    ready: false,
    hp: 0,
    maxHp: 0,
    shield: 0,
    shieldUntil: 0,
    lastState: { p: [0, 0, 0], ry: 0, pitch: 0, anim: sanitizeAnim(null), at: 0 },
    cooldowns: {},
    pendingCasts: {},
    lastBreathAt: 0,
    fallGraceUntil: 0,
    alive: false,
  };
  players.set(id, player);
  console.log(`[ASCHENTHRON] Spieler verbunden: ${id} (${players.size}/2)`);

  send(ws, MSG.S_WELCOME, { id, lanIp, port: PORT, now: Date.now() });
  broadcastRoster();

  if (state.solo) {
    // Zweiter Spieler beendet das Training, es geht in die Klassenwahl.
    endSolo();
  }
  if (players.size === 2) {
    setPhase(PHASE.CLASS_SELECT, 0);
  } else {
    send(ws, MSG.S_PHASE, { phase: state.phase, endsAt: state.endsAt, round: state.round, scores: { ...state.scores }, now: Date.now() });
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    const pl = players.get(id);
    if (!pl || pl.ws !== ws) return;
    handleMessage(pl, msg);
  });

  ws.on('close', () => {
    if (!players.has(id) || players.get(id).ws !== ws) return;
    players.delete(id);
    console.log(`[ASCHENTHRON] Spieler getrennt: ${id} (${players.size}/2)`);
    endSolo();
    if (players.size === 1) {
      const rest = [...players.values()][0];
      rest.ready = false;
      state.round = 0;
      state.scores = {};
      send(rest.ws, MSG.S_LEFT, { id });
      setPhase(PHASE.LOBBY, 0);
      broadcastRoster();
    } else if (players.size === 0) {
      state.phase = PHASE.LOBBY;
      state.endsAt = 0;
      state.round = 0;
      state.scores = {};
    }
  });
});

// Heartbeat: tote Sockets alle 10 s aufräumen.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // Socket bereits im Abbau.
    }
  }
}, 10000);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** Erste nicht-interne IPv4, bevorzugt 192.168.* / 10.*. */
function getLanIp() {
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) candidates.push(ni.address);
    }
  }
  return candidates.find((a) => a.startsWith('192.168.'))
    || candidates.find((a) => a.startsWith('10.'))
    || candidates[0]
    || '127.0.0.1';
}

function printBanner() {
  const lines = [
    { text: 'A S C H E N T H R O N', center: true },
    { text: '1v1 Dark-Fantasy-Arena-Duell · Best of 3', center: true },
    { text: '' },
    { text: `Spieler 1:  http://localhost:${PORT}` },
    { text: `Spieler 2:  http://${lanIp}:${PORT}` },
    { text: '' },
    { text: 'Beide Fenster im selben LAN öffnen — der Thron wartet.', center: true },
  ];
  const width = Math.max(...lines.map((l) => l.text.length)) + 6;
  const out = ['', '╔' + '═'.repeat(width) + '╗'];
  for (const l of lines) {
    let body;
    if (l.center) {
      const pad = width - l.text.length;
      const left = Math.floor(pad / 2);
      body = ' '.repeat(left) + l.text + ' '.repeat(pad - left);
    } else {
      body = '   ' + l.text + ' '.repeat(width - l.text.length - 3);
    }
    out.push('║' + body + '║');
  }
  out.push('╚' + '═'.repeat(width) + '╝', '');
  console.log(out.join('\n'));
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[ASCHENTHRON] Port ${PORT} ist bereits belegt. Läuft der Server schon?`);
  } else {
    console.error('[ASCHENTHRON] Serverfehler:', err && err.message ? err.message : err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  printBanner();
});
