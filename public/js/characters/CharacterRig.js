/**
 * CharacterRig.js — Prozedurale Platzhalter-Charaktere aus three-Primitiven.
 * Baut Ritter/Magierin/Drache/Dummy als benannte Gruppenhierarchien mit
 * prozeduralen Animationen (Idle/Walk/Attack/Tod) sowie First-Person-Viewmodels
 * und Canvas-Nameplates mit HP-Balken. Materialien/Geometrien modulweit geteilt.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Klassen-Paletten (Akzentfarben, abgestimmt auf Dark-Fantasy-Look)
// ---------------------------------------------------------------------------
const PAL = {
  knight: { steel: 0x3a3f48, steelDark: 0x23262c, gold: 0xc98a3d, cloth: 0x4a1f24, emissive: 0xc98a3d },
  mage: { robe: 0x241733, robeDark: 0x160d20, trim: 0x4a2a6a, skin: 0xcdb8a6, rune: 0x9b5cff, crystal: 0x6fd3e8 },
  dragon: { scale: 0x4a1414, scaleDark: 0x2a0c0c, belly: 0x6b3a20, horn: 0x1a1518, ember: 0xff5a22, eye: 0xffc24d },
  dummy: { wood: 0x5a4226, straw: 0x9c8244, target: 0xa2293a, rope: 0x6e5a33 },
};

// ---------------------------------------------------------------------------
// Modul-weite Caches: Materialien und Geometrien werden geteilt
// ---------------------------------------------------------------------------
const MATS = new Map();
const GEOS = new Map();

// Holt/erzeugt ein MeshStandardMaterial unter einem Cache-Key
function mat(key, params) {
  let m = MATS.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial(params); MATS.set(key, m); }
  return m;
}

// Holt/erzeugt eine Geometrie unter einem Cache-Key
function geo(key, make) {
  let g = GEOS.get(key);
  if (!g) { g = make(); GEOS.set(key, g); }
  return g;
}

function mesh(g, m) {
  const o = new THREE.Mesh(g, m);
  o.castShadow = true;
  return o;
}

// Primitive auf Einheitsgeometrien, Maße via scale (maximale Wiederverwendung)
function box(material, w, h, d) {
  const o = mesh(geo('box', () => new THREE.BoxGeometry(1, 1, 1)), material);
  o.scale.set(w, h, d);
  return o;
}

function sphere(material, rx, ry = rx, rz = rx) {
  const o = mesh(geo('sph', () => new THREE.SphereGeometry(0.5, 18, 14)), material);
  o.scale.set(rx * 2, ry * 2, rz * 2);
  return o;
}

// Zylinder mit Verjüngung; Taper-Ratio wird gerundet gecacht
function cyl(material, rTop, rBottom, h) {
  const base = Math.max(rTop, rBottom, 0.0001);
  const ratio = (rTop / base).toFixed(2) + ':' + (rBottom / base).toFixed(2);
  const g = geo('cyl:' + ratio, () => new THREE.CylinderGeometry(0.5 * (rTop / base), 0.5 * (rBottom / base), 1, 14));
  const o = mesh(g, material);
  o.scale.set(base * 2, h, base * 2);
  return o;
}

function cone(material, r, h) {
  const o = mesh(geo('cone', () => new THREE.ConeGeometry(0.5, 1, 12)), material);
  o.scale.set(r * 2, h, r * 2);
  return o;
}

function octa(material, r) {
  const o = mesh(geo('octa', () => new THREE.OctahedronGeometry(0.5, 0)), material);
  o.scale.setScalar(r * 2);
  return o;
}

// Flügel-Membran als Shape (einmal gecacht, links via scale.x = -1 gespiegelt)
function wingGeo() {
  return geo('wing', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.quadraticCurveTo(0.55, 0.45, 1.0, 0.35);
    s.lineTo(0.92, 0.05);
    s.quadraticCurveTo(0.75, -0.25, 0.55, -0.3);
    s.quadraticCurveTo(0.3, -0.38, 0.12, -0.2);
    s.lineTo(0, 0);
    const g = new THREE.ShapeGeometry(s, 6);
    return g;
  });
}

// ---------------------------------------------------------------------------
// Animations-Hilfen
// ---------------------------------------------------------------------------
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = THREE.MathUtils.lerp;
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
// 0→1→0-Kurve für Schwünge
const swing01 = (p) => Math.sin(clamp01(p) * Math.PI);

// Ruhe-Pose der animierten Teile merken / pro Frame wiederherstellen
function markRest(parts) {
  for (const p of parts) {
    p.userData._rp = p.position.clone();
    p.userData._rr = new THREE.Euler().copy(p.rotation);
  }
}

function applyRest(parts) {
  for (const p of parts) {
    p.position.copy(p.userData._rp);
    p.rotation.copy(p.userData._rr);
  }
}

// Weiches Nachziehen eines Blend-Werts (für Block-/Charge-Posen)
function approach(cur, target, dt, speed) {
  return cur + (target - cur) * Math.min(1, dt * speed);
}

// Standard-Schwungdauern je Slot (Sekunden), Builder dürfen überschreiben
const DEF_DUR = { primary: 0.3, secondary: 0.45, skill1: 0.28, skill2: 0.35, ultimate: 0.5 };

// ---------------------------------------------------------------------------
// Nameplate: Canvas-Sprite mit Name + HP-Balken
// ---------------------------------------------------------------------------
export function makeNameplate(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  let frac = 1;

  function rounded(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw() {
    ctx.clearRect(0, 0, 512, 128);
    // Dunkles Panel mit Goldrand
    rounded(8, 8, 496, 112, 14);
    ctx.fillStyle = 'rgba(7, 9, 15, 0.82)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#c98a3d';
    ctx.stroke();
    // Name (Serifen, Kapitälchen-Anmutung)
    ctx.font = '600 40px Georgia, "Palatino Linotype", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8dcc0';
    const label = String(name || '???').slice(0, 18);
    ctx.fillText(label, 256, 44);
    // HP-Balken: Hintergrund + Füllung (grün → rot)
    const bx = 36, by = 78, bw = 440, bh = 26;
    rounded(bx, by, bw, bh, 8);
    ctx.fillStyle = 'rgba(20, 22, 30, 0.9)';
    ctx.fill();
    const f = clamp01(frac);
    if (f > 0.002) {
      const hue = Math.round(112 * f);
      rounded(bx + 3, by + 3, Math.max(6, (bw - 6) * f), bh - 6, 6);
      ctx.fillStyle = 'hsl(' + hue + ', 68%, 44%)';
      ctx.fill();
      rounded(bx + 3, by + 3, Math.max(6, (bw - 6) * f), (bh - 6) * 0.45, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fill();
    }
    rounded(bx, by, bw, bh, 8);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(201, 138, 61, 0.7)';
    ctx.stroke();
    tex.needsUpdate = true;
  }

  draw();
  const material = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, sizeAttenuation: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = 'nameplate';
  sprite.scale.set(1.7, 0.425, 1);
  sprite.center.set(0.5, 0);
  sprite.position.y = 2.15; // Standard: über dem Rig, Aufrufer darf anpassen
  sprite.renderOrder = 10;

  return {
    sprite,
    setHealth(f) { frac = clamp01(f); draw(); },
    dispose() {
      material.dispose();
      tex.dispose();
      if (sprite.parent) sprite.parent.remove(sprite);
    },
  };
}

// ---------------------------------------------------------------------------
// Bau-Helfer für die Rigs
// ---------------------------------------------------------------------------

// Gruppe an Position
function grp(x = 0, y = 0, z = 0) {
  const o = new THREE.Group();
  o.position.set(x, y, z);
  return o;
}

// Mesh positionieren und zurückgeben (für Inline-Assembly)
function at(o, x, y, z) {
  o.position.set(x, y, z);
  return o;
}

// Doppelseitiges, leicht glühendes Membran-/Stoff-Material
function flatMat(key, color, emissive = 0x000000, ei = 0) {
  let m = MATS.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color, emissive, emissiveIntensity: ei,
      roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide,
    });
    MATS.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Öffentliche Fabrik: Charakter-Rig (3rd-Person) oder Viewmodel (1st-Person)
// ---------------------------------------------------------------------------
/**
 * Baut ein animierbares Rig. firstPerson=true liefert ein Arme+Waffe-Viewmodel
 * zum Anhängen an die Kamera, sonst eine vollständige Figur am Fußpunkt (y=0).
 * Rückgabe-API: group, update(dt), setMove(0..1), playAttack(slot),
 * setBlocking(b), setBreath(b), setCharging(0..1), setPitch(rad), die(), reset().
 */
