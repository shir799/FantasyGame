/**
 * Arena.js — Prozedurale Dark-Fantasy-Arena „Ruinenburg" (Nacht).
 * Steinboden, erhöhte Mittelplattform, gebrochener Außenwall (mit unsichtbarer
 * Containment-Hülle), Säulen, Schutt, Deckung, Spawn-Podeste, Fackeln (Flamme +
 * begrenzte Flacker-Lichter), Mondlicht, Nebel, Sternenkuppel und Ambient-Partikel.
 * Determiniert über einen festen Seed, damit beide Clients dieselbe Arena bauen.
 */
import * as THREE from 'three';

// Deterministischer PRNG (mulberry32) — gleicher Seed → gleiche Arena auf beiden Macs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Prozedurale Steintextur via Canvas: Fugenraster + Helligkeits-/Farbnoise.
function makeStoneTexture(rng, tint) {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  // Grundton
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, S, S);
  // Quaderfugen (versetzte Reihen)
  const rows = 6, h = S / rows;
  for (let r = 0; r < rows; r++) {
    const cols = 5;
    const w = S / cols;
    const offset = (r % 2) * (w / 2);
    for (let c = -1; c < cols; c++) {
      const x = c * w + offset;
      const y = r * h;
      // leichte Quader-Helligkeitsvariation (deutlich heller als Nachthimmel)
      const b = 0.82 + rng() * 0.3;
      ctx.fillStyle = `rgba(${Math.floor(118 * b)},${Math.floor(112 * b)},${Math.floor(102 * b)},0.7)`;
      ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
      // Fugen
      ctx.strokeStyle = 'rgba(18,16,14,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }
  }
  // Körnungs-/Schmutznoise
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 38;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Baut die Ruinenburg in game.scene, registriert Collider in game.colliders und
 * Partikel in game.vfx. Rückgabe: { key, spawns, center, update(dt), dispose() }.
 */
export function buildRuinenburg(game) {
  const scene = game.scene;
  const colliders = game.colliders;
  const vfx = game.vfx;
  const rng = mulberry32(1337);

  const group = new THREE.Group();
  group.name = 'arena_ruinenburg';
  scene.add(group);

  const disposables = [];   // Geometrien/Materialien/Texturen
  const lights = [];        // { light, base, phase, freq } für Fackel-Flackern
  const handles = [];       // VFX-Handles (Fackeln, Ambient)
  let clock = 0;

  const track = (obj) => { disposables.push(obj); return obj; };

  // Materialien -----------------------------------------------------------
  const floorTex = track(makeStoneTexture(rng, '#4a4843'));
  floorTex.repeat.set(12, 12);
  const wallTex = track(makeStoneTexture(rng, '#52483e'));
  wallTex.repeat.set(2, 2);

  const floorMat = track(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92, metalness: 0.02, color: 0xb8b4ac }));
  const stoneMat = track(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9, metalness: 0.03, color: 0xc0b4a4 }));
  const stoneDark = track(new THREE.MeshStandardMaterial({ color: 0x6a635a, roughness: 0.94, metalness: 0.02 }));
  const plinthMat = track(new THREE.MeshStandardMaterial({ color: 0x9a9186, roughness: 0.88, metalness: 0.05, map: wallTex }));
  const ironMat = track(new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.6, metalness: 0.5 }));

  // Geteilte Geometrien ---------------------------------------------------
  const boxGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const cylGeo = track(new THREE.CylinderGeometry(0.5, 0.5, 1, 18));

  // Hilfsfunktionen: sichtbares Mesh + optional Collider --------------------
  const _min = new THREE.Vector3(), _max = new THREE.Vector3();

  function addBoxMesh(mat, cx, cy, cz, sx, sy, sz, { collide = true, ry = 0, shadow = true } = {}) {
    const m = new THREE.Mesh(boxGeo, mat);
    m.position.set(cx, cy, cz);
    m.scale.set(sx, sy, sz);
    m.rotation.y = ry;
    m.castShadow = shadow; m.receiveShadow = true;
    m.matrixAutoUpdate = false; m.updateMatrix();
    group.add(m);
    // Collider nur achsenparallel (ry≈0) als AABB; gedrehte Deko ohne Collider.
    if (collide && Math.abs(ry) < 0.0001) {
      _min.set(cx - sx / 2, cy - sy / 2, cz - sz / 2);
      _max.set(cx + sx / 2, cy + sy / 2, cz + sz / 2);
      colliders.addBox(_min, _max);
    }
    return m;
  }

  function addCylMesh(mat, cx, cz, r, h, { collide = true, yBase = 0, shadow = true } = {}) {
    const m = new THREE.Mesh(cylGeo, mat);
    m.position.set(cx, yBase + h / 2, cz);
    m.scale.set(r * 2, h, r * 2);
    m.castShadow = shadow; m.receiveShadow = true;
    m.matrixAutoUpdate = false; m.updateMatrix();
    group.add(m);
    if (collide) colliders.addCylinder(cx, cz, r, yBase, yBase + h);
    return m;
  }

  // --- Boden -------------------------------------------------------------
  addBoxMesh(floorMat, 0, -1, 0, 46, 2, 46, { collide: true, shadow: false });

  // --- Erhöhte Mittelplattform (zwei runde Stufen, begehbar via stepUp) ---
  addCylMesh(plinthMat, 0, 0, 7.0, 0.35, { yBase: 0 });
  addCylMesh(plinthMat, 0, 0, 4.2, 0.7, { yBase: 0 });
  // Zierring/Glyphe in der Mitte (nur Deko)
  const glyph = new THREE.Mesh(track(new THREE.RingGeometry(2.2, 3.4, 32)), track(new THREE.MeshStandardMaterial({
    color: 0x3a2d18, emissive: 0xc98a3d, emissiveIntensity: 0.25, roughness: 0.7, side: THREE.DoubleSide,
  })));
  glyph.rotation.x = -Math.PI / 2;
  glyph.position.set(0, 0.71, 0);
  glyph.receiveShadow = true; glyph.matrixAutoUpdate = false; glyph.updateMatrix();
  group.add(glyph);

  // --- Spawn-Podeste gegenüber (Oberkante 0.6 = Server-Spawn-Höhe) --------
  for (const sx of [-16, 16]) {
    addBoxMesh(plinthMat, sx, 0.3, 0, 4, 0.6, 4);
    // niedrige Stufe Richtung Mitte für leichteren Wiederaufstieg
    addBoxMesh(plinthMat, sx + (sx < 0 ? 2.6 : -2.6), 0.15, 0, 1.2, 0.3, 4);
  }

  // --- Gebrochener Außenwall: unsichtbare Containment-Hülle + Optik --------
  const RINGS = 24;
  const RADIUS = 21.5;
  const gaps = new Set([3, 4, 11, 18]); // Lücken im sichtbaren Wall
  for (let i = 0; i < RINGS; i++) {
    const a = (i / RINGS) * Math.PI * 2;
    const x = Math.cos(a) * RADIUS;
    const z = Math.sin(a) * RADIUS;
    const segLen = (Math.PI * 2 * RADIUS) / RINGS + 0.6;
    // Unsichtbare, hohe Blockerwand (immer da → niemand fällt heraus)
    const bx = new THREE.Mesh(boxGeo, ironMat);
    bx.visible = false;
    _min.set(x - 1.4, 0, z - 1.4); _max.set(x + 1.4, 8, z + 1.4);
    colliders.addBox(_min, _max);
    // Sichtbares Wall-Segment (variable Höhe, mit Lücken)
    if (!gaps.has(i)) {
      const hgt = 2.2 + rng() * 4.5;
      const seg = new THREE.Mesh(boxGeo, stoneMat);
      seg.position.set(x, hgt / 2, z);
      seg.rotation.y = a + Math.PI / 2;
      seg.scale.set(segLen * 0.5, hgt, 1.4 + rng() * 0.6);
      seg.castShadow = true; seg.receiveShadow = true;
      seg.matrixAutoUpdate = false; seg.updateMatrix();
      group.add(seg);
      // gelegentliche Zinne
      if (rng() > 0.5) {
        const cren = new THREE.Mesh(boxGeo, stoneDark);
        cren.position.set(x, hgt + 0.3, z);
        cren.rotation.y = a + Math.PI / 2;
        cren.scale.set(0.7, 0.6, 1.0);
        cren.castShadow = true; cren.matrixAutoUpdate = false; cren.updateMatrix();
        group.add(cren);
      }
    }
  }

  // --- Säulen (einige stehend, einige gestürzt) ---------------------------
  const columns = [
    [-9, -9], [9, -9], [-9, 9], [9, 9],
    [-13, 0], [13, 0], [0, -13], [0, 13],
  ];
  columns.forEach(([cx, cz], idx) => {
    if (idx % 3 === 2) {
      // Gestürzte Säule: liegender Zylinder (Deko, grober Box-Collider)
      const len = 4 + rng() * 1.5;
      const lying = new THREE.Mesh(cylGeo, stoneMat);
      const ang = rng() * Math.PI;
      lying.position.set(cx, 0.45, cz);
      lying.scale.set(0.9, len, 0.9);
      lying.rotation.set(Math.PI / 2, ang, 0);
      lying.castShadow = true; lying.receiveShadow = true;
      lying.matrixAutoUpdate = false; lying.updateMatrix();
      group.add(lying);
      addBoxMesh(stoneDark, cx, 0.45, cz, 1.4, 0.9, 1.4, { collide: true, shadow: false });
    } else {
      const h = 4.5 + rng() * 2.5;
      addCylMesh(stoneMat, cx, cz, 0.55, h, { yBase: 0 });
      // Kapitell
      addBoxMesh(stoneDark, cx, h + 0.15, cz, 1.5, 0.3, 1.5, { collide: false });
    }
  });

  // --- Deckungsmauern (halbhoch) -----------------------------------------
  addBoxMesh(stoneMat, -5.5, 0.9, 6, 5, 1.8, 0.8);
  addBoxMesh(stoneMat, 5.5, 0.9, -6, 5, 1.8, 0.8);
  // Schutthaufen (verkippte Brocken, grobe Box-Collider an der Basis)
  for (let i = 0; i < 6; i++) {
    const ax = (rng() - 0.5) * 30;
    const az = (rng() - 0.5) * 30;
    if (Math.hypot(ax, az) < 6) continue; // Mitte frei halten
    const s = 0.6 + rng() * 1.1;
    addBoxMesh(stoneDark, ax, s * 0.4, az, s * 1.6, s * 0.8, s * 1.6, { ry: rng() * Math.PI, collide: false });
    addBoxMesh(stoneDark, ax, s * 0.3, az, s * 1.2, s * 0.6, s * 1.2, { collide: true, shadow: false });
  }

  // --- Fackeln: Flamme + begrenzt echte Lichter --------------------------
  const MAX_TORCH_LIGHTS = 6;
  const torchPos = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.26;
    torchPos.push([Math.cos(a) * 18.5, Math.sin(a) * 18.5]);
  }
  torchPos.forEach(([tx, tz], i) => {
    // Halterung (Eisenstab + Schale)
    addCylMesh(ironMat, tx, tz, 0.06, 1.6, { yBase: 0, collide: false, shadow: false });
    const bowl = new THREE.Mesh(cylGeo, ironMat);
    bowl.position.set(tx, 1.65, tz); bowl.scale.set(0.34, 0.2, 0.34);
    bowl.castShadow = false; bowl.matrixAutoUpdate = false; bowl.updateMatrix();
    group.add(bowl);
    const flamePos = new THREE.Vector3(tx, 1.85, tz);
    if (typeof vfx.torchFlame === 'function') handles.push(vfx.torchFlame(flamePos));
    // Emissive-Glutkugel (immer, auch ohne echtes Licht)
    const ember = new THREE.Mesh(cylGeo, track(new THREE.MeshStandardMaterial({
      color: 0xff7a2a, emissive: 0xff6a1f, emissiveIntensity: 1.6, roughness: 0.5,
    })));
    ember.position.copy(flamePos); ember.scale.set(0.18, 0.22, 0.18);
    ember.matrixAutoUpdate = false; ember.updateMatrix();
    group.add(ember);
    // Nur die ersten 6 Fackeln bekommen ein echtes, flackerndes PointLight
    if (i < MAX_TORCH_LIGHTS) {
      const pl = new THREE.PointLight(0xff8a3a, 2.4, 12, 2);
      pl.position.set(tx, 2.0, tz);
      pl.castShadow = false;
      group.add(pl);
      lights.push({ light: pl, base: 2.4, phase: rng() * 6.28, freq: 8 + rng() * 6 });
    }
  });

  // --- Beleuchtung: Mond + Hemisphäre ------------------------------------
  const moon = new THREE.DirectionalLight(0xb8cdf0, 2.4);
  moon.position.set(-18, 26, 12);
  moon.target.position.set(0, 0, 0);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.near = 1;
  moon.shadow.camera.far = 80;
  moon.shadow.camera.left = -26; moon.shadow.camera.right = 26;
  moon.shadow.camera.top = 26; moon.shadow.camera.bottom = -26;
  moon.shadow.bias = -0.0004;
  group.add(moon); group.add(moon.target);

  // Warme Fülllampe von der Gegenseite (kein Schatten) — hebt die dunkle Seite an
  const fillDir = new THREE.DirectionalLight(0xffae6a, 0.7);
  fillDir.position.set(20, 14, -16);
  group.add(fillDir);

  const hemi = new THREE.HemisphereLight(0x6072a0, 0x2a2620, 1.15);
  group.add(hemi);
  const ambient = new THREE.AmbientLight(0x4a5066, 0.7);
  group.add(ambient);

  // --- Nebel + Himmel ----------------------------------------------------
  scene.fog = new THREE.FogExp2(0x141a26, 0.006);
  scene.background = new THREE.Color(0x05070d);

  // Sternenkuppel (invertierte Kugel mit Vertex-Farbverlauf)
  const skyGeo = track(new THREE.SphereGeometry(220, 24, 16));
  const colors = [];
  const pos = skyGeo.attributes.position;
  const top = new THREE.Color(0x0a1430), bot = new THREE.Color(0x02030a);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) / 220) * 0.5 + 0.5, 0, 1);
    const c = bot.clone().lerp(top, t);
    colors.push(c.r, c.g, c.b);
  }
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(skyGeo, track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
  sky.matrixAutoUpdate = false; sky.updateMatrix();
  group.add(sky);

  // Sterne
  const starCount = 800;
  const starGeo = track(new THREE.BufferGeometry());
  const sp = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const u = rng(), v = rng() * 0.5; // obere Hemisphäre
    const th = u * Math.PI * 2, ph = Math.acos(v);
    const r = 180;
    sp[i * 3] = r * Math.sin(ph) * Math.cos(th);
    sp[i * 3 + 1] = r * Math.cos(ph) + 10;
    sp[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const stars = new THREE.Points(starGeo, track(new THREE.PointsMaterial({
    color: 0xcfd8ff, size: 0.7, sizeAttenuation: true, transparent: true, opacity: 0.85, fog: false, depthWrite: false,
  })));
  group.add(stars);

  // Mond als additives Sprite
  const moonTex = track(makeMoonTexture());
  const moonSprite = new THREE.Sprite(track(new THREE.SpriteMaterial({
    map: moonTex, color: 0xcad6ff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false,
  })));
  moonSprite.scale.setScalar(26);
  moonSprite.position.set(-70, 95, 60);
  group.add(moonSprite);

  // Ferne Ruinen-Silhouetten (schwarze Boxen außerhalb des Walls, ohne Collider)
  const silMat = track(new THREE.MeshBasicMaterial({ color: 0x05060b, fog: true }));
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2;
    const dist = 55 + rng() * 30;
    const sx = Math.cos(a) * dist, sz = Math.sin(a) * dist;
    const h = 14 + rng() * 26;
    const sil = new THREE.Mesh(boxGeo, silMat);
    sil.position.set(sx, h / 2, sz);
    sil.scale.set(5 + rng() * 8, h, 5 + rng() * 8);
    sil.rotation.y = rng() * Math.PI;
    sil.matrixAutoUpdate = false; sil.updateMatrix();
    group.add(sil);
  }

  // Ambient-Staub/Glut über der Kampfzone
  if (typeof vfx.ambient === 'function') {
    handles.push(vfx.ambient({ min: new THREE.Vector3(-20, 0.2, -20), max: new THREE.Vector3(20, 9, 20) }));
  }

  // --- Rückgabeobjekt ----------------------------------------------------
  return {
    key: 'ruinenburg',
    name: 'Ruinenburg',
    spawns: [
      { p: new THREE.Vector3(-16, 0.6, 0), ry: -Math.PI / 2 },
      { p: new THREE.Vector3(16, 0.6, 0), ry: Math.PI / 2 },
    ],
    center: new THREE.Vector3(0, 0.7, 0),

    update(dt) {
      clock += dt;
      // Fackel-Flackern (warmes, unregelmäßiges Pulsieren)
      for (const t of lights) {
        const n = Math.sin(clock * t.freq + t.phase) * 0.5
          + Math.sin(clock * t.freq * 1.7 + t.phase * 2.3) * 0.3;
        t.light.intensity = t.base * (0.78 + 0.22 * n);
      }
    },

    dispose() {
      for (const h of handles) { if (h && typeof h.dispose === 'function') h.dispose(); }
      for (const l of lights) { if (l.light.parent) l.light.parent.remove(l.light); }
      if (scene.fog) scene.fog = null;
      scene.remove(group);
      group.traverse((o) => {
        if (o.isMesh || o.isPoints) {
          if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
        }
      });
      for (const d of disposables) { if (d && typeof d.dispose === 'function') d.dispose(); }
    },
  };
}

// Weiches Mondscheiben-Sprite (radialer Verlauf mit leichten Maria-Flecken).
function makeMoonTexture() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(210,224,255,0.85)');
  g.addColorStop(0.8, 'rgba(120,150,220,0.25)');
  g.addColorStop(1, 'rgba(80,110,180,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
