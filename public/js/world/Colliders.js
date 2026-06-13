/**
 * Colliders — statische Kollisionswelt der Arena.
 * AABB- und Zylinder-Primitive; Kapsel-Aufloesung (XZ-Pushout gegen expandierte
 * Volumen, Boden-Snap mit Step-up, Decken-Clamp), Raycast (Slab-Methode fuer
 * Boxen, Mantel+Deckel fuer Zylinder) und Bodensuche fuer Spieler/Projektile.
 */
import * as THREE from 'three';

const EPS = 1e-6;
const SKIN = 0.001;       // Mini-Abstand nach Pushout gegen Zitter-Kontakte
const GROUND_PAD = 0.03;  // XZ-Toleranz der Bodensuche (Naehte zwischen Stufen)

export class Colliders {
  constructor() {
    /** @type {Array<{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number}>} */
    this.boxes = [];
    /** @type {Array<{x:number,z:number,r:number,y0:number,y1:number}>} */
    this.cylinders = [];
  }

  /** Achsen-parallele Box registrieren (min/max als Vector3-artige Objekte). */
  addBox(minV3, maxV3) {
    this.boxes.push({
      minX: Math.min(minV3.x, maxV3.x), maxX: Math.max(minV3.x, maxV3.x),
      minY: Math.min(minV3.y, maxV3.y), maxY: Math.max(minV3.y, maxV3.y),
      minZ: Math.min(minV3.z, maxV3.z), maxZ: Math.max(minV3.z, maxV3.z),
    });
  }

  /** Vertikalen Zylinder registrieren (y0 = Unterkante, y1 = Oberkante). */
  addCylinder(x, z, r, y0, y1) {
    this.cylinders.push({
      x, z, r: Math.abs(r),
      y0: Math.min(y0, y1), y1: Math.max(y0, y1),
    });
  }

  /** Alle Primitive entfernen (Arena-Neuaufbau). */
  clear() {
    this.boxes.length = 0;
    this.cylinders.length = 0;
  }

  /**
   * Spieler-Kapsel aufloesen. pos (Fusspunkt) und velocity werden mutiert.
   * Mehrere Pushout-Iterationen stabilisieren Ecken/Mehrfachkontakte,
   * danach Boden-Snap (hoechste Flaeche bis stepUp ueber dem Fusspunkt).
   * @returns {{grounded:boolean}}
   */
  resolveCapsule(pos, radius, height, velocity, stepUp = 0.4) {
    for (let iter = 0; iter < 3; iter++) {
      this._pushOutXZ(pos, radius, height, velocity, stepUp);
    }
    const ground = this._groundSearch(pos.x, pos.z, pos.y, stepUp);
    let grounded = false;
    // Snap nur ohne Aufwaertsbewegung: Sprung bleibt unbeeinflusst.
    if (velocity.y <= 0.001 && pos.y <= ground + 0.001) {
      pos.y = ground;
      velocity.y = 0;
      grounded = true;
    }
    return { grounded };
  }

  /** Ein Pushout-Durchlauf: Waende horizontal, Decken vertikal klemmen. */
  _pushOutXZ(pos, radius, height, velocity, stepUp) {
    const head = () => pos.y + height;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.maxY <= pos.y + stepUp) continue;  // begehbare Stufe → Bodensuche
      if (b.minY >= head()) continue;          // komplett ueber dem Kopf
      const minX = b.minX - radius, maxX = b.maxX + radius;
      const minZ = b.minZ - radius, maxZ = b.maxZ + radius;
      if (pos.x <= minX || pos.x >= maxX || pos.z <= minZ || pos.z >= maxZ) continue;

      const pushPosX = maxX - pos.x, pushNegX = pos.x - minX;
      const pushPosZ = maxZ - pos.z, pushNegZ = pos.z - minZ;
      const px = Math.min(pushPosX, pushNegX);
      const pz = Math.min(pushPosZ, pushNegZ);
      const dyDown = head() - b.minY;

      // Decke: Box beginnt deutlich ueber dem Fusspunkt und der kuerzeste
      // Ausweg ist nach unten → Kopf unter die Unterkante klemmen.
      if (b.minY > pos.y + stepUp && dyDown < Math.min(px, pz)) {
        pos.y = b.minY - height - SKIN;
        if (velocity.y > 0) velocity.y = 0;
        continue;
      }

