/**
 * smoke.mjs — Headless-Laufzeittest des Clients mit echtem Chrome (WebGL).
 * Lädt das Spiel, sammelt Konsolenfehler, prüft Boot, testet ALLE Fähigkeiten
 * jeder Klasse im Solo-Modus und fährt den PvP-Flow gegen den Bot durch.
 * Beendet mit Code 1 bei ungefangenen Fehlern oder fehlenden Zuständen.
 * CLI: node test/smoke.mjs [url]
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.argv[2] || 'http://localhost:8080';
const ROOT = process.cwd();
const OUT = '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const warns = [];

function findChrome() {
  const guesses = [
    path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-146.0.7680.153/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const g of guesses) if (existsSync(g)) return g;
  return guesses[1];
}

// Treibt alle 5 Slots einer Klasse im laufenden (Solo-)Match an.
const FIRE_FN = `async () => {
  const g = window.__ASCHENTHRON__;
  const c = g.combat;
  c.combatEnabled = true;
  if (g.local) g.local.controller.inputLocked = false;
  const slots = ['primary','secondary','skill1','skill2','ultimate'];
  const press = (a) => { g.input._down = new Set([a]); g.input._pressed = new Set([a]); g.input._released = new Set(); };
  const clear = () => { g.input._down = new Set(); g.input._pressed = new Set(); g.input._released = new Set(); };
  const log = [];
  for (const a of slots) {
    try {
      press(a); c.update(0.016); g.local.abilities.update(0.016);
      // Halten simulieren (Block/Atem/Charge)
      c.update(0.05); g.local.abilities.update(0.05);
      clear();
      // Loslassen + Windups/Casts auflösen
      for (let k=0;k<5;k++){ c.update(0.2); g.local.abilities.update(0.2); g.projectiles.update(0.2); g.vfx.update(0.05); }
      log.push(a+':ok');
    } catch(e) { log.push(a+':ERR '+(e&&e.message)); }
  }
  for (let f=0; f<30; f++){ try { c.update(0.016); g.local.abilities.update(0.016); g.projectiles.update(0.016); g.vfx.update(0.016); } catch(e){ log.push('frame:ERR '+e.message); break; } }
  return log;
}`;

async function run() {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.type();
    const txt = m.text();
    // Generische Ressourcen-Meldung: 404-Klassifizierung macht der response-Handler.
    if (t === 'error' && /Failed to load resource/.test(txt)) return;
    if (t === 'error') errors.push('console.error: ' + txt);
    // Verschluckte Handler-Exceptions (NetworkClient/UIManager) als Fehler werten
    else if (t === 'warning' && /Handler für|Callback .* fehlgeschlagen/.test(txt)) errors.push('handler-warn: ' + txt);
    else if (t === 'warning') warns.push(txt);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('response', (r) => {
    if (r.status() === 404) {
      const u = r.url();
      // favicon und sourcemaps sind harmlos
      if (/favicon\.ico$/.test(u) || /\.map$/.test(u)) warns.push('404 (harmlos): ' + u.replace(BASE, ''));
      else errors.push('404: ' + u);
    }
  });

  console.log('→ Lade', BASE);
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForFunction(() => window.__ASCHENTHRON__ && window.__ASCHENTHRON__.renderer, { timeout: 10000 });

  const boot = await page.evaluate(() => {
    const g = window.__ASCHENTHRON__;
    const gl = g.renderer.getContext();
    return {
      sceneChildren: g.scene.children.length, arena: g.arena ? g.arena.key : null,
      glOk: !!gl && !gl.isContextLost(), screen: g.ui.currentScreen,
      colliderBoxes: g.colliders.boxes.length, colliderCyl: g.colliders.cylinders.length,
    };
  });
  console.log('  Boot:', JSON.stringify(boot));
  if (!boot.glOk) errors.push('WebGL-Kontext nicht ok');
  if (boot.screen !== 'menu') errors.push('Startscreen nicht Menü: ' + boot.screen);
  if (boot.colliderBoxes < 10) errors.push('Zu wenige Collider: ' + boot.colliderBoxes);
  await page.screenshot({ path: path.join(OUT, 'aschenthron-1-menu.png') });

  // --- Eintreten ---------------------------------------------------------
  await page.type('#menu-name', 'Smoke');
  await page.click('#btn-enter');
  await page.waitForFunction(() => window.__ASCHENTHRON__.ui.currentScreen === 'lobby', { timeout: 8000 });

  // --- Jede Klasse im Solo testen ---------------------------------------
  for (const cls of ['mage', 'knight', 'dragon']) {
    console.log('→ Solo-Test der Klasse:', cls);
    await page.evaluate((c) => {
      const g = window.__ASCHENTHRON__;
      if (g.phase === 'fighting') g.net.send('c_leave_solo', {});
    }, cls);
    await sleep(300);
    await page.evaluate((c) => {
      const g = window.__ASCHENTHRON__;
      g.ui.callbacks.onSelectClass(c);
    }, cls);
    await sleep(250);
    await page.evaluate(() => window.__ASCHENTHRON__.net.send('c_solo', {}));
    const ok = await page.waitForFunction(() => window.__ASCHENTHRON__.phase === 'fighting', { timeout: 8000 }).then(() => true).catch(() => false);
    if (!ok) { errors.push('Solo ' + cls + ': Kampf nicht erreicht'); continue; }
    await sleep(400);
    const info = await page.evaluate(() => {
      const g = window.__ASCHENTHRON__;
      return { localClass: g.local && g.local.classId, remoteId: g.remote && g.remote.id, myHp: g.health.mine().hp };
    });
    if (info.localClass !== cls) errors.push('Solo ' + cls + ': falsche lokale Klasse ' + info.localClass);
    if (info.remoteId !== 'dummy') errors.push('Solo ' + cls + ': kein Dummy');
    const fired = await page.evaluate('(' + FIRE_FN + ')()');
    console.log('  ', cls, '→', JSON.stringify(fired.filter((x) => x.includes('ERR')).length ? fired : 'alle Slots ok'));
    for (const f of fired) if (f.includes('ERR')) errors.push('Ability(' + cls + ') ' + f);
    if (cls === 'dragon') await page.screenshot({ path: path.join(OUT, 'aschenthron-2-solo-dragon.png') });
  }

  // --- PvP gegen Bot -----------------------------------------------------
  console.log('→ PvP gegen Bot');
  await page.evaluate(() => { const g = window.__ASCHENTHRON__; if (g.phase === 'fighting') g.net.send('c_leave_solo', {}); });
  await sleep(400);
  const bot = spawn('node', ['test/bot.js', 'ws://localhost:8080', 'knight'], { cwd: ROOT, stdio: 'ignore' });
  await sleep(1300);
  await page.evaluate(() => window.__ASCHENTHRON__.ui.callbacks.onSelectClass('mage'));
  await sleep(300);
  await page.evaluate(() => window.__ASCHENTHRON__.ui.callbacks.onReady(true));
  const reached = await page.waitForFunction(() => window.__ASCHENTHRON__.phase === 'fighting', { timeout: 14000 }).then(() => true).catch(() => false);
  await sleep(1500);
  const pvpA = await page.evaluate(() => {
    const g = window.__ASCHENTHRON__;
    return { phase: g.phase, round: g.round, remoteId: g.remote && g.remote.id, remoteClass: g.remote && g.remote.classId,
      pos: g.remote ? [Math.round(g.remote.position.x * 10) / 10, Math.round(g.remote.position.z * 10) / 10] : null };
  });
  console.log('  PvP-Start:', JSON.stringify(pvpA), 'erreicht=', reached);
  if (!reached) errors.push('PvP: Kampf nicht erreicht');
  else if (pvpA.remoteId == null) errors.push('PvP: kein Remote-Spieler');

  // Lokale Angriffe + Sync laufen lassen, Remote-Bewegung prüfen
  await page.evaluate(() => {
    const g = window.__ASCHENTHRON__;
    g.combat.combatEnabled = true; if (g.local) g.local.controller.inputLocked = false;
    const press = (a) => { g.input._down = new Set([a]); g.input._pressed = new Set([a]); };
    for (let i = 0; i < 10; i++) { press('primary'); g.combat.update(0.05); g.input._pressed = new Set(); g.input._down = new Set(); g.combat.update(0.12); g.projectiles.update(0.12); }
  });
  await sleep(2500);
  const pvpB = await page.evaluate(() => {
    const g = window.__ASCHENTHRON__;
    return { pos: g.remote ? [Math.round(g.remote.position.x * 10) / 10, Math.round(g.remote.position.z * 10) / 10] : null,
      myHp: g.health.mine().hp, theirHp: g.health.theirs().hp };
  });
  console.log('  PvP-Sync:', JSON.stringify(pvpB));
  if (reached && pvpA.pos && pvpB.pos && pvpA.pos[0] === pvpB.pos[0] && pvpA.pos[1] === pvpB.pos[1]) {
    warns.push('Remote-Position hat sich nicht bewegt (Bot evtl. statisch)');
  }
  await page.screenshot({ path: path.join(OUT, 'aschenthron-3-pvp.png') });

  try { bot.kill(); } catch {}
  await browser.close();
}

run().then(() => {
  console.log('\n=== ERGEBNIS ===');
  if (warns.length) { console.log('Warnungen:', warns.length); warns.slice(0, 8).forEach((w) => console.log('  ⚠ ' + w)); }
  if (errors.length) {
    console.log('FEHLER:', errors.length);
    errors.forEach((e) => console.log('  ✘ ' + e));
    process.exit(1);
  }
  console.log('✓ Keine Laufzeitfehler. Screenshots in /tmp/aschenthron-*.png');
  process.exit(0);
}).catch((err) => {
  console.error('Smoke-Test abgebrochen:', err && err.stack || err);
  errors.forEach((e) => console.log('  ✘ ' + e));
  process.exit(1);
});
