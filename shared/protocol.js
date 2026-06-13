/**
 * protocol.js — Nachrichtentypen, Phasen und Netz-Konstanten für ASCHENTHRON.
 * Wird von Server, Client und Bot geteilt; bewusst ohne three- und DOM-Bezug.
 * Wire-Format: JSON-Objekte der Form { type, ...payload }.
 * Alle endsAt/now-Felder sind Server-Millisekunden; endsAt 0 = Phase ohne Timer.
 */

export const PORT = 8080;
export const STATE_HZ = 30;            // Senderate Spielerzustand
export const INTERP_DELAY_MS = 120;    // Interpolationspuffer Remote-Spieler

export const PHASE = {
  LOBBY: 'lobby',                // < 2 Spieler verbunden (oder Solo-Wartezustand)
  CLASS_SELECT: 'class_select',
  COUNTDOWN: 'countdown',
  FIGHTING: 'fighting',
  ROUND_END: 'round_end',
  MATCH_END: 'match_end',
};

export const MSG = {
  // Client → Server
  C_HELLO: 'c_hello',        // {name}
  C_SELECT: 'c_select',      // {classId}
  C_READY: 'c_ready',        // {ready}
  C_STATE: 'c_state',        // {p:[x,y,z], ry, pitch, anim:{moving,sprinting,grounded,blocking,breath,charging}}
  C_ATTACK: 'c_attack',      // {slot, origin:[x,y,z], dir:[x,y,z], charge}  – Cast-Event (VFX/Anim-Relay + CD-Buchung)
  C_HIT: 'c_hit',            // {slot, targetId, point:[x,y,z], charge}      – Treffer-Claim (Melee/Direktprojektil)
  C_BREATH: 'c_breath',      // {targetId, point:[x,y,z]}                    – Feueratem-Tick (nur bei Treffer senden)
  C_AOE: 'c_aoe',            // {slot, center:[x,y,z]}                       – Flächenschaden auflösen
  C_REMATCH: 'c_rematch',    // {}
  C_SOLO: 'c_solo',          // {}  Training mit Dummy starten (nur allein)
  C_LEAVE_SOLO: 'c_leave_solo', // {}

  // Server → Client
  S_WELCOME: 's_welcome',    // {id, lanIp, port, now}
  S_ROSTER: 's_roster',      // {players:[{id,name,classId,ready}]}
  S_PHASE: 's_phase',        // {phase, endsAt, round, scores:{id:n}, now}
  S_STATE: 's_state',        // {id, p, ry, pitch, anim}  (Relay des Gegners)
  S_ATTACK: 's_attack',      // {id, slot, origin, dir, charge} (Relay, nicht an Absender)
  S_DAMAGE: 's_damage',      // {targetId, attackerId, amount, hp, shield, point, knockback:[x,y,z], slot, blocked}
  S_DEATH: 's_death',        // {targetId, attackerId}
  S_SHIELD: 's_shield',      // {id, amount, duration}    (Magierin-Schild aktiv)
  S_RESET: 's_reset',        // {spawns:{id:{p:[x,y,z], ry}}, hp:{id:n}, dummy:{p:[x,y,z], hp}|null}
  S_ROUND_END: 's_round_end',// {winnerId|null, scores, round}   (null = Unentschieden)
  S_MATCH_END: 's_match_end',// {winnerId, scores}
  S_EVENT: 's_event',        // {kind, ...}  kind: 'dummy_respawn'|'announce' {text}
  S_LEFT: 's_left',          // {id}
  S_FULL: 's_full',          // {}  Server voll (max 2)
  S_ERROR: 's_error',        // {msg}
};
