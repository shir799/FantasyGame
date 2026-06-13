/**
 * ArenaManager.js — Registry verfügbarer Arenen, erweiterbar für künftige Maps
 * (Drachenhöhle, Waldtempel, Bergfestung, Kathedrale, Kristallhöhle …).
 * buildArena(game, key) baut die gewählte Arena und liefert das Arena-Objekt
 * { key, name, spawns, center, update(dt), dispose() }.
 */
import { buildRuinenburg } from './Arena.js';

// Neue Arenen hier eintragen: { name, build(game) → ArenaObjekt }.
export const ARENAS = {
  ruinenburg: { name: 'Ruinenburg', build: buildRuinenburg },
  // dragonlair:  { name: 'Drachenhöhle', build: buildDragonLair },
  // foresttemple:{ name: 'Waldtempel',   build: buildForestTemple },
};

/** Baut die Arena zum Schlüssel (Fallback: erste registrierte Arena). */
export function buildArena(game, key = 'ruinenburg') {
  const entry = ARENAS[key] || ARENAS.ruinenburg;
  return entry.build(game);
}

/** Liste der verfügbaren Arena-Schlüssel (für spätere Auswahl-UI). */
export function arenaKeys() {
  return Object.keys(ARENAS);
}