export function buildRig(classId, { firstPerson = false } = {}) {
  // Gemeinsamer Animationszustand, von den Settern gefüttert
  const st = {
    t: Math.random() * 10, move: 0,
    atkSlot: null, atkT: 0, atkDur: 0.3,
    block: 0, blockTarget: 0, breath: 0, breathTarget: 0,
    charge: 0, dead: 0, deadTarget: 0, pitch: 0,
  };

  const built = firstPerson ? buildViewmodel(classId, st) : buildFigure(classId, st);

  return {
    group: built.group,
    update(dt) {
      dt = dt > 0 ? dt : 0;
      st.t += dt;
      if (st.atkSlot) { st.atkT += dt; if (st.atkT >= st.atkDur) st.atkSlot = null; }
      st.block += (st.blockTarget - st.block) * Math.min(1, dt * 12);
      st.breath += (st.breathTarget - st.breath) * Math.min(1, dt * 14);
      st.dead += (st.deadTarget - st.dead) * Math.min(1, dt * 6);
      built.apply(dt);
    },
    setMove(s) { st.move = clamp01(s); },
    playAttack(slot) { st.atkSlot = slot || 'primary'; st.atkT = 0; st.atkDur = DEF_DUR[slot] || 0.3; },
    setBlocking(b) { st.blockTarget = b ? 1 : 0; },
    setBreath(b) { st.breathTarget = b ? 1 : 0; },
    setCharging(c) { st.charge = clamp01(typeof c === 'number' ? c : (c ? 1 : 0)); },
    setPitch(r) { st.pitch = (typeof r === 'number' && isFinite(r)) ? r : 0; },
    die() { st.deadTarget = 1; },
    reset() { st.deadTarget = 0; st.atkSlot = null; },
  };
}

