/**
 * HealthSystem — reiner Client-Spiegel der serverautoritativen HP/Schild-Werte.
 * Keine eigene Schadensrechnung: applyDamage/setShield uebernehmen Serverwerte,
 * resetFromRoster initialisiert aus dem Roster bzw. Dummy (MATCH.DUMMY_HP).
 */
import { getClass, MATCH } from '/shared/classes.js';

const FALLBACK_MAX_HP = 100;

export class HealthSystem {
  constructor(game) {
    this.game = game || null;
    this.entries = new Map(); // id → {hp, maxHp, shield}
  }

  // maxHp einer ID bestimmen: Dummy-Konstante, sonst Klassen-Definition aus Roster
  _maxHpFor(id) {
    if (id === 'dummy') return MATCH.DUMMY_HP;
    const roster = this.game && this.game.roster;
    const info = roster && typeof roster.get === 'function' ? roster.get(id) : null;
    const def = info && info.classId ? getClass(info.classId) : null;
    if (def && def.maxHealth) return def.maxHealth;
    // Fallback: lokale Klassen-Definition (vor erstem Roster-Sync)
    const local = this.game && this.game.local;
    if (this.game && this.game.myId === id && local && local.def && local.def.maxHealth) {
      return local.def.maxHealth;
    }
    return FALLBACK_MAX_HP;
  }

  // Eintrag holen, bei Bedarf voll geheilt anlegen
  _entry(id) {
    if (id == null) return null;
    let e = this.entries.get(id);
    if (!e) {
      const maxHp = this._maxHpFor(id);
      e = { hp: maxHp, maxHp, shield: 0 };
      this.entries.set(id, e);
    }
    return e;
  }

  // S_DAMAGE-Payload einarbeiten — hp/shield sind autoritative Resultatwerte
  applyDamage(msg) {
    if (!msg || msg.targetId == null) return;
    const e = this._entry(msg.targetId);
    if (!e) return;
    if (typeof msg.hp === 'number') e.hp = Math.max(0, msg.hp);
    if (typeof msg.shield === 'number') e.shield = Math.max(0, msg.shield);
  }

  // Rundenstart: alle Spieler aus dem Roster voll heilen, Dummy gesondert
  resetFromRoster() {
    this.entries.clear();
    const roster = this.game && this.game.roster;
    if (roster && typeof roster.forEach === 'function') {
      roster.forEach((info, id) => {
        const def = info && info.classId ? getClass(info.classId) : null;
        const maxHp = (def && def.maxHealth) || FALLBACK_MAX_HP;
        this.entries.set(id, { hp: maxHp, maxHp, shield: 0 });
      });
    }
    const remote = this.game && this.game.remote;
    if (remote && remote.id === 'dummy') {
      this.entries.set('dummy', { hp: MATCH.DUMMY_HP, maxHp: MATCH.DUMMY_HP, shield: 0 });
    }
  }

  // S_SHIELD: absoluten Schildwert setzen
  setShield(id, amount) {
    if (id == null) return;
    const e = this._entry(id);
    if (e) e.shield = Math.max(0, amount || 0);
  }

  mine() {
    const id = this.game ? this.game.myId : null;
    if (id != null) {
      const e = this._entry(id);
      return { hp: e.hp, maxHp: e.maxHp, shield: e.shield };
    }
    // Noch keine ID (vor Welcome): volle Anzeige aus lokaler Klasse
    const local = this.game && this.game.local;
    const maxHp = (local && local.def && local.def.maxHealth) || FALLBACK_MAX_HP;
    return { hp: maxHp, maxHp, shield: 0 };
  }

  theirs() {
    const remote = this.game ? this.game.remote : null;
    if (!remote || remote.id == null) return { hp: 0, maxHp: 1, shield: 0, id: null };
    const e = this._entry(remote.id);
    return { hp: e.hp, maxHp: e.maxHp, shield: e.shield, id: remote.id };
  }

  get myFrac() {
    const m = this.mine();
    return m.maxHp > 0 ? Math.min(1, Math.max(0, m.hp / m.maxHp)) : 0;
  }

  get theirFrac() {
    const t = this.theirs();
    return t.maxHp > 0 ? Math.min(1, Math.max(0, t.hp / t.maxHp)) : 0;
  }
}
