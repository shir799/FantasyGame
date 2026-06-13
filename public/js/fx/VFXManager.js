/**
 * VFXManager — alle visuellen Effekte: gepoolte Punktpartikel (additiv + Rauch),
 * Ring-/Truemmer-Transients, gepoolte Blitz-Lichter (max 3) sowie anhaltende
 * Handle-Effekte (Trail, Atemkegel, Schildblase, Charge-Orb, Fackel, Ambient).
 * CPU-Update pro Frame; Caps: ~2000 Partikel gesamt, keine unbegrenzten Lights.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Konstanten & Temporaries (keine Allokationen im Hot Path)
// ---------------------------------------------------------------------------
const ADDITIVE_CAP = 1400;
const SMOKE_CAP = 600;
const LIGHT_POOL_SIZE = 3;
const GRAVITY = 22;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

/** Zufaellige Richtung auf der Einheitskugel. */
function randUnit(out) {
  const u = Math.random() * 2 - 1;
  const phi = Math.random() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - u * u));
  return out.set(s * Math.cos(phi), u, s * Math.sin(phi));
}

/** Zufaellige Richtung innerhalb eines Kegels um dir (Halbwinkel in rad).
 *  Eigene Temporaries, damit out/dir nicht mit _v1.._v4 kollidieren. */