      // Horizontal entlang der flachsten Achse herausschieben,
      // Geschwindigkeit in die Wand entfernen (sauberes Gleiten).
      if (px < pz) {
        if (pushPosX < pushNegX) {
          pos.x = maxX + SKIN;
          if (velocity.x < 0) velocity.x = 0;
        } else {
          pos.x = minX - SKIN;
          if (velocity.x > 0) velocity.x = 0;
        }
      } else {
        if (pushPosZ < pushNegZ) {
          pos.z = maxZ + SKIN;
          if (velocity.z < 0) velocity.z = 0;
        } else {
          pos.z = minZ - SKIN;
          if (velocity.z > 0) velocity.z = 0;
        }
      }
    }

    for (let i = 0; i < this.cylinders.length; i++) {
      const c = this.cylinders[i];
      if (c.y1 <= pos.y + stepUp) continue;
      if (c.y0 >= head()) continue;
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const rr = c.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;

      const d = Math.sqrt(d2);
      const pen = rr - d;
      const dyDown = head() - c.y0;
      if (c.y0 > pos.y + stepUp && dyDown < pen) {
        pos.y = c.y0 - height - SKIN;
        if (velocity.y > 0) velocity.y = 0;
        continue;
      }

      let nx = 1, nz = 0;
      if (d > EPS) { nx = dx / d; nz = dz / d; }
      pos.x += nx * (pen + SKIN);
      pos.z += nz * (pen + SKIN);
      const vn = velocity.x * nx + velocity.z * nz;
      if (vn < 0) {
        velocity.x -= vn * nx;
        velocity.z -= vn * nz;
      }
    }
  }

  /**
   * Hoechste begehbare Oberflaeche unter (x,z), maximal stepUp ueber fromY.
   * Faellt defensiv auf 0 (Arenaboden) zurueck — niemand faellt ins Nichts.
   */
  groundHeight(x, z, fromY) {
    return this._groundSearch(x, z, fromY, 0.4);
  }

  _groundSearch(x, z, fromY, stepUp) {
    let best = 0;
    const limit = fromY + stepUp + EPS;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const top = b.maxY;
      if (top <= best || top > limit) continue;
      if (x < b.minX - GROUND_PAD || x > b.maxX + GROUND_PAD) continue;
      if (z < b.minZ - GROUND_PAD || z > b.maxZ + GROUND_PAD) continue;
      best = top;
    }
    for (let i = 0; i < this.cylinders.length; i++) {
      const c = this.cylinders[i];
      const top = c.y1;
      if (top <= best || top > limit) continue;
      const dx = x - c.x, dz = z - c.z;
      const r = c.r + GROUND_PAD;
      if (dx * dx + dz * dz > r * r) continue;
      best = top;
    }
    return best;
  }

  /**
   * Strahl gegen alle Primitive. Richtung wird intern normalisiert.
   * @returns {{hit:boolean, point:THREE.Vector3|null, normal:THREE.Vector3|null, dist:number}}
   */
  raycast(originV3, dirV3, maxDist) {
    const o = originV3;
    const len = Math.hypot(dirV3.x, dirV3.y, dirV3.z);
    if (len < EPS || !(maxDist > 0)) {
      return { hit: false, point: null, normal: null, dist: Infinity };
    }
    const dx = dirV3.x / len, dy = dirV3.y / len, dz = dirV3.z / len;
    let bestT = Infinity;
    let nX = 0, nY = 0, nZ = 0;

    // Boxen: Slab-Methode pro Achse, Normale aus der Eintrittsachse.
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      let tMin = 0, tMax = maxDist;
      let axis = -1, sign = 0;

      // X-Slab
      if (Math.abs(dx) < EPS) {
        if (o.x < b.minX || o.x > b.maxX) continue;
      } else {
        const inv = 1 / dx;
        let t1 = (b.minX - o.x) * inv, t2 = (b.maxX - o.x) * inv;
        let s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tMin) { tMin = t1; axis = 0; sign = s; }
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) continue;
      }
      // Y-Slab
      if (Math.abs(dy) < EPS) {
        if (o.y < b.minY || o.y > b.maxY) continue;
      } else {
        const inv = 1 / dy;
        let t1 = (b.minY - o.y) * inv, t2 = (b.maxY - o.y) * inv;
        let s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tMin) { tMin = t1; axis = 1; sign = s; }
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) continue;
      }
      // Z-Slab
      if (Math.abs(dz) < EPS) {
        if (o.z < b.minZ || o.z > b.maxZ) continue;
      } else {
        const inv = 1 / dz;
        let t1 = (b.minZ - o.z) * inv, t2 = (b.maxZ - o.z) * inv;
        let s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tMin) { tMin = t1; axis = 2; sign = s; }
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) continue;
      }
      // Start innerhalb der Box (axis -1) zaehlt nicht als Treffer.
      if (axis < 0 || tMin <= 0 || tMin >= bestT) continue;
      bestT = tMin;
      nX = axis === 0 ? sign : 0;
      nY = axis === 1 ? sign : 0;
      nZ = axis === 2 ? sign : 0;
    }

    // Zylinder: Mantel (Quadratik in XZ) + Deckel/Boden-Scheiben.
    for (let i = 0; i < this.cylinders.length; i++) {
      const c = this.cylinders[i];
      const ox = o.x - c.x, oz = o.z - c.z;

      // Mantel
      const a = dx * dx + dz * dz;
      if (a > EPS) {
        const bq = 2 * (ox * dx + oz * dz);
        const cq = ox * ox + oz * oz - c.r * c.r;
        const disc = bq * bq - 4 * a * cq;
        if (disc >= 0) {
          const t = (-bq - Math.sqrt(disc)) / (2 * a);
          if (t > 0 && t <= maxDist && t < bestT) {
            const hy = o.y + dy * t;
            if (hy >= c.y0 && hy <= c.y1) {
              bestT = t;
              const hx = ox + dx * t, hz = oz + dz * t;
              const hl = Math.hypot(hx, hz) || 1;
              nX = hx / hl; nY = 0; nZ = hz / hl;
            }
          }
        }
      }
      // Deckel (oben) und Boden (unten)
      if (Math.abs(dy) > EPS) {
        for (let cap = 0; cap < 2; cap++) {
          const py = cap === 0 ? c.y1 : c.y0;
          const t = (py - o.y) / dy;
          if (t <= 0 || t > maxDist || t >= bestT) continue;
          const hx = ox + dx * t, hz = oz + dz * t;
          if (hx * hx + hz * hz > c.r * c.r) continue;
          // Nur von aussen treffen (Strahl laeuft gegen die Flaeche).
          const ny = cap === 0 ? 1 : -1;
          if (dy * ny >= 0) continue;
          bestT = t;
          nX = 0; nY = ny; nZ = 0;
        }
      }
    }

    if (bestT === Infinity || bestT > maxDist) {
      return { hit: false, point: null, normal: null, dist: Infinity };
    }
    return {
      hit: true,
      point: new THREE.Vector3(o.x + dx * bestT, o.y + dy * bestT, o.z + dz * bestT),
      normal: new THREE.Vector3(nX, nY, nZ),
      dist: bestT,
    };
  }
}
