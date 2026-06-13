/**
 * MeleeHitbox — pure Treffergeometrie fuer Nahkampf und Projektile.
 * Kapsel = {p:Vector3 (Fusspunkt), radius, height}; Achse als Segment von
 * p+(0,r,0) bis p+(0,height-r,0). Kegel-, Kugel- und Segment-Tests,
 * allokationsarm (Modul-Temporaries, neue Vector3 nur fuer Treffpunkte).
 */
import * as THREE from 'three';

const DEG2RAD = Math.PI / 180;
const EPS = 1e-9;

// Gemeinsame Miss-Ergebnisse (eingefroren, keine Allokation pro Aufruf)
const MISS = Object.freeze({ hit: false, point: null });
const MISS_SEG = Object.freeze({ hit: false, point: null, t: 0 });

// Wiederverwendbare Temporaries fuer den Hot Path
const _axisA = new THREE.Vector3();
const _axisB = new THREE.Vector3();
const _close = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _dirN = new THREE.Vector3();
const _toHit = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _r = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();

// Prueft, ob das Kapsel-Objekt brauchbar ist (Modulgrenze, defensiv)
function validCapsule(capsule) {
  return !!(capsule && capsule.p && typeof capsule.p.x === 'number' &&
    typeof capsule.radius === 'number' && typeof capsule.height === 'number');
}

// Achsen-Endpunkte der Kapsel nach outA/outB schreiben (entartete Hoehe absichern)
function capsuleAxis(capsule, outA, outB) {
  const r = Math.max(0, capsule.radius);
  const h = Math.max(capsule.height, 2 * r);
  outA.set(capsule.p.x, capsule.p.y + r, capsule.p.z);
  outB.set(capsule.p.x, capsule.p.y + h - r, capsule.p.z);
}

// Naechster Punkt auf Segment a-b zu Punkt p → out (komponentenweise, keine Temps)
function closestOnSegment(p, a, b, out) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < EPS) return out.copy(a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / len2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return out.set(a.x + dx * t, a.y + dy * t, a.z + dz * t);
}

// Naechstes Punktpaar zweier Segmente (Ericson); schreibt _c1/_c2, liefert s auf Segment 1
function closestPtSegmentSegment(p1, q1, p2, q2) {
  _d1.subVectors(q1, p1);
  _d2.subVectors(q2, p2);
  _r.subVectors(p1, p2);
  const a = _d1.lengthSq();
  const e = _d2.lengthSq();
  const f = _d2.dot(_r);
  let s = 0, t = 0;
  if (a <= EPS && e <= EPS) {
    // Beide Segmente entartet zu Punkten
  } else if (a <= EPS) {
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = _d1.dot(_r);
    if (e <= EPS) {
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = _d1.dot(_d2);
      const denom = a * e - b * b;
      s = denom > EPS ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
      }
    }
  }
  _c1.copy(p1).addScaledVector(_d1, s);
  _c2.copy(p2).addScaledVector(_d2, t);
  return s;
}

/**
 * Naechster Punkt der (soliden) Kapsel zu pointV3.
 * Liegt der Punkt in der Kapsel, ist er selbst der naechste Punkt.
 */
export function capsuleClosestPoint(pointV3, capsule) {
  if (!pointV3) return new THREE.Vector3();
  if (!validCapsule(capsule)) return pointV3.clone();
  capsuleAxis(capsule, _axisA, _axisB);
  closestOnSegment(pointV3, _axisA, _axisB, _close);
  _delta.subVectors(pointV3, _close);
  const dist = _delta.length();
  if (dist <= capsule.radius + EPS) return pointV3.clone();
  return _close.clone().addScaledVector(_delta, capsule.radius / dist);
}

/**
 * Kegeltest fuer Nahkampf: Distanz Origin→Kapselachse ≤ range UND Winkel (3D)
 * zwischen dir und Richtung zum naechsten Kapselpunkt ≤ arcDeg/2.
 */
export function coneHit(originV3, dirV3, range, arcDeg, capsule) {
  if (!originV3 || !dirV3 || !(range > 0) || !validCapsule(capsule)) return MISS;
  capsuleAxis(capsule, _axisA, _axisB);
  closestOnSegment(originV3, _axisA, _axisB, _close);
  _delta.subVectors(_close, originV3);
  const distAxis = _delta.length();
  if (distAxis > range) return MISS;
  // Origin steckt in der Kapsel → immer Treffer, Punkt = Origin
  if (distAxis <= capsule.radius + EPS) return { hit: true, point: originV3.clone() };
  // Treffpunkt auf der Kapseloberflaeche Richtung Angreifer
  const point = _close.clone().addScaledVector(_delta, -capsule.radius / distAxis);
  _dirN.copy(dirV3);
  if (_dirN.lengthSq() < EPS) return MISS;
  _dirN.normalize();
  _toHit.subVectors(point, originV3).normalize();
  const cos = THREE.MathUtils.clamp(_dirN.dot(_toHit), -1, 1);
  if (Math.acos(cos) > (arcDeg * DEG2RAD) * 0.5) return MISS;
  return { hit: true, point };
}

/**
 * Kugel-gegen-Kapsel (AoE-Pruefung). Punkt = naechster Kapselpunkt zum Zentrum.
 */
export function sphereHit(centerV3, radius, capsule) {
  if (!centerV3 || !(radius >= 0) || !validCapsule(capsule)) return MISS;
  capsuleAxis(capsule, _axisA, _axisB);
  closestOnSegment(centerV3, _axisA, _axisB, _close);
  _delta.subVectors(_close, centerV3);
  const dist = _delta.length();
  if (dist > radius + capsule.radius) return MISS;
  if (dist <= capsule.radius + EPS) return { hit: true, point: centerV3.clone() };
  const point = _close.clone().addScaledVector(_delta, -capsule.radius / dist);
  return { hit: true, point };
}

/**
 * Segment (Flugstrecke, mit eigenem Radius) gegen Kapsel — fuer Projektil-Substeps.
 * t = Parameter (0..1) der dichtesten Annaeherung auf a→b, point = Punkt dort.
 */
export function segmentCapsuleHit(aV3, bV3, radius, capsule) {
  if (!aV3 || !bV3 || !validCapsule(capsule)) return MISS_SEG;
  capsuleAxis(capsule, _axisA, _axisB);
  const s = closestPtSegmentSegment(aV3, bV3, _axisA, _axisB);
  const dist = _c1.distanceTo(_c2);
  if (dist > Math.max(0, radius || 0) + capsule.radius) return MISS_SEG;
  return { hit: true, point: _c1.clone(), t: s };
}
