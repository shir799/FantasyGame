/**
 * classes.js — Klassen-/Fähigkeitsdaten und komplettes Balancing für ASCHENTHRON.
 * Reine Daten + Zugriffshelfer; läuft in Browser UND Node (kein three, kein DOM).
 * Zusatzfelder über die Vertrags-Feldliste hinaus: radiusMin (Feuerball),
 * shieldHp (Arkanschild), dmgMultFront/dmgMultElse/frontArcDeg/speedMult
 * (Schildblock) und impulseUp/impulseForward (Schwingenstoß).
 */

export const SLOT = { PRIMARY: 'primary', SECONDARY: 'secondary', SKILL1: 'skill1', SKILL2: 'skill2', ULTIMATE: 'ultimate' };
export const SLOT_ORDER = [SLOT.PRIMARY, SLOT.SECONDARY, SLOT.SKILL1, SLOT.SKILL2, SLOT.ULTIMATE];
export const SLOT_KEYS = { primary: 'LMB', secondary: 'RMB', skill1: 'Q', skill2: 'E', ultimate: 'R' };

export const MATCH = {
  ROUNDS_TO_WIN: 2,
  ROUND_SECONDS: 90,
  COUNTDOWN_SECONDS: 4,
  ROUND_END_SECONDS: 4,
  KILL_Y: -15,
  DUMMY_HP: 200,
  DUMMY_RESPAWN_SECONDS: 2,
};

export const CLASS_IDS = ['mage', 'knight', 'dragon'];