const _ct1 = new THREE.Vector3();
const _ct2 = new THREE.Vector3();
function randCone(out, dir, halfAngle) {
  const cosA = Math.cos(halfAngle);
  const z = cosA + Math.random() * (1 - cosA);
  const phi = Math.random() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  // Orthonormalbasis um dir bauen
  _ct1.set(Math.abs(dir.y) > 0.9 ? 1 : 0, Math.abs(dir.y) > 0.9 ? 0 : 1, 0);
  _ct2.crossVectors(dir, _ct1).normalize();
  _ct1.crossVectors(_ct2, dir);
  return out
    .copy(dir).multiplyScalar(z)
    .addScaledVector(_ct2, s * Math.cos(phi))
    .addScaledVector(_ct1, s * Math.sin(phi));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// ---------------------------------------------------------------------------
// Canvas-Texturen
// ---------------------------------------------------------------------------

/** Weicher radialer Glow (weiss → transparent). */
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Weicher Rauch-Blob aus mehreren ueberlagerten Radial-Gradienten. */
function makeSmokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 30;
    const x = 64 + Math.cos(a) * r;
    const y = 64 + Math.sin(a) * r;
    const rad = rand(18, 34);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Punkt-Shader: position/size/color/alpha pro Partikel via Attributes
// ---------------------------------------------------------------------------
const POINT_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (620.0 / max(0.1, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const POINT_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(vColor, vAlpha) * tex;
    if (gl_FragColor.a < 0.004) discard;
  }
`;

/**
 * Fester Partikel-Pool: eine Points-Instanz, Attribute-Arrays werden
 * wiederverwendet. Tote Partikel werden unsichtbar geparkt (y = -9999).
 */
class ParticlePool {
  constructor(scene, capacity, texture, blending, renderOrder) {
    this.capacity = capacity;
    this._cursor = 0;

    this._pos = new Float32Array(capacity * 3);
    this._size = new Float32Array(capacity);
    this._col = new Float32Array(capacity * 3);
    this._alp = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) this._pos[i * 3 + 1] = -9999;

    this._vel = new Float32Array(capacity * 3);
    this._life = new Float32Array(capacity);
    this._maxLife = new Float32Array(capacity);
    this._grav = new Float32Array(capacity);
    this._drag = new Float32Array(capacity);
    this._size0 = new Float32Array(capacity);
    this._size1 = new Float32Array(capacity);
    this._alpha0 = new Float32Array(capacity);
    this._alpha1 = new Float32Array(capacity);
    this._col0 = new Float32Array(capacity * 3);
    this._col1 = new Float32Array(capacity * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this._size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this._col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this._alp, 1).setUsage(THREE.DynamicDrawUsage));
    // Nie frustum-cullen: Partikel sind ueberall in der Arena
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture } },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      blending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.geometry = geo;
    scene.add(this.points);
  }

  /**
   * Partikel spawnen. o: {pos, vel, life, size0, size1, color0, color1,
   * alpha0, alpha1, gravity, drag}. Voller Pool ueberschreibt den aeltesten Slot.
   */
  emit(o) {
    let idx = -1;
    for (let k = 0; k < this.capacity; k++) {
      const i = (this._cursor + k) % this.capacity;
      if (this._life[i] <= 0) { idx = i; break; }
    }
    if (idx < 0) idx = this._cursor;
    this._cursor = (idx + 1) % this.capacity;

    const i3 = idx * 3;
    this._pos[i3] = o.pos.x; this._pos[i3 + 1] = o.pos.y; this._pos[i3 + 2] = o.pos.z;
    this._vel[i3] = o.vel ? o.vel.x : 0;
    this._vel[i3 + 1] = o.vel ? o.vel.y : 0;
    this._vel[i3 + 2] = o.vel ? o.vel.z : 0;
    const life = Math.max(0.016, o.life || 0.5);
    this._life[idx] = life;
    this._maxLife[idx] = life;
    this._grav[idx] = o.gravity || 0;
    this._drag[idx] = o.drag || 0;
    this._size0[idx] = o.size0 != null ? o.size0 : 0.2;
    this._size1[idx] = o.size1 != null ? o.size1 : 0.02;
    this._alpha0[idx] = o.alpha0 != null ? o.alpha0 : 1;
    this._alpha1[idx] = o.alpha1 != null ? o.alpha1 : 0;
    _c1.set(o.color0 != null ? o.color0 : 0xffffff);
    _c2.set(o.color1 != null ? o.color1 : _c1);
    this._col0[i3] = _c1.r; this._col0[i3 + 1] = _c1.g; this._col0[i3 + 2] = _c1.b;
    this._col1[i3] = _c2.r; this._col1[i3 + 1] = _c2.g; this._col1[i3 + 2] = _c2.b;
    this._size[idx] = this._size0[idx];
    this._alp[idx] = this._alpha0[idx];
    this._col[i3] = _c1.r; this._col[i3 + 1] = _c1.g; this._col[i3 + 2] = _c1.b;
  }

  update(dt) {
    const n = this.capacity;
    for (let i = 0; i < n; i++) {
      let life = this._life[i];
      if (life <= 0) continue;
      life -= dt;
      const i3 = i * 3;
      if (life <= 0) {
        this._life[i] = 0;
        this._alp[i] = 0;
        this._size[i] = 0;
        this._pos[i3 + 1] = -9999;
        continue;
      }
      this._life[i] = life;
      const damp = Math.max(0, 1 - this._drag[i] * dt);
      this._vel[i3] *= damp;
      this._vel[i3 + 2] *= damp;
      this._vel[i3 + 1] = this._vel[i3 + 1] * damp - this._grav[i] * dt;
      this._pos[i3] += this._vel[i3] * dt;
      this._pos[i3 + 1] += this._vel[i3 + 1] * dt;
      this._pos[i3 + 2] += this._vel[i3 + 2] * dt;
      const t = 1 - life / this._maxLife[i];
      this._size[i] = this._size0[i] + (this._size1[i] - this._size0[i]) * t;
      this._alp[i] = this._alpha0[i] + (this._alpha1[i] - this._alpha0[i]) * t;
      this._col[i3] = this._col0[i3] + (this._col1[i3] - this._col0[i3]) * t;
      this._col[i3 + 1] = this._col0[i3 + 1] + (this._col1[i3 + 1] - this._col0[i3 + 1]) * t;
      this._col[i3 + 2] = this._col0[i3 + 2] + (this._col1[i3 + 2] - this._col0[i3 + 2]) * t;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  killAll() {
    for (let i = 0; i < this.capacity; i++) {
      this._life[i] = 0;
      this._alp[i] = 0;
      this._size[i] = 0;
      this._pos[i * 3 + 1] = -9999;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Licht-Pool: feste Anzahl PointLights, nie neue Lights zur Laufzeit
// ---------------------------------------------------------------------------
class LightPool {
  constructor(scene, count) {
    this._entries = [];
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 8, 2);
      light.visible = false;
      scene.add(light);
      this._entries.push({ light, ttl: 0, dur: 1, intensity: 0 });
    }
  }

  /** Blitz-Licht setzen; freier Slot, sonst der am weitesten abgeklungene. */
  flash(pos, colorHex, intensity, distance, duration) {
    let best = this._entries[0];
    for (const e of this._entries) {
      if (e.ttl <= 0) { best = e; break; }
      if (e.ttl < best.ttl) best = e;
    }
    best.light.position.copy(pos);
    best.light.color.set(colorHex != null ? colorHex : 0xffffff);
    best.light.distance = distance;
    best.light.intensity = intensity;
    best.light.visible = true;
    best.intensity = intensity;
    best.dur = Math.max(0.05, duration);
    best.ttl = best.dur;
  }

  update(dt) {
    for (const e of this._entries) {
      if (e.ttl <= 0) continue;
      e.ttl -= dt;
      if (e.ttl <= 0) {
        e.light.intensity = 0;
        e.light.visible = false;
      } else {
        const f = e.ttl / e.dur;
        e.light.intensity = e.intensity * f * f;
      }
    }
  }

  reset() {
    for (const e of this._entries) {
      e.ttl = 0;
      e.light.intensity = 0;
      e.light.visible = false;
    }
  }
}

// ---------------------------------------------------------------------------
// VFXManager
// ---------------------------------------------------------------------------
export class VFXManager {
  constructor(scene) {
    this.scene = scene;
    this._glowTex = makeGlowTexture();
    this._smokeTex = makeSmokeTexture();

    // Zwei Pools: additiver Glow (Funken/Flammen/Flashes) + Rauch (Normal-Blend)
    this._smoke = new ParticlePool(scene, SMOKE_CAP, this._smokeTex, THREE.NormalBlending, 90);
    this._additive = new ParticlePool(scene, ADDITIVE_CAP, this._glowTex, THREE.AdditiveBlending, 100);
    this._lights = new LightPool(scene, LIGHT_POOL_SIZE);

    // Geteilte Geometrien fuer Transients
    this._ringGeo = new THREE.RingGeometry(0.86, 1, 56);
    this._discGeo = new THREE.CircleGeometry(1, 48);
    this._boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this._sphereGeo = new THREE.SphereGeometry(1, 24, 16);

    // Transiente Objekte ({update(dt)→alive, dispose()}) + anhaltende Handles
    this._transients = [];
    this._handles = new Set();
  }

  // -------------------------------------------------------------------------
  // Frame-Update & Aufraeumen
  // -------------------------------------------------------------------------
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.016;
    dt = Math.min(dt, 0.05);
    this._additive.update(dt);
    this._smoke.update(dt);
    this._lights.update(dt);
    for (let i = this._transients.length - 1; i >= 0; i--) {
      const t = this._transients[i];
      if (!t.update(dt)) {
        t.dispose();
        this._transients.splice(i, 1);
      }
    }
    for (const h of this._handles) h._update(dt);
  }

  /**
   * Alle Einmal-Effekte und transienten Handles entsorgen (Runden-Reset).
   * Persistente Arena-Emitter (torchFlame, ambient) bleiben bestehen —
   * deren dispose() raeumt sie bei Arena-Abbau weg.
   */
  clearTransient() {
    this._additive.killAll();
    this._smoke.killAll();
    this._lights.reset();
    for (const t of this._transients) t.dispose();
    this._transients.length = 0;
    for (const h of Array.from(this._handles)) {
      if (!h._persistent) h.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Interne Helfer
  // -------------------------------------------------------------------------

  /** Expandierender Ring (flach am Boden), Fade ueber Opacity. */
  _spawnRing(pos, r0, r1, duration, colorHex, opacity0 = 0.85) {
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex != null ? colorHex : 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: opacity0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this._ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 0.05, pos.z);
    mesh.scale.setScalar(Math.max(0.01, r0));
    mesh.renderOrder = 95;
    this.scene.add(mesh);
    let t = 0;
    this._transients.push({
      update: (dt) => {
        t += dt;
        const f = Math.min(1, t / duration);
        const r = r0 + (r1 - r0) * (1 - (1 - f) * (1 - f)); // ease-out
        mesh.scale.setScalar(Math.max(0.01, r));
        mat.opacity = opacity0 * (1 - f);
        return f < 1;
      },
      dispose: () => {
        this.scene.remove(mesh);
        mat.dispose();
      },
    });
  }

  /** Grosser additiver Glow-Blitz als Partikel. */
  _flashParticle(pos, size, life, colorHex, alpha = 1) {
    this._additive.emit({
      pos, vel: null, life,
      size0: size, size1: size * 0.55,
      color0: colorHex, color1: colorHex,
      alpha0: alpha, alpha1: 0,
    });
  }

  /** Handle registrieren; dispose entfernt es sicher (idempotent). */
  _makeHandle(record) {
    const handle = {
      _persistent: !!record.persistent,
      _disposed: false,
      _update: record.update || (() => {}),
      set: record.set || (() => {}),
      setLevel: record.setLevel || (() => {}),
      dispose: () => {
        if (handle._disposed) return;
        handle._disposed = true;
        this._handles.delete(handle);
        if (record.dispose) record.dispose();
      },
    };
    this._handles.add(handle);
    return handle;
  }

  /** Welt-Skalierung eines Parents kompensieren (Drache scale 1.4 etc.). */
  _inverseWorldScale(obj) {
    obj.getWorldScale(_v1);
    const s = Math.max(0.0001, (_v1.x + _v1.y + _v1.z) / 3);
    return 1 / s;
  }

  // -------------------------------------------------------------------------
  // Einmal-Effekte
  // -------------------------------------------------------------------------

  /** Muendungsblitz beim Cast (Arkanblitz/Feuerball-Start). */
  muzzleFlash(pos, colorHex) {
    if (!pos) return;
    const col = colorHex != null ? colorHex : 0xffe9b0;
    this._flashParticle(pos, 0.5, 0.08, col, 0.95);
    for (let i = 0; i < 6; i++) {
      randUnit(_v1).multiplyScalar(rand(2, 5));
      this._additive.emit({
        pos, vel: _v1, life: rand(0.1, 0.2),
        size0: 0.09, size1: 0.01,
        color0: col, color1: col,
        alpha0: 0.9, alpha1: 0, drag: 4,
      });
    }
  }

  /** Funken am Einschlagpunkt entlang der Normalen. */
  hitSparks(pos, normal, colorHex) {
    if (!pos) return;
    const col = colorHex != null ? colorHex : 0xffd080;
    const n = (normal && normal.isVector3) ? normal : _v2.set(0, 1, 0);
    this._flashParticle(pos, 0.35, 0.08, col, 0.85);
    for (let i = 0; i < 12; i++) {
      randUnit(_v1).addScaledVector(n, 1.4).normalize().multiplyScalar(rand(2, 7));
      this._additive.emit({
        pos, vel: _v1, life: rand(0.22, 0.45),
        size0: 0.08, size1: 0.01,
        color0: 0xfff2c8, color1: col,
        alpha0: 1, alpha1: 0, gravity: 9, drag: 1.2,
      });
    }
  }

  /** Dunkelroter Nebel bei Spieler-Treffern — bewusst dezent. */
  bloodPuff(pos) {
    if (!pos) return;
    for (let i = 0; i < 9; i++) {
      randUnit(_v1).multiplyScalar(rand(0.3, 0.9));
      _v1.y = Math.abs(_v1.y) * 0.5 + 0.25;
      this._smoke.emit({
        pos, vel: _v1, life: rand(0.45, 0.8),
        size0: rand(0.18, 0.3), size1: rand(0.55, 0.8),
        color0: 0x5a1016, color1: 0x1c0507,
        alpha0: 0.32, alpha1: 0, drag: 2.5,
      });
    }
  }

  /** Explosion: Kern-Flash, Funkensphaere, Rauch, Bodenring, Blitz-Licht 0.25 s. */
  explosion(pos, radius, palette) {
    if (!pos) return;
    const r = Math.max(0.5, radius || 1.5);
    const p = palette === 'arcane'
      ? { core: 0xeafaff, spark0: 0x9fe8ff, spark1: 0x8a4dff, smoke: 0x131a2a, ring: 0x6fd3e8, light: 0x86d9ff }
      : { core: 0xfff0b8, spark0: 0xffb24a, spark1: 0xff4a12, smoke: 0x241c14, ring: 0xff9a3d, light: 0xff9540 };

    // Kern-Flash (zwei Lagen)
    this._flashParticle(pos, r * 1.7, 0.13, p.core, 1);
    this._flashParticle(pos, r * 1.0, 0.2, p.spark0, 0.9);

    // Funkensphaere
    const sparks = Math.min(48, 24 + Math.floor(r * 6));
    for (let i = 0; i < sparks; i++) {
      randUnit(_v1);
      _v1.y = _v1.y * 0.8 + 0.25;
      _v1.normalize().multiplyScalar(rand(r * 2.2, r * 4.6));
      this._additive.emit({
        pos, vel: _v1, life: rand(0.3, 0.7),
        size0: rand(0.1, 0.18), size1: 0.01,
        color0: p.spark0, color1: p.spark1,
        alpha0: 1, alpha1: 0, gravity: 10, drag: 1.6,
      });
    }

    // Rauch (traege, aufsteigend)
    for (let i = 0; i < 10; i++) {
      randUnit(_v1).multiplyScalar(rand(0.8, 2.2));
      _v1.y = Math.abs(_v1.y) + rand(0.8, 1.8);
      this._smoke.emit({
        pos, vel: _v1, life: rand(0.8, 1.4),
        size0: r * 0.35, size1: r * 0.95,
        color0: p.smoke, color1: 0x07090c,
        alpha0: 0.34, alpha1: 0, drag: 1.8, gravity: -0.6,
      });
    }

    // Expandierender Bodenring + gepooltes Blitz-Licht
    this._spawnRing(pos, 0.15, r * 1.6, 0.42, p.ring, 0.8);
    this._lights.flash(pos, p.light, 26 * r, r * 8, 0.25);
  }

  /** Expandierender Bodenring (Nova-Detonation, Knockback-Welle). */
  shockwave(pos, maxRadius, colorHex) {
    if (!pos) return;
    const col = colorHex != null ? colorHex : 0x6fd3e8;
    this._spawnRing(pos, 0.2, Math.max(1, maxRadius || 5), 0.5, col, 0.9);
    this._spawnRing(pos, 0.1, Math.max(0.6, (maxRadius || 5) * 0.6), 0.32, col, 0.6);
  }

  /** Erdspalter/Infernoschlag am Boden: Ring + fliegende Truemmer + Staub. */
  groundSlam(pos, radius) {
    if (!pos) return;
    const r = Math.max(1, radius || 5);
    this._spawnRing(pos, 0.2, r, 0.38, 0xd9a55c, 0.85);

    // Truemmer-Boxen mit Ballistik und Drall
    const count = 9;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x57514a, roughness: 0.95, metalness: 0, transparent: true, opacity: 1,
    });
    const boxes = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this._boxGeo, mat);
      const s = rand(0.1, 0.28);
      m.scale.set(s, s * rand(0.6, 1.2), s);
      const a = Math.random() * Math.PI * 2;
      m.position.set(pos.x + Math.cos(a) * rand(0.2, r * 0.4), pos.y + 0.1, pos.z + Math.sin(a) * rand(0.2, r * 0.4));
      m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.scene.add(m);
      boxes.push({
        m,
        vel: new THREE.Vector3(Math.cos(a) * rand(2, 5), rand(4.5, 8), Math.sin(a) * rand(2, 5)),
        spin: new THREE.Vector3(rand(-7, 7), rand(-7, 7), rand(-7, 7)),
      });
    }
    const groundY = pos.y;
    let t = 0;
    const dur = 1.25;
    this._transients.push({
      update: (dt) => {
        t += dt;
        for (const b of boxes) {
          b.vel.y -= GRAVITY * dt;
          b.m.position.addScaledVector(b.vel, dt);
          if (b.m.position.y < groundY + 0.05) {
            b.m.position.y = groundY + 0.05;
            b.vel.y = Math.abs(b.vel.y) * 0.3;
            b.vel.x *= 0.6;
            b.vel.z *= 0.6;
          }
          b.m.rotation.x += b.spin.x * dt;
          b.m.rotation.y += b.spin.y * dt;
          b.m.rotation.z += b.spin.z * dt;
        }
        mat.opacity = t > dur - 0.3 ? Math.max(0, (dur - t) / 0.3) : 1;
        return t < dur;
      },
      dispose: () => {
        for (const b of boxes) this.scene.remove(b.m);
        mat.dispose();
      },
    });

    // Staubwolke flach nach aussen
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      _v1.set(Math.cos(a) * rand(2, 4.5), rand(0.4, 1.2), Math.sin(a) * rand(2, 4.5));
      this._smoke.emit({
        pos, vel: _v1, life: rand(0.6, 1.1),
        size0: 0.5, size1: 1.6,
        color0: 0x4a443a, color1: 0x14110d,
        alpha0: 0.3, alpha1: 0, drag: 2.4,
      });
    }
    // Glut-Funken niedrig
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      _v1.set(Math.cos(a) * rand(3, 6), rand(1, 3), Math.sin(a) * rand(3, 6));
      this._additive.emit({
        pos, vel: _v1, life: rand(0.3, 0.6),
        size0: 0.12, size1: 0.01,
        color0: 0xffc878, color1: 0xff5010,
        alpha0: 0.9, alpha1: 0, gravity: 12, drag: 1.2,
      });
    }
    this._lights.flash(pos, 0xffb060, 20 * Math.min(2.5, r * 0.35), r * 5, 0.25);
  }

  /** Pulsierender Warnring der Nova; Innenring schrumpft ueber duration. */
  novaTelegraph(center, radius, durationS) {
    if (!center) return;
    const r = Math.max(1, radius || 5);
    const dur = Math.max(0.1, durationS || 0.8);
    const col = 0xa86bff;

    const ringMat = new THREE.MeshBasicMaterial({
      color: col, blending: THREE.AdditiveBlending, transparent: true,
      opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
    });
    const outer = new THREE.Mesh(this._ringGeo, ringMat);
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(center.x, center.y + 0.06, center.z);
    outer.scale.setScalar(r);
    outer.renderOrder = 95;

    const innerMat = ringMat.clone();
    innerMat.opacity = 0.7;
    const inner = new THREE.Mesh(this._ringGeo, innerMat);
    inner.rotation.x = -Math.PI / 2;
    inner.position.set(center.x, center.y + 0.07, center.z);
    inner.scale.setScalar(r);
    inner.renderOrder = 96;

    const discMat = new THREE.MeshBasicMaterial({
      color: col, blending: THREE.AdditiveBlending, transparent: true,
      opacity: 0.06, depthWrite: false, side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(this._discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(center.x, center.y + 0.04, center.z);
    disc.scale.setScalar(r);
    disc.renderOrder = 94;

    this.scene.add(outer, inner, disc);
    let t = 0;
    this._transients.push({
      update: (dt) => {
        t += dt;
        const f = Math.min(1, t / dur);
        const pulse = 0.5 + 0.5 * Math.sin(t * 18);
        ringMat.opacity = 0.3 + 0.3 * pulse;
        discMat.opacity = 0.04 + 0.05 * pulse * f;
        inner.scale.setScalar(Math.max(0.05, r * (1 - f)));
        return f < 1;
      },
      dispose: () => {
        this.scene.remove(outer, inner, disc);
        ringMat.dispose();
        innerMat.dispose();
        discMat.dispose();
      },
    });
  }

  /** Blink: Lichtstreifen von A nach B plus Flash an beiden Enden. */
  blinkFlash(fromPos, toPos, colorHex) {
    if (!fromPos || !toPos) return;
    const col = colorHex != null ? colorHex : 0x9b5cff;
    const dist = _v1.copy(toPos).sub(fromPos).length();
    const count = Math.max(8, Math.min(40, Math.floor(dist * 6)));
    for (let i = 0; i < count; i++) {
      const f = i / (count - 1);
      _v2.copy(fromPos).lerp(toPos, f);
      randUnit(_v3).multiplyScalar(rand(0, 0.18));
      _v2.add(_v3);
      randUnit(_v3).multiplyScalar(rand(0.2, 0.8));
      this._additive.emit({
        pos: _v2, vel: _v3, life: rand(0.16, 0.3),
        size0: 0.18, size1: 0.02,
        color0: 0xffffff, color1: col,
        alpha0: 0.9, alpha1: 0, drag: 3,
      });
    }
    _v2.copy(fromPos); _v2.y += 1;
    this._flashParticle(_v2, 0.9, 0.12, col, 0.95);
    _v2.copy(toPos); _v2.y += 1;
    this._flashParticle(_v2, 1.1, 0.16, 0xffffff, 0.95);
    this._lights.flash(_v2, col, 14, 6, 0.2);
  }

  // -------------------------------------------------------------------------
  // Anhaltende Effekte (Handles mit set/setLevel/dispose)
  // -------------------------------------------------------------------------

  /** Projektil-Schweif: emittiert Glow-Partikel entlang der Flugbahn. */
  trail(object3D, colorHex) {
    if (!object3D) return this._makeHandle({});
    const col = colorHex != null ? colorHex : 0x9b5cff;
    const last = new THREE.Vector3();
    let primed = false;
    let on = true;
    return this._makeHandle({
      update: () => {
        if (!on || !object3D.parent) return;
        object3D.getWorldPosition(_v1);
        if (!primed) { last.copy(_v1); primed = true; return; }
        const dist = _v2.copy(_v1).sub(last).length();
        if (dist > 4) { last.copy(_v1); return; } // Teleport/Reset: kein Streifen
        const steps = Math.min(8, Math.max(1, Math.floor(dist / 0.14)));
        for (let i = 1; i <= steps; i++) {
          _v3.copy(last).lerp(_v1, i / steps);
          this._additive.emit({
            pos: _v3, vel: null, life: 0.28,
            size0: 0.2, size1: 0.02,
            color0: col, color1: col,
            alpha0: 0.75, alpha1: 0,
          });
        }
        last.copy(_v1);
      },
      set: (v) => { on = !!v; primed = false; },
      setLevel: () => {},
      dispose: () => { on = false; },
    });
  }

  /**
   * Feueratem-Kegel: dichter Flammenstrom (orange → gelb) aus parentObj,
   * Richtung = getWorldDirection(parentObj). set(on) steuert die Emission.
   */
  breathCone(parentObj, colorHex) {
    if (!parentObj) return this._makeHandle({});
    const col0 = colorHex != null ? colorHex : 0xff7a22;
    let on = false;
    let accum = 0;
    const RATE = 170;
    const HALF_ANGLE = THREE.MathUtils.degToRad(16);
    return this._makeHandle({
      update: (dt) => {
        if (!on || !parentObj.parent) return;
        accum += dt * RATE;
        if (accum < 1) return;
        parentObj.getWorldPosition(_v1);
        parentObj.getWorldDirection(_v2);
        const count = Math.min(12, Math.floor(accum));
        accum -= count;
        for (let i = 0; i < count; i++) {
          randCone(_v4, _v2, HALF_ANGLE).multiplyScalar(rand(11, 15));
          _v3.copy(_v1);
          _v3.x += rand(-0.06, 0.06);
          _v3.y += rand(-0.06, 0.06);
          _v3.z += rand(-0.06, 0.06);
          this._additive.emit({
            pos: _v3, vel: _v4, life: rand(0.28, 0.48),
            size0: rand(0.22, 0.34), size1: rand(0.7, 1.0),
            color0: col0, color1: 0xffe49a,
            alpha0: 0.85, alpha1: 0, gravity: -2.5, drag: 1.4,
          });
        }
        // Gelegentlich traegen Rauch hinterher
        if (Math.random() < 0.25) {
          randCone(_v4, _v2, HALF_ANGLE * 1.4).multiplyScalar(rand(4, 7));
          this._smoke.emit({
            pos: _v1, vel: _v4, life: rand(0.5, 0.9),
            size0: 0.3, size1: 1.1,
            color0: 0x1c130c, color1: 0x07090c,
            alpha0: 0.2, alpha1: 0, gravity: -1.5, drag: 1.6,
          });
        }
      },
      set: (v) => { on = !!v; },
      setLevel: () => {},
      dispose: () => { on = false; },
    });
  }

  /**
   * Schildblase: transparente, additiv pulsierende Kugel am parentObj.
   * Laeuft nach durationS aus (Fade); setLevel(x) loest Treffer-Flackern aus.
   */
  shieldBubble(parentObj, radius, colorHex, durationS) {
    if (!parentObj) return this._makeHandle({});
    const r = Math.max(0.3, radius || 1.2);
    const col = colorHex != null ? colorHex : 0x6fd3e8;
    const dur = Math.max(0.1, durationS || 4);
    const inv = this._inverseWorldScale(parentObj);

    const group = new THREE.Group();
    const matOut = new THREE.MeshBasicMaterial({
      color: col, blending: THREE.AdditiveBlending, transparent: true,
      opacity: 0.14, depthWrite: false, side: THREE.FrontSide,
    });
    const matIn = matOut.clone();
    matIn.opacity = 0.08;
    matIn.side = THREE.BackSide;
    const outer = new THREE.Mesh(this._sphereGeo, matOut);
    const innerShell = new THREE.Mesh(this._sphereGeo, matIn);
    innerShell.scale.setScalar(0.97);
    outer.renderOrder = 92;
    innerShell.renderOrder = 91;
    group.add(outer, innerShell);
    group.position.y = r * 0.9 * inv;
    group.scale.setScalar(r * inv);
    parentObj.add(group);

    let t = 0;
    let flicker = 0;
    let visible = true;
    const handle = this._makeHandle({
      update: (dt) => {
        t += dt;
        flicker = Math.max(0, flicker - dt * 5);
        const pulse = 1 + Math.sin(t * 6) * 0.025;
        group.scale.setScalar(r * inv * pulse);
        const fade = t > dur - 0.4 ? Math.max(0, (dur - t) / 0.4) : 1;
        matOut.opacity = (0.14 + flicker * 0.35) * fade;
        matIn.opacity = (0.08 + flicker * 0.2) * fade;
        group.visible = visible && fade > 0;
        if (t >= dur) handle.dispose();
      },
      set: (v) => { visible = !!v; group.visible = visible; },
      setLevel: (x) => { flicker = Math.max(flicker, THREE.MathUtils.clamp(x != null ? x : 1, 0, 1)); },
      dispose: () => {
        if (group.parent) group.parent.remove(group);
        matOut.dispose();
        matIn.dispose();
      },
    });
    return handle;
  }

  /** Charge-Orb (Feuerball aufladen): Glow-Sprite + Kern, setLevel(0..1). */
  chargeOrb(parentObj, colorHex) {
    if (!parentObj) return this._makeHandle({});
    const col = colorHex != null ? colorHex : 0xff7a22;
    const group = new THREE.Group();
    const spriteMat = new THREE.SpriteMaterial({
      map: this._glowTex, color: col, blending: THREE.AdditiveBlending,
      transparent: true, opacity: 0.9, depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true,
      opacity: 0.9, depthWrite: false,
    });
    const core = new THREE.Mesh(this._sphereGeo, coreMat);
    core.scale.setScalar(0.35);
    group.add(sprite, core);
    group.visible = false;
    parentObj.add(group);

    let level = 0;
    let t = 0;
    let on = true;
    return this._makeHandle({
      update: (dt) => {
        t += dt;
        const show = on && level > 0.01;
        group.visible = show;
        if (!show) return;
        const pulse = 1 + Math.sin(t * 14) * 0.08 * level;
        const s = (0.08 + level * 0.42) * pulse;
        group.scale.setScalar(s);
        spriteMat.opacity = 0.5 + level * 0.5;
        // Einlaufende Funken bei hoher Ladung
        if (level > 0.25 && Math.random() < level * 0.5) {
          group.getWorldPosition(_v1);
          randUnit(_v2).multiplyScalar(rand(0.4, 0.7));
          _v3.copy(_v1).add(_v2);
          _v2.multiplyScalar(-rand(2.5, 4));
          this._additive.emit({
            pos: _v3, vel: _v2, life: 0.18,
            size0: 0.07, size1: 0.01,
            color0: col, color1: 0xffffff,
            alpha0: 0.9, alpha1: 0,
          });
        }
      },
      set: (v) => { on = !!v; },
      setLevel: (x) => { level = THREE.MathUtils.clamp(x != null ? x : 0, 0, 1); },
      dispose: () => {
        if (group.parent) group.parent.remove(group);
        spriteMat.dispose();
        coreMat.dispose();
      },
    });
  }

  /** Fackelflamme + Glut: persistenter Dauer-Emitter an fester Position. */
  torchFlame(pos) {
    if (!pos) return this._makeHandle({ persistent: true });
    const base = new THREE.Vector3().copy(pos);
    let on = true;
    let accum = 0;
    return this._makeHandle({
      persistent: true,
      update: (dt) => {
        if (!on) return;
        accum += dt * 15;
        if (accum < 1) return;
        const count = Math.min(4, Math.floor(accum));
        accum -= count;
        for (let i = 0; i < count; i++) {
          _v1.set(base.x + rand(-0.05, 0.05), base.y + rand(-0.02, 0.04), base.z + rand(-0.05, 0.05));
          _v2.set(rand(-0.15, 0.15), rand(0.7, 1.1), rand(-0.15, 0.15));
          this._additive.emit({
            pos: _v1, vel: _v2, life: rand(0.35, 0.55),
            size0: rand(0.16, 0.24), size1: 0.04,
            color0: 0xff8c2a, color1: 0xffd47a,
            alpha0: 0.8, alpha1: 0, drag: 0.8,
          });
        }
        // Gelegentliche aufsteigende Glut
        if (Math.random() < 0.12) {
          _v1.set(base.x, base.y + 0.05, base.z);
          _v2.set(rand(-0.4, 0.4), rand(0.5, 1.0), rand(-0.4, 0.4));
          this._additive.emit({
            pos: _v1, vel: _v2, life: rand(1.0, 1.8),
            size0: 0.05, size1: 0.015,
            color0: 0xffb050, color1: 0xff3a08,
            alpha0: 0.9, alpha1: 0, drag: 0.6, gravity: -0.4,
          });
        }
      },
      set: (v) => { on = !!v; },
      setLevel: () => {},
      dispose: () => { on = false; },
    });
  }

  /**
   * Ambient-Staub/Glut in der Arena. bounds: THREE.Box3 oder
   * {min:[x,y,z]|Vector3, max:[x,y,z]|Vector3}. Persistenter Emitter.
   */
  ambient(bounds) {
    const min = new THREE.Vector3(-20, 0, -20);
    const max = new THREE.Vector3(20, 8, 20);
    if (bounds) {
      const bMin = bounds.min, bMax = bounds.max;
      if (bMin && bMax) {
        if (bMin.isVector3) min.copy(bMin); else if (Array.isArray(bMin)) min.fromArray(bMin);
        if (bMax.isVector3) max.copy(bMax); else if (Array.isArray(bMax)) max.fromArray(bMax);
      }
    }
    let on = true;
    let accum = 0;
    const RATE = 9; // haelt ~70 Partikel bei ~8 s Lebenszeit
    return this._makeHandle({
      persistent: true,
      update: (dt) => {
        if (!on) return;
        accum += dt * RATE;
        if (accum < 1) return;
        const count = Math.min(3, Math.floor(accum));
        accum -= count;
        for (let i = 0; i < count; i++) {
          _v1.set(rand(min.x, max.x), rand(min.y, max.y), rand(min.z, max.z));
          const ember = Math.random() < 0.18;
          _v2.set(rand(-0.15, 0.15), ember ? rand(0.1, 0.35) : rand(-0.06, 0.1), rand(-0.15, 0.15));
          this._additive.emit({
            pos: _v1, vel: _v2, life: rand(5, 10),
            size0: ember ? 0.05 : rand(0.025, 0.05),
            size1: ember ? 0.015 : 0.02,
            color0: ember ? 0xff9a40 : 0x8a93a8,
            color1: ember ? 0xff3a08 : 0x596070,
            alpha0: ember ? 0.6 : 0.16, alpha1: 0,
          });
        }
      },
      set: (v) => { on = !!v; },
      setLevel: () => {},
      dispose: () => { on = false; },
    });
  }
}