// Aktueller Schwung-Fortschritt 0..1 und 0→1→0-Kurve
function atkP(st) { return st.atkSlot ? clamp01(st.atkT / st.atkDur) : 0; }

function buildFigure(classId, st) {
  let built;
  if (classId === 'mage') built = buildMage(st);
  else if (classId === 'dragon') built = buildDragon(st);
  else if (classId === 'dummy') built = buildDummy(st);
  else built = buildKnight(st);
  // Rigs sind nach +Z modelliert; die Spiel-Blickrichtung ist -Z. Um 180° drehen,
  // damit RemotePlayer (group.rotation.y = ry) die Figur korrekt ausrichtet.
  built.group.rotation.y = Math.PI;
  return built;
}

// ---------------------------------------------------------------------------
// Ritter — dunkler Stahl mit Goldkanten, Schwert + Wappenschild
// ---------------------------------------------------------------------------
function buildKnight(st) {
  const P = PAL.knight;
  const steel = mat('k_steel', { color: P.steel, metalness: 0.85, roughness: 0.4 });
  const dark = mat('k_dark', { color: P.steelDark, metalness: 0.8, roughness: 0.55 });
  const gold = mat('k_gold', { color: P.gold, metalness: 0.9, roughness: 0.3, emissive: P.emissive, emissiveIntensity: 0.18 });
  const skin = mat('skin', { color: 0xc2a98f, roughness: 0.7, metalness: 0 });
  const blade = mat('k_blade', { color: 0xb9c2cc, metalness: 0.95, roughness: 0.22, emissive: 0x33405a, emissiveIntensity: 0.25 });

  const g = new THREE.Group();
  const root = grp(0, 0, 0); g.add(root);

  const legL = grp(-0.16, 0, 0), legR = grp(0.16, 0, 0);
  for (const leg of [legL, legR]) {
    leg.add(at(cyl(dark, 0.11, 0.13, 0.92), 0, 0.46, 0));
    leg.add(at(box(steel, 0.24, 0.15, 0.36), 0, 0.075, 0.07));
  }
  root.add(legL, legR);

  const torso = grp(0, 0.92, 0); root.add(torso);
  torso.add(at(box(steel, 0.52, 0.62, 0.34), 0, 0.16, 0));
  torso.add(at(box(dark, 0.4, 0.26, 0.32), 0, 0.42, 0));
  torso.add(at(box(gold, 0.54, 0.07, 0.36), 0, -0.12, 0));
  // Umhang (Plane hinter dem Torso)
  const cloakMesh = new THREE.Mesh(geo('plane', () => new THREE.PlaneGeometry(1, 1)), flatMat('k_cloak', P.cloth));
  cloakMesh.position.set(0, 0.05, -0.22); cloakMesh.scale.set(0.62, 1.05, 1); cloakMesh.rotation.x = 0.14;
  torso.add(cloakMesh);

  torso.add(at(sphere(steel, 0.17), -0.34, 0.46, 0));
  torso.add(at(sphere(steel, 0.17), 0.34, 0.46, 0));

  const head = grp(0, 0.7, 0); head.name = 'head'; torso.add(head);
  head.add(at(sphere(skin, 0.13), 0, 0, 0.02));
  head.add(at(cyl(steel, 0.16, 0.18, 0.3), 0, 0.04, 0));
  head.add(at(box(dark, 0.12, 0.05, 0.18), 0, -0.02, 0.12)); // Visier
  head.add(at(cone(gold, 0.055, 0.34), 0, 0.3, -0.04));

  // Schwertarm (rechts)
  const armR = grp(0.36, 1.3, 0.04); torso.add(armR);
  armR.add(at(cyl(dark, 0.075, 0.07, 0.6), 0, -0.28, 0));
  const sword = grp(0, -0.56, 0.05); armR.add(sword);
  sword.add(at(box(gold, 0.14, 0.08, 0.14), 0, 0, 0)); // Knauf/Griff
  sword.add(at(box(gold, 0.34, 0.06, 0.07), 0, 0.06, 0)); // Parierstange
  sword.add(at(box(blade, 0.07, 1.0, 0.03), 0, 0.58, 0)); // Klinge
  sword.rotation.x = -0.3;

  // Schildarm (links)
  const armL = grp(-0.36, 1.3, 0.04); torso.add(armL);
  armL.add(at(cyl(dark, 0.075, 0.07, 0.55), 0, -0.26, 0));
  const shield = grp(0, -0.42, 0.16); armL.add(shield);
  const shieldDisc = at(cyl(steel, 0.34, 0.3, 0.08), 0, 0, 0); shieldDisc.rotation.x = Math.PI / 2;
  shield.add(shieldDisc);
  shield.add(at(cone(gold, 0.09, 0.12), 0, 0, 0.1));

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const apply = () => {
    const walk = Math.sin(st.t * 7) * st.move;
    const p = atkP(st), sw = swing01(p);
    root.position.y = Math.abs(Math.sin(st.t * 7)) * 0.05 * st.move + Math.sin(st.t * 1.6) * 0.01;
    legL.rotation.x = walk * 0.6; legR.rotation.x = -walk * 0.6;
    // Arme: Gehschwung, vom Angriff/Block überlagert
    armR.rotation.x = -walk * 0.5 - (st.atkSlot ? sw * 2.1 : 0);
    armR.rotation.z = (st.atkSlot ? -sw * 0.7 : 0);
    sword.rotation.x = -0.3 - (st.atkSlot ? sw * 0.6 : 0);
    armL.rotation.set(st.block * -1.5, st.block * 0.5, walk * 0.4 * (1 - st.block));
    head.rotation.x = (st.pitch || 0) * 0.4;
    g.rotation.z = st.dead * 1.55; g.position.y = st.dead * -0.1;
  };
  return { group: g, apply };
}

