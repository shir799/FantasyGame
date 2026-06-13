/**
 * AbilitySystem — lokale Cooldown-, Charge- und Atem-Verwaltung einer Klasse.
 * Cooldowns als absolute Zeitstempel (performance.now()/1000); reiner Zustand
 * ohne Netz-/Render-Abhaengigkeiten. CombatSystem fragt ab und triggert.
 */

const SLOTS = ['primary', 'secondary', 'skill1', 'skill2', 'ultimate'];

// Aktuelle Zeit in Sekunden (monoton)
function nowS() {
  return performance.now() / 1000;
}

export class AbilitySystem {
  constructor(classDef) {
    this.def = classDef || null;
    this.abilities = (classDef && classDef.abilities) || {};
    this.readyAt = {}; // slot → Zeitstempel (s), ab dem wieder bereit

    // Charge- (Feuerball) und Atem-Slot (Feueratem) aus den Kinds ableiten
    this.chargeSlot = null;
    this.breathSlot = null;
    for (const s of SLOTS) {
      const a = this.abilities[s];
      if (!a) continue;
      if (a.kind === 'charged_projectile') this.chargeSlot = s;
      if (a.kind === 'breath') this.breathSlot = s;
    }

    this._charging = false;
    this._chargeStart = 0;
    this._breath = 1;             // Atem-Meter 0..1
    this._breathActive = false;   // gerade am Atmen
    this._drainedThisFrame = false;
    this.resetForRound();
  }

  // Cooldown-Dauer eines Slots (0 = kein Cooldown, z.B. Block)
  _cooldownOf(slot) {
    const a = this.abilities[slot];
    return (a && a.cooldown) ? a.cooldown : 0;
  }

  isReady(slot) {
    if (!this.abilities[slot]) return false;
    if (slot === this.breathSlot && this._breath <= 0) return false;
    return nowS() >= (this.readyAt[slot] || 0);
  }

  remaining(slot) {
    return Math.max(0, (this.readyAt[slot] || 0) - nowS());
  }

  // 0 = bereit … 1 = voll auf Cooldown
  fraction(slot) {
    const cd = this._cooldownOf(slot);
    if (cd <= 0) return 0;
    return Math.min(1, this.remaining(slot) / cd);
  }

  trigger(slot) {
    const cd = this._cooldownOf(slot);
    if (cd > 0) this.readyAt[slot] = nowS() + cd;
  }

  // Rundenstart: alles bereit, Ultimate auf vollen Cooldown, Atem-Meter voll
  resetForRound() {
    const t = nowS();
    for (const s of SLOTS) this.readyAt[s] = 0;
    const ult = this.abilities.ultimate;
    if (ult && ult.cooldown) this.readyAt.ultimate = t + ult.cooldown;
    this._breath = 1;
    this._breathActive = false;
    this._drainedThisFrame = false;
    this._charging = false;
  }

  // --- Charge (Feuerball) ---

  beginCharge() {
    if (!this.chargeSlot) return;
    this._charging = true;
    this._chargeStart = nowS();
  }

  get charge01() {
    if (!this._charging || !this.chargeSlot) return 0;
    const max = this.abilities[this.chargeSlot].chargeMax || 1;
    return Math.min(1, (nowS() - this._chargeStart) / max);
  }

  endCharge() {
    const c = this.charge01;
    this._charging = false;
    return c;
  }

  // --- Atem (Drache) ---

  get breathMeter01() {
    return this._breath;
  }

  // true solange das Meter noch nicht wieder fuellen darf (Cooldown laeuft)
  get refillLocked() {
    if (!this.breathSlot) return false;
    return nowS() < (this.readyAt[this.breathSlot] || 0);
  }

  // Pro Frame waehrend des Atmens aufrufen; false = keine Luft mehr / gesperrt
  drainBreath(dt) {
    if (!this.breathSlot || !(dt > 0)) return false;
    if (this._breath <= 0) return false;
    // Neustart waehrend laufendem Cooldown verhindern
    if (!this._breathActive && nowS() < (this.readyAt[this.breathSlot] || 0)) return false;
    this._breathActive = true;
    this._drainedThisFrame = true;
    const dur = this.abilities[this.breathSlot].duration || 1;
    this._breath = Math.max(0, this._breath - dt / dur);
    if (this._breath <= 0) {
      this._endBreath();
      return false;
    }
    return true;
  }

  // Atem beendet (losgelassen oder leer) → Cooldown beginnt JETZT
  _endBreath() {
    if (!this._breathActive) return;
    this._breathActive = false;
    this._drainedThisFrame = false;
    const a = this.abilities[this.breathSlot];
    if (a && a.cooldown) this.readyAt[this.breathSlot] = nowS() + a.cooldown;
  }

  update(dt) {
    // Atem-Ende erkennen: war aktiv, wurde dieses Frame aber nicht gezogen
    if (this._breathActive && !this._drainedThisFrame) this._endBreath();
    this._drainedThisFrame = false;
    // Refill erst nach abgelaufenem Cooldown (dann wieder volles Meter)
    if (this.breathSlot && !this._breathActive && this._breath < 1 && !this.refillLocked) {
      this._breath = 1;
    }
  }
}
