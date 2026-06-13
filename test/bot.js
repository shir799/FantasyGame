/**
 * bot.js — Headless-Zweitspieler für ASCHENTHRON (Test + Trainingsgegner).
 * Verbindet sich per WebSocket, wählt eine Klasse, läuft im Kampf auf einer
 * Kreisbahn um die Arenamitte und greift in Intervallen an.
 * CLI: node test/bot.js [url] [classId]   (Default: ws://localhost:8080, knight)
 */

import WebSocket from 'ws';
import { MSG, PHASE } from '../shared/protocol.js';
import { CLASS_IDS, getClass, SLOT } from '../shared/classes.js';

const url = process.argv[2] || 'ws://localhost:8080';
const classId = CLASS_IDS.includes(process.argv[3]) ? process.argv[3] : 'knight';
const classDef = getClass(classId);

const TICK_MS = 50;                 // 20 Hz Zustands-Sendetakt
const CIRCLE_RADIUS = 8;            // Ziel-Kreisbahn um die Arenamitte
const GROUND_Y = 0.5;               // plausible Bodenhöhe

const bot = {
  id: null,
  phase: PHASE.LOBBY,
  pos: [CIRCLE_RADIUS, GROUND_Y, 0],
  ry: 0,
  angle: 0,
  radius: CIRCLE_RADIUS,
  enemies: new Map(),               // id → letzte Position [x,y,z]
  nextAttackAt: 0,
  selected: false,
};

function log(...args) {
  console.log('[Bot]', ...args);
}

function fmtScores(scores) {
  if (!scores) return '-';
  return Object.entries(scores).map(([id, n]) => `${id}:${n}`).join(' ');
}

const ws = new WebSocket(url);