// ---------------------------------------------------------------------------
// Magierin — schlanke Silhouette, glühende Robe, Stab mit Arkankristall
// ---------------------------------------------------------------------------
function buildMage(st) {
  const P = PAL.mage;
  const robe = mat('m_robe', { color: P.robe, metalness: 0.1, roughness: 0.78, emissive: P.rune, emissiveIntensity: 0.12 });
  const robeD = mat('m_robeD', { color: P.robeDark, metalness: 0.05, roughness: 0.85 });
  const trim = mat('m_trim', { color: P.trim, metalness: 0.3, roughness: 0.5, emissive: P.rune, emissiveIntensity: 0.4 });
  const skin = mat('m_skin', { color: P.skin, roughness: 0.6, metalness: 0 });
  const crystal = mat('m_crystal', { color: P.crystal, metalness: 0.2, roughness: 0.1, emissive: P.crystal, emissiveIntensity: 1.4 });
  const wood = mat('m_wood', { color: 0x2a2118, roughness: 0.8, metalness: 0.05 });

  const g = new THREE.Group();
  const root = grp(0, 0, 0); g.add(root);

  // Fließende Robe als verjüngter Zylinder (schlanke Taille)
  const skirt = at(cyl(robe, 0.42, 0.16, 1.15), 0, 0.6, 0); root.add(skirt);
  const torso = grp(0, 1.18, 0); root.add(torso);
  torso.add(at(cyl(robe, 0.17, 0.24, 0.55), 0, 0.0, 0));
  torso.add(at(cyl(trim, 0.18, 0.18, 0.08), 0, 0.26, 0)); // glühender Gürtel
  // Runen-Streifen vorne
  const rune = at(box(trim, 0.06, 0.6, 0.02), 0, 0.05, 0.2); torso.add(rune);

  // Kapuze + Kopf
  const head = grp(0, 0.5, 0); head.name = 'head'; torso.add(head);
  head.add(at(sphere(skin, 0.12), 0, 0, 0.03));
  const hood = at(sphere(robeD, 0.18, 0.2, 0.18), 0, 0.04, -0.03); hood.scale.z = 1.2; head.add(hood);
  head.add(at(cone(robeD, 0.17, 0.22), 0, 0.16, -0.02));

  // Arme: rechts hält Stab, links frei (Glut beim Laden)
  const armR = grp(0.24, 1.34, 0.05); torso.parent.add(armR);
  armR.add(at(cyl(robe, 0.055, 0.05, 0.5), 0, -0.24, 0));
  const staff = grp(0, -0.46, 0.05); armR.add(staff);
  staff.add(at(cyl(wood, 0.035, 0.04, 1.5), 0, 0.2, 0));
  const orbStaff = at(octa(crystal, 0.12), 0, 0.98, 0); staff.add(orbStaff);
  staff.rotation.x = 0.05;

  const armL = grp(-0.24, 1.34, 0.05); torso.parent.add(armL);
  armL.add(at(cyl(robe, 0.055, 0.05, 0.46), 0, -0.22, 0));
  const palmOrb = at(sphere(crystal, 0.07), 0, -0.46, 0.06); palmOrb.visible = false; armL.add(palmOrb);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const apply = () => {
    const float = Math.sin(st.t * 1.8) * 0.05;          // schwebt leicht
    const walk = Math.sin(st.t * 6.5) * st.move;
    const p = atkP(st), sw = swing01(p);
    root.position.y = 0.05 + float + Math.abs(walk) * 0.02;
    torso.rotation.x = walk * 0.05;
    armR.rotation.x = -0.2 - (st.atkSlot ? sw * 1.7 : 0) - walk * 0.2;
    staff.rotation.x = 0.05 + (st.atkSlot ? -sw * 0.5 : 0);
    // Lade-Glühen: Orb am Stab pulsiert, Handglut sichtbar
    const glow = 1.2 + st.charge * 2.5 + (st.atkSlot ? sw : 0) * 1.5;
    crystal.emissiveIntensity = glow + Math.sin(st.t * 9) * 0.15;
    orbStaff.scale.setScalar(0.22 + st.charge * 0.3);
    palmOrb.visible = st.charge > 0.02;
    palmOrb.scale.setScalar(0.4 + st.charge * 1.4);
    armL.rotation.x = -st.charge * 0.8 - walk * 0.2;
    rune.material.emissiveIntensity = 0.3 + st.charge * 0.8;
    head.rotation.x = (st.pitch || 0) * 0.3;
    g.rotation.z = st.dead * 1.55; g.position.y = st.dead * -0.05;
  };
  return { group: g, apply };
}