export const CLASSES = {
  mage: {
    id: 'mage',
    name: 'Magierin',
    role: 'Arkane Artillerie',
    tagline: 'Zerbrechlich wie Glas, tödlich wie der Sturm.',
    desc: 'Eine Verbannte des Aschenordens, die rohe Arkanmacht durch ihren Stab zwingt. '
      + 'Sie hält Gegner auf Distanz, entwischt durch den Schleier — und bestraft jeden '
      + 'Fehler mit einem berstenden Stern.',
    color: 0x66ccff,
    colorAccent: 0x9b5cff,
    colorEmissive: 0x4ddfff,
    maxHealth: 100,
    moveSpeed: 6.8,
    sprintMult: 1.35,
    jumpHeight: 1.25,
    radius: 0.4,
    height: 1.8,
    eyeHeight: 1.62,
    scale: 1.0,
    abilities: {
      primary: {
        name: 'Arkanblitz', key: 'LMB', kind: 'projectile',
        desc: 'Ein schneller Bolzen gebündelter Arkanmacht — wenig Schaden, gnadenloser Takt.',
        damage: 14, cooldown: 0.4, range: 60, radius: 0.3, speed: 40,
      },
      secondary: {
        name: 'Feuerball', key: 'RMB', kind: 'charged_projectile',
        desc: 'Gehaltenes Feuer wächst zur Sonne: je länger geladen, desto größer Sprengkraft und Radius.',
        damage: 50, minDamage: 18, cooldown: 2.2, range: 60,
        radius: 3.2, radiusMin: 1.2, speed: 28, chargeMax: 1.5,
      },
      skill1: {
        name: 'Blink', key: 'Q', kind: 'blink',
        desc: 'Reißt den Körper sieben Meter durch den Schleier — Mauern beenden den Sprung.',
        cooldown: 5, range: 7,
      },
      skill2: {
        name: 'Arkanschild', key: 'E', kind: 'shield',
        desc: 'Eine Sphäre aus gebundenem Licht schluckt Schaden, bis sie birst.',
        cooldown: 11, duration: 4, shieldHp: 45,
      },
      ultimate: {
        name: 'Arkan-Nova', key: 'R', kind: 'aoe_target',
        desc: 'Beschwört einen berstenden Stern auf den Zielpunkt — wer im Ring verweilt, vergeht.',
        damage: 75, minDamage: 35, cooldown: 30, range: 24, radius: 5.5,
        knockback: 10, windup: 0.8,
      },
    },
    stats: { offense: 0.8, defense: 0.35, speed: 0.9, range: 1.0 },
  },

  knight: {
    id: 'knight',
    name: 'Ritter',
    role: 'Bollwerk aus Stahl',
    tagline: 'Der letzte Eid steht — und er weicht keinen Schritt.',
    desc: 'Der letzte Schwurritter des gefallenen Throns: geduldig, gepanzert, unbarmherzig. '
      + 'Er fängt Stürme mit dem Schild, rückt unaufhaltsam vor und beendet Duelle mit '
      + 'einem einzigen Riss in der Erde.',
    color: 0xc98a3d,
    colorAccent: 0x8a93a6,
    colorEmissive: 0xffc46b,
    maxHealth: 140,
    moveSpeed: 5.8,
    sprintMult: 1.3,
    jumpHeight: 1.1,
    radius: 0.42,
    height: 1.85,
    eyeHeight: 1.66,
    scale: 1.05,
    abilities: {
      primary: {
        name: 'Schwerthieb', key: 'LMB', kind: 'melee',
        desc: 'Ein sauberer Bogen der Schwurklinge — schnell, verlässlich, hungrig.',
        damage: 18, cooldown: 0.5, range: 2.8, arcDeg: 70,
      },
      secondary: {
        name: 'Schwerer Hieb', key: 'RMB', kind: 'melee',
        desc: 'Kurz ausgeholt, mit ganzem Gewicht geführt — wirft den Getroffenen zurück.',
        damage: 34, cooldown: 1.7, range: 3.0, arcDeg: 50, knockback: 6, windup: 0.35,
      },
      skill1: {
        name: 'Schildblock', key: 'Q', kind: 'block',
        desc: 'Hinter dem Wappenschild verebben frontale Treffer zu einem dumpfen Pochen. (Halten)',
        cooldown: 0, dmgMultFront: 0.25, dmgMultElse: 0.85, frontArcDeg: 60, speedMult: 0.55,
      },
      skill2: {
        name: 'Sturmangriff', key: 'E', kind: 'dash',
        desc: 'Neun Meter gepanzerter Zorn — wer sich stellt, wird beiseitegerammt.',
        damage: 24, cooldown: 7, range: 9, duration: 0.35, knockback: 9,
      },
      ultimate: {
        name: 'Erdspalter', key: 'R', kind: 'aoe_self',
        desc: 'Die Klinge fährt in den Grund — die Erde birst ringsum und schleudert Feinde empor.',
        damage: 65, minDamage: 25, cooldown: 28, radius: 6.5, knockback: 8,
      },
    },
    stats: { offense: 0.65, defense: 0.95, speed: 0.55, range: 0.25 },
  },

  dragon: {
    id: 'dragon',
    name: 'Drache',
    role: 'Lebende Belagerung',
    tagline: 'Aus Asche geboren, in Zorn gegossen.',
    desc: 'Ein uralter Wyrm, in die Arena gezwungen: langsam, gewaltig, kaum zu fällen. '
      + 'Sein Atem schmilzt Stein, sein Schwanz fegt Reihen — und sein Inferno lässt '
      + 'nur Schatten im Boden zurück.',
    color: 0xa2293a,
    colorAccent: 0x3a2326,
    colorEmissive: 0xff5a1f,
    maxHealth: 180,
    moveSpeed: 5.2,
    sprintMult: 1.25,
    jumpHeight: 1.0,
    radius: 0.55,
    height: 2.2,
    eyeHeight: 1.95,
    scale: 1.4,
    abilities: {
      primary: {
        name: 'Klauenhieb', key: 'LMB', kind: 'melee',
        desc: 'Ein Prankenschlag in weitem Bogen — Knochen geben nach, Schilde splittern.',
        damage: 17, cooldown: 0.55, range: 3.2, arcDeg: 90,
      },
      secondary: {
        name: 'Feueratem', key: 'RMB', kind: 'breath',
        desc: 'Ein Strom flüssigen Feuers, solange der Atem reicht. (Halten)',
        damage: 8, tick: 0.25, cooldown: 6, range: 7.5, arcDeg: 35, duration: 3,
      },
      skill1: {
        name: 'Schwingenstoß', key: 'Q', kind: 'leap',
        desc: 'Ein einziger Schlag der Schwingen wirft den Koloss hoch und über das Feld.',
        cooldown: 8, impulseUp: 7, impulseForward: 9,
      },
      skill2: {
        name: 'Schwanzfeger', key: 'E', kind: 'aoe_self',
        desc: 'Der Schwanz fegt im Kreis und reißt alles Nahe von den Füßen.',
        damage: 14, cooldown: 9, radius: 4.2, knockback: 12,
      },
      ultimate: {
        name: 'Infernoschlag', key: 'R', kind: 'aoe_self',
        desc: 'Der Wyrm bäumt sich auf, die Luft gerinnt — dann fällt der Himmel als Feuer.',
        damage: 85, minDamage: 35, cooldown: 34, radius: 8.5, knockback: 14, windup: 0.6,
      },
    },
    stats: { offense: 1.0, defense: 0.7, speed: 0.45, range: 0.5 },
  },
};

/** Liefert die Klassendefinition zu einer id oder null. */
export function getClass(id) {
  return CLASSES[id] || null;
}