function send(type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

ws.on('open', () => {
  log(`Verbunden mit ${url} — Klasse: ${classId}`);
  send(MSG.C_HELLO, { name: 'Bot' });
});

ws.on('close', () => {
  log('Verbindung geschlossen. Ende.');
  process.exit(0);
});

ws.on('error', (err) => {
  log('Fehler:', err && err.message ? err.message : err);
  process.exit(1);
});

ws.on('message', (data) => {
  let msg;
  try {
    msg = JSON.parse(String(data));
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;
  handle(msg);
});

function handle(msg) {
  switch (msg.type) {
    case MSG.S_WELCOME:
      bot.id = msg.id;
      log(`Begrüßt als ${bot.id} (Server ${msg.lanIp}:${msg.port})`);
      break;
    case MSG.S_PHASE:
      onPhase(msg);
      break;
    case MSG.S_RESET:
      onReset(msg);
      break;
    case MSG.S_STATE:
      if (msg.id !== bot.id && Array.isArray(msg.p)) bot.enemies.set(msg.id, msg.p);
      break;
    case MSG.S_DAMAGE:
      log(`Schaden: ${msg.targetId} -${msg.amount}${msg.blocked ? ' (geblockt)' : ''} → HP ${msg.hp}${msg.shield ? ` | Schild ${msg.shield}` : ''}`);
      break;
    case MSG.S_DEATH:
      log(`Tod: ${msg.targetId}${msg.attackerId ? ` (durch ${msg.attackerId})` : ''}`);
      break;
    case MSG.S_ROUND_END:
      log(`Rundenende — Sieger: ${msg.winnerId || 'unentschieden'} | Stand ${fmtScores(msg.scores)}`);
      break;
    case MSG.S_MATCH_END:
      log(`Matchende — Sieger: ${msg.winnerId} | Stand ${fmtScores(msg.scores)} — Rematch in 2 s`);
      setTimeout(() => {
        if (bot.phase === PHASE.MATCH_END) send(MSG.C_REMATCH, {});
      }, 2000);
      break;
    case MSG.S_LEFT:
      log(`Gegner ${msg.id} hat verlassen.`);
      bot.enemies.delete(msg.id);
      break;
    case MSG.S_FULL:
      log('Server voll (2/2). Ende.');
      process.exit(1);
      break;
    case MSG.S_ERROR:
      log('Serverfehler:', msg.msg);
      break;
    default:
      break;
  }
}

function onPhase(msg) {
  const prev = bot.phase;
  bot.phase = msg.phase;
  if (msg.phase !== prev) {
    log(`Phase: ${msg.phase}${msg.round ? ` (Runde ${msg.round})` : ''}${msg.scores && Object.keys(msg.scores).length ? ` | Stand ${fmtScores(msg.scores)}` : ''}`);
  }
  if (msg.phase === PHASE.CLASS_SELECT) {
    // Kurz warten, dann Klasse wählen und bereit melden (auch nach Rematch).
    bot.selected = false;
    setTimeout(() => {
      if (bot.phase !== PHASE.CLASS_SELECT || bot.selected) return;
      bot.selected = true;
      send(MSG.C_SELECT, { classId });
      send(MSG.C_READY, { ready: true });
      log(`Klasse gewählt: ${classDef.name} — bereit.`);
    }, 400);
  }
  if (msg.phase === PHASE.FIGHTING) {
    bot.nextAttackAt = Date.now() + 1500 + Math.random() * 1500;
  }
}

function onReset(msg) {
  const spawn = msg.spawns && msg.spawns[bot.id];
  if (!spawn || !Array.isArray(spawn.p)) return;
  bot.pos = [spawn.p[0], spawn.p[1], spawn.p[2]];
  bot.ry = Number(spawn.ry) || 0;
  // Kreisbahn am Spawn aufnehmen und sanft auf den Zielradius einschwenken.
  bot.angle = Math.atan2(spawn.p[2], spawn.p[0]);
  bot.radius = Math.max(2, Math.hypot(spawn.p[0], spawn.p[2]));
}

/** Nächstgelegene bekannte Gegnerposition oder null. */
function nearestEnemy() {
  let best = null;
  let bestDist = Infinity;
  for (const [id, p] of bot.enemies) {
    const d = Math.hypot(p[0] - bot.pos[0], p[1] - bot.pos[1], p[2] - bot.pos[2]);
    if (d < bestDist) {
      bestDist = d;
      best = { id, p, dist: d };
    }
  }
  return best;
}

function maybeAttack(now) {
  if (now < bot.nextAttackAt) return;
  bot.nextAttackAt = now + 1500 + Math.random() * 1500;
  const ability = classDef.abilities[SLOT.PRIMARY];
  const enemy = nearestEnemy();
  const origin = [bot.pos[0], bot.pos[1] + classDef.eyeHeight, bot.pos[2]];
  // Blickrichtung: auf den Gegner, sonst zur Arenamitte.
  let dx = -bot.pos[0];
  let dy = 0;
  let dz = -bot.pos[2];
  if (enemy) {
    dx = enemy.p[0] - bot.pos[0];
    dy = enemy.p[1] + 1.2 - origin[1];
    dz = enemy.p[2] - bot.pos[2];
  }
  const len = Math.hypot(dx, dy, dz) || 1;
  send(MSG.C_ATTACK, {
    slot: SLOT.PRIMARY,
    origin,
    dir: [dx / len, dy / len, dz / len],
    charge: 0,
  });
  // Treffer-Claim nur, wenn der Gegner plausibel in Reichweite steht.
  if (enemy && enemy.dist <= (ability.range || 0) * 1.15) {
    send(MSG.C_HIT, {
      slot: SLOT.PRIMARY,
      targetId: enemy.id,
      point: [enemy.p[0], enemy.p[1] + 1.2, enemy.p[2]],
      charge: 0,
    });
  }
}

// Bewegungs-/Sende-Schleife: Position nur im Kampf bewegen, in Countdown und
// Rundenpause am Platz stehen und trotzdem Zustand melden.
setInterval(() => {
  if (bot.phase !== PHASE.COUNTDOWN && bot.phase !== PHASE.FIGHTING && bot.phase !== PHASE.ROUND_END) return;
  const now = Date.now();
  const dt = TICK_MS / 1000;
  const moving = bot.phase === PHASE.FIGHTING;

  if (moving) {
    bot.radius += (CIRCLE_RADIUS - bot.radius) * Math.min(1, dt * 0.6);
    bot.angle += (classDef.moveSpeed / bot.radius) * dt;
    bot.pos = [
      Math.cos(bot.angle) * bot.radius,
      GROUND_Y,
      Math.sin(bot.angle) * bot.radius,
    ];
    // Blick in Laufrichtung (Tangente); forward = (-sin ry, 0, -cos ry).
    const tx = -Math.sin(bot.angle);
    const tz = Math.cos(bot.angle);
    bot.ry = Math.atan2(-tx, -tz);
  }

  send(MSG.C_STATE, {
    p: bot.pos,
    ry: bot.ry,
    pitch: 0,
    anim: { moving, sprinting: false, grounded: true, blocking: false, breath: false, charging: false },
  });

  if (moving) maybeAttack(now);
}, TICK_MS);