// ---------------------------------------------------------------------------
// Drache — gedrungener Koloss, Membranflügel, Schwanz, glühender Maulkern
// ---------------------------------------------------------------------------
function buildDragon(st) {
  const P = PAL.dragon;
  const scaleM = mat('d_scale', { color: P.scale, metalness: 0.3, roughness: 0.6, emissive: P.ember, emissiveIntensity: 0.08 });
  const scaleD = mat('d_scaleD', { color: P.scaleDark, metalness: 0.25, roughness: 0.7 });
  const belly = mat('d_belly', { color: P.belly, metalness: 0.15, roughness: 0.65 });
  const horn = mat('d_horn', { color: P.horn, metalness: 0.2, roughness: 0.55 });
  const ember = mat('d_ember', { color: P.ember, metalness: 0.1, roughness: 0.4, emissive: P.ember, emissiveIntensity: 1.6 });
  const eyeM = mat('d_eye', { color: P.eye, emissive: P.eye, emissiveIntensity: 1.2, roughness: 0.3 });
  const membrane = flatMat('d_wing', P.scaleDark, P.ember, 0.05);

  const g = new THREE.Group();
  const root = grp(0, 0, 0); g.add(root);

  // Hinterbeine
  const legL = grp(-0.28, 0, 0.1), legR = grp(0.28, 0, 0.1);
  for (const leg of [legL, legR]) {
    leg.add(at(cyl(scaleD, 0.16, 0.2, 0.85), 0, 0.42, 0));
    leg.add(at(box(horn, 0.34, 0.14, 0.5), 0, 0.07, 0.16));
  }
  root.add(legL, legR);

  // Rumpf, leicht vorgebeugt
  const body = grp(0, 0.95, 0); body.rotation.x = 0.2; root.add(body);
  body.add(at(sphere(scaleM, 0.5, 0.55, 0.7), 0, 0, 0));
  body.add(at(sphere(belly, 0.42, 0.4, 0.5), 0, -0.18, 0.16));
  // Rückenkamm
  for (let i = 0; i < 5; i++) body.add(at(cone(horn, 0.07, 0.22), 0, 0.4 - i * 0.02, -0.3 + i * 0.16));

  // Hals + Kopf
  const neck = grp(0, 0.3, 0.45); body.add(neck); neck.rotation.x = -0.5;
  neck.add(at(cyl(scaleM, 0.22, 0.3, 0.7), 0, 0.3, 0));
  const head = grp(0, 0.62, 0.06); head.name = 'head'; neck.add(head); head.rotation.x = 0.4;
  head.add(at(box(scaleM, 0.34, 0.3, 0.42), 0, 0, 0.1)); // Schädel
  const jaw = grp(0, -0.12, 0.18); head.add(jaw);
  jaw.add(at(box(scaleD, 0.3, 0.12, 0.36), 0, 0, 0.08)); // Unterkiefer
  const maw = at(sphere(ember, 0.1), 0, 0.0, 0.18); head.add(maw); // Glutkern im Rachen
  head.add(at(cone(horn, 0.05, 0.34), -0.12, 0.22, -0.05));
  head.add(at(cone(horn, 0.05, 0.34), 0.12, 0.22, -0.05));
  head.add(at(sphere(eyeM, 0.04), -0.13, 0.08, 0.22));
  head.add(at(sphere(eyeM, 0.04), 0.13, 0.08, 0.22));

  // Flügel
  const wingGeometry = wingGeo();
  const wingL = grp(-0.45, 1.2, -0.1), wingR = grp(0.45, 1.2, -0.1);
  const wL = new THREE.Mesh(wingGeometry, membrane); wL.scale.setScalar(1.5); wingL.add(wL);
  const wR = new THREE.Mesh(wingGeometry, membrane); wR.scale.set(-1.5, 1.5, 1.5); wingR.add(wR);
  body.add(wingL, wingR);

  // Vorderklauen
  const armL = grp(-0.34, 1.0, 0.3), armR = grp(0.34, 1.0, 0.3);
  for (const arm of [armL, armR]) { arm.add(at(cyl(scaleD, 0.1, 0.08, 0.5), 0, -0.22, 0)); arm.rotation.x = 0.5; }
  body.add(armL, armR);

  // Schwanz aus Segmenten
  const tailSegs = [];
  let parent = body; let tailRoot = grp(0, -0.1, -0.5); body.add(tailRoot); parent = tailRoot;
  for (let i = 0; i < 4; i++) {
    const seg = grp(0, 0, -0.3);
    seg.add(at(cyl(scaleD, 0.18 - i * 0.035, 0.15 - i * 0.035, 0.34), 0, 0, -0.17));
    parent.add(seg); tailSegs.push(seg); parent = seg;
  }
  parent.add(at(cone(horn, 0.1, 0.3), 0, 0, -0.3));

  g.scale.setScalar(1.0); // Klassen-scale macht der Aufrufer/Controller-Daten
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const apply = (dt) => {
    const walk = Math.sin(st.t * 5) * st.move;
    const p = atkP(st), sw = swing01(p);
    root.position.y = Math.abs(walk) * 0.04;
    legL.rotation.x = walk * 0.5; legR.rotation.x = -walk * 0.5;
    // Flügelschlag
    const flap = Math.sin(st.t * 3) * 0.3 + 0.2 + (st.atkSlot === 'skill1' ? sw * 0.8 : 0);
    wingL.rotation.z = flap; wingR.rotation.z = -flap;
    wingL.rotation.y = 0.3; wingR.rotation.y = -0.3;
    // Schwanzwelle
    tailSegs.forEach((s, i) => { s.rotation.y = Math.sin(st.t * 3 - i * 0.7) * (0.22 + (st.atkSlot === 'skill2' ? sw * 0.5 : 0)); });
    // Klauenhieb
    armR.rotation.x = 0.5 - (st.atkSlot === 'primary' ? sw * 1.8 : 0);
    armL.rotation.x = 0.5 - (st.atkSlot === 'primary' ? sw * 0.6 : 0);
    // Maul beim Atem öffnen + glühen
    jaw.rotation.x = st.breath * 0.6 + (st.atkSlot ? sw * 0.2 : 0);
    maw.scale.setScalar(0.18 + st.breath * 0.7 + Math.sin(st.t * 10) * 0.06 * st.breath);
    ember.emissiveIntensity = 1.4 + st.breath * 2.5;
    head.rotation.x = 0.4 + (st.pitch || 0) * 0.3;
    g.rotation.z = st.dead * 1.4; g.position.y = st.dead * -0.15;
  };
  return { group: g, apply };
}

// ---------------------------------------------------------------------------
// Dummy — Holzpfahl mit Strohpuppe und Zielscheibe
// ---------------------------------------------------------------------------
function buildDummy(st) {
  const P = PAL.dummy;
  const wood = mat('dm_wood', { color: P.wood, roughness: 0.9, metalness: 0 });
  const straw = mat('dm_straw', { color: P.straw, roughness: 0.85, metalness: 0 });
  const red = mat('dm_red', { color: P.target, roughness: 0.7, metalness: 0, emissive: 0x3a0a0e, emissiveIntensity: 0.2 });
  const white = mat('dm_white', { color: 0xd9cdb0, roughness: 0.8 });

  const g = new THREE.Group();
  g.add(at(cyl(wood, 0.12, 0.16, 0.6), 0, 0.3, 0));        // Sockel
  const body = grp(0, 0.6, 0); g.add(body);
  body.add(at(cyl(straw, 0.26, 0.22, 1.0), 0, 0.5, 0));    // Strohkörper
  body.add(at(box(wood, 1.0, 0.1, 0.1), 0, 0.7, 0));       // Querbalken (Arme)
  const head = grp(0, 1.15, 0); head.name = 'head'; body.add(head);
  head.add(at(sphere(straw, 0.18), 0, 0, 0));
  // Zielscheibe auf der Brust
  const t1 = at(cyl(white, 0.2, 0.2, 0.04), 0, 0.5, 0.22); t1.rotation.x = Math.PI / 2; body.add(t1);
  const t2 = at(cyl(red, 0.12, 0.12, 0.05), 0, 0.5, 0.24); t2.rotation.x = Math.PI / 2; body.add(t2);
  const t3 = at(cyl(white, 0.05, 0.05, 0.06), 0, 0.5, 0.25); t3.rotation.x = Math.PI / 2; body.add(t3);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const apply = () => {
    // Leichtes Pendeln nach Treffern simuliert über die Zeit; kippt im "Tod"
    body.rotation.x = Math.sin(st.t * 2) * 0.02;
    g.rotation.z = st.dead * 1.4;
    g.position.y = st.dead * -0.1;
  };
  return { group: g, apply };
}

// ---------------------------------------------------------------------------
// Viewmodels (1st-Person): Arme + Waffe, positioniert zum Anhängen an die Kamera
// ---------------------------------------------------------------------------
function buildViewmodel(classId, st) {
  if (classId === 'mage') return buildMageVM(st);
  if (classId === 'dragon') return buildDragonVM(st);
  return buildKnightVM(st);
}

// Gemeinsame Hand
function handMesh(material) { return sphere(material, 0.07); }

function buildKnightVM(st) {
  const P = PAL.knight;
  const steel = mat('k_steel', { color: P.steel, metalness: 0.85, roughness: 0.4 });
  const gold = mat('k_gold', { color: P.gold, metalness: 0.9, roughness: 0.3, emissive: P.emissive, emissiveIntensity: 0.18 });
  const blade = mat('k_blade', { color: 0xb9c2cc, metalness: 0.95, roughness: 0.22, emissive: 0x33405a, emissiveIntensity: 0.3 });
  const glove = mat('k_glove', { color: 0x20242b, metalness: 0.6, roughness: 0.5 });

  const g = new THREE.Group();
  // Schwertarm rechts
  const swordArm = grp(0.32, -0.34, -0.5); g.add(swordArm);
  swordArm.add(at(cyl(glove, 0.05, 0.06, 0.4), 0, 0.12, 0.15));
  swordArm.add(at(handMesh(glove), 0, 0, 0));
  const sword = grp(0, 0.02, -0.1); swordArm.add(sword);
  sword.add(at(box(gold, 0.06, 0.06, 0.16), 0, 0, 0.04));
  sword.add(at(box(gold, 0.22, 0.05, 0.05), 0, 0, -0.04));
  sword.add(at(box(blade, 0.045, 0.04, 0.9), 0, 0, -0.5));
  sword.rotation.set(-0.1, 0, 0);

  // Schildarm links
  const shieldArm = grp(-0.34, -0.36, -0.42); g.add(shieldArm);
  const shield = at(cyl(steel, 0.26, 0.24, 0.06), 0, 0, 0); shield.rotation.x = Math.PI / 2;
  shieldArm.add(shield);
  shieldArm.add(at(cone(gold, 0.07, 0.1), 0, 0, 0.08));
  shieldArm.rotation.y = 0.3;

  g.traverse((o) => { if (o.isMesh) o.castShadow = false; });

  const apply = () => {
    const p = atkP(st), sw = swing01(p);
    const bob = Math.sin(st.t * 7) * 0.012 * st.move + Math.sin(st.t * 1.8) * 0.004;
    g.position.y = bob;
    // Diagonaler Schwertschwung
    swordArm.rotation.set(-0.1 - sw * 0.3, sw * 0.9, -sw * 1.4);
    swordArm.position.z = -0.5 + sw * 0.18;
    // Schild hoch beim Blocken
    shieldArm.position.set(-0.34 + st.block * 0.16, -0.36 + st.block * 0.2, -0.42 + st.block * 0.12);
    shieldArm.rotation.set(st.block * -0.3, 0.3 - st.block * 0.3, 0);
  };
  return { group: g, apply };
}

function buildMageVM(st) {
  const P = PAL.mage;
  const robe = mat('m_robe', { color: P.robe, metalness: 0.1, roughness: 0.78, emissive: P.rune, emissiveIntensity: 0.12 });
  const wood = mat('m_wood', { color: 0x2a2118, roughness: 0.8, metalness: 0.05 });
  const crystal = mat('m_crystal', { color: P.crystal, metalness: 0.2, roughness: 0.1, emissive: P.crystal, emissiveIntensity: 1.4 });
  const skin = mat('m_skin', { color: P.skin, roughness: 0.6 });

  const g = new THREE.Group();
  // Stabhand rechts
  const staffArm = grp(0.26, -0.36, -0.5); g.add(staffArm);
  staffArm.add(at(cyl(robe, 0.05, 0.045, 0.34), 0.02, 0.1, 0.12));
  staffArm.add(at(handMesh(skin), 0, 0, 0));
  const staff = grp(0, 0.04, 0); staffArm.add(staff);
  staff.add(at(cyl(wood, 0.025, 0.03, 1.1), 0, 0.1, -0.4));
  const orb = at(octa(crystal, 0.09), 0, 0.16, -0.92); staff.add(orb);
  staff.rotation.x = 0.25;

  // Freie Hand links mit Ladeglut
  const palmArm = grp(-0.28, -0.4, -0.42); g.add(palmArm);
  palmArm.add(at(handMesh(skin), 0, 0, 0));
  const palmOrb = at(sphere(crystal, 0.06), 0, 0.04, -0.05); palmOrb.visible = false; palmArm.add(palmOrb);

  g.traverse((o) => { if (o.isMesh) o.castShadow = false; });

  const apply = () => {
    const p = atkP(st), sw = swing01(p);
    const bob = Math.sin(st.t * 6) * 0.01 * st.move + Math.sin(st.t * 1.6) * 0.005;
    g.position.y = bob;
    // Stoß nach vorn beim Zaubern
    staffArm.position.z = -0.5 - sw * 0.14;
    staffArm.rotation.x = -sw * 0.5;
    const glow = 1.2 + st.charge * 3 + sw * 2;
    crystal.emissiveIntensity = glow + Math.sin(st.t * 10) * 0.2;
    orb.scale.setScalar(0.16 + st.charge * 0.3 + sw * 0.12);
    // Ladeglut in der freien Hand
    palmOrb.visible = st.charge > 0.02;
    palmOrb.scale.setScalar(0.5 + st.charge * 2);
    palmArm.position.set(-0.28 + st.charge * 0.06, -0.4 + st.charge * 0.08, -0.42 - st.charge * 0.06);
  };
  return { group: g, apply };
}

function buildDragonVM(st) {
  const P = PAL.dragon;
  const scaleM = mat('d_scale', { color: P.scale, metalness: 0.3, roughness: 0.6, emissive: P.ember, emissiveIntensity: 0.08 });
  const scaleD = mat('d_scaleD', { color: P.scaleDark, metalness: 0.25, roughness: 0.7 });
  const claw = mat('d_claw', { color: 0x171015, metalness: 0.3, roughness: 0.5 });

  const g = new THREE.Group();
  // Zwei Klauenhände
  const handR = grp(0.34, -0.42, -0.46), handL = grp(-0.34, -0.44, -0.48);
  for (const [hand, sgn] of [[handR, 1], [handL, -1]]) {
    hand.add(at(cyl(scaleD, 0.1, 0.08, 0.34), 0, 0.06, 0.12));
    const palm = at(sphere(scaleM, 0.1), 0, 0, 0); hand.add(palm);
    for (let i = 0; i < 3; i++) {
      const c = at(cone(claw, 0.022, 0.18), (i - 1) * 0.07, 0.0, -0.12);
      c.rotation.x = -1.3; hand.add(c);
    }
    hand.rotation.y = sgn * 0.2;
  }
  g.add(handR, handL);

  g.traverse((o) => { if (o.isMesh) o.castShadow = false; });

  const apply = () => {
    const p = atkP(st), sw = swing01(p);
    const bob = Math.sin(st.t * 5) * 0.014 * st.move + Math.sin(st.t * 1.4) * 0.006;
    g.position.y = bob;
    // Wechselnder Klauenswipe
    handR.position.z = -0.46 - sw * 0.22;
    handR.rotation.set(-sw * 0.5, 0.2 - sw * 0.6, sw * 0.5);
    handL.position.z = -0.48 - (1 - sw) * 0.05;
    // Beim Atem beide Hände leicht zurück
    g.position.z = st.breath * 0.05;
  };
  return { group: g, apply };
}
