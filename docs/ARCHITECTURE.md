# ASCHENTHRON — Architektur & verbindliche Modul-Verträge

> **Dieses Dokument ist der VERTRAG.** Jedes Modul implementiert exakt die hier
> definierten öffentlichen Schnittstellen. Interne Helfer sind frei. Wer eine
> Schnittstelle eines anderen Moduls nutzt, nutzt sie EXAKT wie hier definiert —
> keine erfundenen Methoden, keine abweichenden Signaturen.

## Überblick

- **Spiel:** ASCHENTHRON — 1v1 Dark-Fantasy-Arena-Duell, First-Person, Best of 3.
- **Stack:** Three.js (Rendering, kein Build-Step, ES-Module + Import-Map),
  Node.js-Server (statische Dateien + WebSocket-Relay/Autorität via `ws`), HTML/CSS-UI.
- **Netzmodell:** Der Node-Server ist Autorität für Match-Phasen, Health, Schaden,
  Cooldown-/Reichweiten-Validierung. Bewegung ist client-autoritativ (LAN, 1v1).
  Treffererkennung macht der Angreifer-Client, der Server validiert grob und
  wendet Schaden an. Positionen werden mit ~30 Hz relayed, Remote-Spieler werden
  mit ~120 ms Puffer interpoliert.
- **Konventionen:** ES-Module überall (`"type": "module"`), Semikolons, 2 Spaces,
  deutsche Kommentare (kurz, erklärend), englische Bezeichner, JSDoc-Kopf pro Datei.
  Three.js wird importiert als `import * as THREE from 'three'` bzw.
  `from 'three/addons/...'` (Import-Map in index.html). KEINE weiteren Abhängigkeiten.
- **Einheiten:** Meter, Sekunden, Grad nur in Daten (intern Radiant). +Y ist oben.
  Spieler-Kapsel: `radius`, `height` (Fußpunkt = `position.y`, Augenhöhe = `eyeHeight`).
- **Zeit:** Server schickt `now` (ms, `Date.now()` des Servers) in `s_welcome` und
  `s_phase`; Client hält `offset = serverNow - Date.now()` und rechnet
  `net.serverNow()` damit aus. Alle `endsAt`-Felder sind Server-Millisekunden.

## Dateibaum

```
FantasyArenaGame/
├── package.json                  (vorhanden)
├── server/server.js              Statik-Server + WebSocket + Match-Autorität
├── shared/protocol.js            Nachrichtentypen, Phasen, Konstanten
├── shared/classes.js             Klassen-/Ability-Daten + Balancing + Match-Regeln
├── test/bot.js                   Headless-Testclient (zweiter Spieler)
├── public/
│   ├── index.html                Import-Map, Canvas, alle UI-Screens (DOM)
│   ├── css/ui.css                komplettes UI-Styling (Dark Fantasy)
│   └── js/
│       ├── main.js               Bootstrap, Game-Kontext, Game-Loop, Phasen-Logik
│       ├── core/Input.js         Tastatur/Maus/PointerLock
│       ├── net/NetworkClient.js  WebSocket-Client, Clock-Offset
│       ├── player/PlayerController.js   Lokale Bewegung/Physik (Kapsel)
│       ├── player/CameraController.js   Mouselook, FOV, Bob, Shake-Anwendung
│       ├── player/RemotePlayer.js       Interpolation + Rig + Nameplate (+Dummy)
│       ├── combat/CombatSystem.js       Ability-Ausführung, Hit-Claims, Eingang S_*
│       ├── combat/AbilitySystem.js      Cooldowns/Charge/Atem-Meter (lokal)
│       ├── combat/HealthSystem.js       Client-Spiegel der HP/Schilde
│       ├── combat/Projectiles.js        Projektil-Pool (lokal autoritativ/visuell)
│       ├── combat/MeleeHitbox.js        Kegel-/Kapsel-Trefferprüfung (pure Funktionen)
│       ├── world/Colliders.js           AABB/Zylinder-Kollision, Raycast, Boden
│       ├── world/ArenaManager.js        Arena-Registry (erweiterbar)
│       ├── world/Arena.js               „Ruinenburg“-Arena prozedural
│       ├── characters/CharacterRig.js   Prozedurale Charaktere + Viewmodels
│       ├── fx/VFXManager.js             Partikel/Explosionen/Ringe/Schild/Atem
│       ├── fx/ScreenShake.js            Trauma-basiertes Shake
│       ├── fx/PostFX.js                 Composer: Bloom + Grade (Vignette/Grain)
│       ├── audio/AudioFeedback.js       WebAudio-Synth (alle Sounds prozedural)
│       └── ui/UIManager.js              Screens, HUD, Ansagen, Einstellungen
├── README.md
└── docs/ (SETUP.md, ASSETS.md, ROADMAP.md, ARCHITECTURE.md)
```

---

## shared/protocol.js

```js
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
```

## shared/classes.js

```js
export const SLOT = { PRIMARY:'primary', SECONDARY:'secondary', SKILL1:'skill1', SKILL2:'skill2', ULTIMATE:'ultimate' };
export const SLOT_ORDER = [SLOT.PRIMARY, SLOT.SECONDARY, SLOT.SKILL1, SLOT.SKILL2, SLOT.ULTIMATE];
export const SLOT_KEYS = { primary:'LMB', secondary:'RMB', skill1:'Q', skill2:'E', ultimate:'R' };

export const MATCH = {
  ROUNDS_TO_WIN: 2, ROUND_SECONDS: 90,
  COUNTDOWN_SECONDS: 4, ROUND_END_SECONDS: 4,
  KILL_Y: -15, DUMMY_HP: 200, DUMMY_RESPAWN_SECONDS: 2,
};

export function getClass(id) { /* CLASSES[id] */ }
export const CLASS_IDS = ['mage', 'knight', 'dragon'];
export const CLASSES = { mage: {...}, knight: {...}, dragon: {...} };
```

Jede Klasse hat exakt diese Felder:

```js
{
  id, name, role, desc, tagline,            // Strings (deutsch), name: 'Magierin'|'Ritter'|'Drache'
  color: 0x66ccff,                          // Drei Akzentfarben als Hex-Zahlen:
  colorAccent: 0x9b5cff, colorEmissive: ...,
  maxHealth, moveSpeed, sprintMult, jumpHeight,
  radius, height, eyeHeight, scale,         // Kapsel + Visual-Skalierung
  abilities: { primary:{...}, secondary:{...}, skill1:{...}, skill2:{...}, ultimate:{...} },
  stats: { offense:0..1, defense:0..1, speed:0..1, range:0..1 } // für UI-Balken
}
```

Ability-Felder (nicht genutzte = 0/weglassen):
`{ name, key, kind, desc, damage, minDamage, cooldown, range, radius, speed,
   knockback, duration, chargeMax, tick, arcDeg, windup }`

`kind` ∈ `'projectile' | 'charged_projectile' | 'melee' | 'block' | 'dash' |
'blink' | 'shield' | 'breath' | 'leap' | 'aoe_self' | 'aoe_target'`

### Balancing (verbindlich)

| | **Magierin** (mage) | **Ritter** (knight) | **Drache** (dragon) |
|---|---|---|---|
| HP | 100 | 140 | 180 |
| moveSpeed | 6.8 | 5.8 | 5.2 |
| sprintMult | 1.35 | 1.3 | 1.25 |
| jumpHeight | 1.25 | 1.1 | 1.0 |
| radius/height/eye | 0.4 / 1.8 / 1.62 | 0.42 / 1.85 / 1.66 | 0.55 / 2.2 / 1.95 |
| scale | 1.0 | 1.05 | 1.4 |

- **Magierin** — primary „Arkanblitz“ (projectile): dmg 14, cd 0.4, speed 40, radius 0.3, range 60.
  secondary „Feuerball“ (charged_projectile): dmg 18→50 (charge), cd 2.2, speed 28,
  Explosionsradius 1.2→3.2, chargeMax 1.5, minDamage 18.
  skill1 „Blink“ (blink): range 7, cd 5. skill2 „Arkanschild“ (shield): 45 Schild-HP, duration 4, cd 11.
  ultimate „Arkan-Nova“ (aoe_target): range 24, radius 5.5, dmg 75, minDamage 35, knockback 10, windup 0.8 (Telegraph), cd 30.
- **Ritter** — primary „Schwerthieb“ (melee): dmg 18, cd 0.5, range 2.8, arcDeg 70.
  secondary „Schwerer Hieb“ (melee): dmg 34, cd 1.7, range 3.0, arcDeg 50, knockback 6, windup 0.35.
  skill1 „Schildblock“ (block): frontal (±60°) Schaden ×0.25, sonst ×0.85, Tempo ×0.55, kein cd (Halten).
  skill2 „Sturmangriff“ (dash): range 9, duration 0.35, dmg 24 (Kontakt), knockback 9, cd 7.
  ultimate „Erdspalter“ (aoe_self): radius 6.5, dmg 65, minDamage 25, knockback 8 (mit Knock-up), cd 28.
- **Drache** — primary „Klauenhieb“ (melee): dmg 17, cd 0.55, range 3.2, arcDeg 90.
  secondary „Feueratem“ (breath): tick 0.25, dmg 8/Tick, range 7.5, arcDeg 35, duration 3 (Meter), cd 6 (nach Ende).
  skill1 „Schwingenstoß“ (leap): Impuls hoch 7 + vorwärts 9, cd 8.
  skill2 „Schwanzfeger“ (aoe_self): radius 4.2, dmg 14, knockback 12, cd 9.
  ultimate „Infernoschlag“ (aoe_self): radius 8.5, dmg 85, minDamage 35, knockback 14, windup 0.6, cd 34.

**Regeln:** Ultimates starten jede Runde auf vollem Cooldown. AoE-Falloff linear
`dmg = lerp(damage, minDamage, dist/radius)`. AoE trifft den Angreifer nie selbst.
Knockback-Vektor = flache Richtung Ziel−Quelle × knockback + (0, knockback·0.35, 0).

---

## server/server.js (Autorität)

- HTTP-Statik: `/` → `public/index.html`; `/css/*`, `/js/*` → `public/...`;
  `/shared/*` → `shared/`; `/vendor/three/*` → `node_modules/three/build/*`;
  `/vendor/three/addons/*` → `node_modules/three/examples/jsm/*`.
  Pfad-Traversal-Schutz, korrekte MIME-Types (`.js → text/javascript`), `Cache-Control: no-store`.
- Beim Start: Banner mit lokaler URL(s) ausgeben — LAN-IPv4 via `os.networkInterfaces()`
  (erste nicht-interne IPv4, bevorzugt `192.168.*`/`10.*`).
- WebSocket (`ws`) am selben HTTP-Server. Max. 2 Spieler, dritter bekommt `S_FULL` + close.
- **Spieler-Record:** `{id, ws, name, classId, ready, hp, maxHp, shield, shieldUntil,
  lastState:{p,ry,pitch,anim,at}, cooldowns:{slot:lastCastAt}, alive}`
- **Validierung:** Phase muss `fighting` sein; Cooldown-Check mit Toleranz
  (erlaubt ab `0.85 × cd`); Reichweiten-Check Distanz(Angreifer, Ziel) ≤ `range·1.4 + 2.5`
  (Bewegungs-Slack); `c_breath` zusätzlich rate-limit ≥ 0.2 s. `c_aoe` mit `aoe_self`-Kind
  nutzt die SERVER-bekannte Angreiferposition als Zentrum; `aoe_target` (Nova) clampt
  das gesendete Zentrum auf `range + 3` um den Angreifer. Fireball (`secondary` der Magierin)
  wird als `c_aoe` aufgelöst (Explosionsradius skaliert mit `charge`).
- **Schaden:** Block-Check (Ritter: `anim.blocking` und Winkel Angreifer→Ziel-Blickrichtung ≤ 60° → ×0.25, sonst bei Block ×0.85),
  dann Schild absorbieren, dann HP. Broadcast `S_DAMAGE` an BEIDE (inkl. hp/shield-Resultat).
  HP ≤ 0 → `S_DEATH`, Rundenende.
- **Phasen-Maschine:** lobby → (2 Spieler) class_select → (beide ready) countdown(4 s,
  vorher `S_RESET` mit Spawns/HP) → fighting(90 s) → round_end(4 s) → countdown … →
  match_end (2 Siege). Timeout: mehr HP-Prozent gewinnt; Gleichstand → `winnerId:null`,
  Runde zählt nicht. Seitenwechsel der Spawns pro Runde. `c_rematch` in match_end →
  Scores reset → class_select. Disconnect des Gegners → `S_LEFT`, zurück nach
  lobby/class_select, Scores reset.
- **Solo:** `c_solo` (wenn allein) → Dummy `{id:'dummy', hp:200}` in Arenamitte,
  Phase fighting ohne Timer (endsAt = now + 1 h). Dummy nimmt Schaden wie ein Spieler
  (ohne Block/Schild), bei 0 HP → `S_EVENT {kind:'dummy_respawn'}` + nach 2 s volle HP.
  `c_leave_solo` → class_select.
- **Fallschutz:** Eingehende `c_state` mit `p[1] < KILL_Y` im fighting → wie Tod behandeln (Gegner gewinnt Runde; im Solo: Reset auf Spawn via `S_RESET`).
- Heartbeat-Ping alle 10 s, tote Sockets aufräumen. Alle eingehenden JSON-Parses in try/catch.

## test/bot.js

Headless-Zweitspieler für Tests UND als Trainingsgegner:
verbindet sich auf `ws://localhost:8080` (Arg 1 = andere URL), `c_hello {name:'Bot'}`,
wählt Klasse (Arg 2, Default `knight`), `c_ready`. Im fighting: bewegt sich auf
Kreisbahn um die Arenamitte (`c_state` mit 20 Hz, plausible y=Bodenhöhe ~0.5),
alle 1.5–3 s ein `c_attack` (primary). Loggt alle Phasen/Schadens-Events kompakt.
Reagiert auf round_end/match_end (bleibt ready für Rematch: sendet `c_rematch` nach 2 s).

---

## Client — Game-Kontext (main.js)

`main.js` erzeugt den zentralen Kontext und reicht ihn an alle Konstruktoren:

```js
const game = {
  renderer, scene, camera,        // THREE.WebGLRenderer/Scene/PerspectiveCamera
  time: { dt: 0, now: 0 },        // Sekunden, dt geclampt auf ≤ 0.05
  net, input, ui, audio, vfx, postfx, shake,
  colliders,                      // Colliders-Instanz
  arena,                          // Rückgabe von ArenaManager.build()
  projectiles,                    // ProjectileManager
  health,                         // HealthSystem
  local: null,    // { classId, def, controller, cameraCtl, abilities, combat, viewmodel }
  remote: null,   // RemotePlayer | null   (Gegner ODER Dummy: remote.id === 'dummy')
  phase: 'lobby', myId: null,
  roster: new Map(),              // id → {id,name,classId,ready}
  settings,                       // {sensitivity:1, quality:'medium', volume:0.8} (localStorage 'aschenthron')
  updatables: new Set(),          // alles mit update(dt) – wird im Loop aufgerufen
};
```

**Loop:** `requestAnimationFrame` → dt clamp → `input`-Poll → lokaler Spieler
(controller, cameraCtl, combat, abilities, viewmodel) → remote → projectiles →
vfx → arena.update → shake → `postfx.render(dt)` → HUD-Update (`ui.tickHud(game)`).
**Menü-Kamera:** solange kein lokaler Kampf läuft (phase lobby/class_select/match_end),
kreist die Kamera langsam über der Arena (Orbit, Blick auf Mitte) — UI liegt darüber.

**Phasen-Handling (main.js):**
- `s_phase` → `game.phase`; UI-Screen wechseln (`ui.showScreen`), Countdown-Ansagen
  (3…2…1…KAMPF! via `ui.announce` + `audio`), Input-Lock setzen
  (`controller.inputLocked`, Kampf-Input nur in `fighting`).
- `s_reset` → lokalen Spieler/Klasse instanziieren (falls Klassenwechsel), teleportieren,
  `abilities.resetForRound()`, `health.resetFromRoster()`, Remote/Dummy (neu) aufbauen,
  `projectiles.clear()`, `vfx.clearTransient()`.
- `s_death` → wenn ich: Kamera sinkt auf 0.4 m (0.6 s), Grau-Fade (postfx), Input-Lock.
- `s_left` → Toast + zurück ins Lobby-UI.
- Pointer-Lock: nur im fighting angefragt (Klick/Resume); `pointerlockchange` ohne
  Lock im fighting → Pause-Menü zeigen.

### core/Input.js

```js
export class Input {
  constructor(domElement)
  update()                          // pro Frame: just-pressed Flags pflegen
  isDown(action) / wasPressed(action) / wasReleased(action)
  // actions: 'forward','back','left','right','jump','sprint',
  //          'primary','secondary','skill1','skill2','ultimate'
  consumeMouseDelta()               // {dx, dy} seit letztem Aufruf
  setPointerLockTarget(el); requestLock(); exitLock(); get locked()
  onLockChange(cb)                  // cb(locked:boolean)
  enabled = true                    // false → alle Abfragen liefern neutral
}
```
Mapping: KeyW/S/A/D, Space, ShiftLeft, Mouse0/Mouse2, KeyQ/KeyE/KeyR.
`contextmenu` unterdrücken. Mausdelta nur bei Pointer-Lock.

### net/NetworkClient.js

```js
export class NetworkClient {
  constructor()
  connect()                 // Promise<void>; ws://location.host; resolved nach S_WELCOME
  on(type, handler)         // mehrere Handler pro Typ erlaubt
  send(type, payload = {})
  get id()                  // eigene Spieler-ID (nach welcome)
  get lanIp()               // vom Server gemeldet
  serverNow()               // ms in Serverzeit
  startStateLoop(getState)  // ruft getState() mit STATE_HZ ab und sendet C_STATE
  stopStateLoop()
  get connected()
  onClose(cb)
}
```

### player/PlayerController.js

```js
export class PlayerController {
  constructor(game, classDef)
  position /* THREE.Vector3 (Fußpunkt) */, velocity, yaw /* wird von CameraController gesetzt */
  grounded, inputLocked = true, blocking = false  // blocking → Tempo ×0.55
  update(dt)                       // Input lesen (game.input), Physik, Kollision
  teleport(pos /*Vector3|[x,y,z]*/, yaw)
  addImpulse(v3)                   // Knockback/Leap (überschreibt y-Anteil sinnvoll)
  startDash(dirV3, distance, duration)   // skriptete Geschwindigkeit, ignoriert Input
  get isDashing(); get speed01()   // 0..1 horizontale Geschwindigkeit/maxSprint
  get eyePos()                     // Vector3 Fußpunkt + eyeHeight
  events: onFootstep = cb, onJump = cb, onLand = cb   // einfache Property-Callbacks
}
```
Physik: Beschleunigung Boden 60/s², Luft 12/s², Reibung Boden 10/s, g = 22 m/s²,
Sprung `v = sqrt(2·g·jumpHeight)`, Step-up ≤ 0.4 m, Kollision via
`game.colliders.resolveCapsule(...)`. Dash/Impulse robust gegen Wände (Kollision löst).

### player/CameraController.js

```js
export class CameraController {
  constructor(game, controller)    // steuert game.camera
  update(dt)                       // Mouselook (input.consumeMouseDelta), Bob, FOV, Shake-Offset (game.shake)
  pitch /* rad */, get lookDir()   // Vector3 Blickrichtung
  fovPunch(amount)                 // kurzer FOV-Kick (Treffer/Dash)
  kick(pitchDeg)                   // Recoil
  setDeathCam(on)                  // Kamera sinkt/neigt sich
  active = true                    // false → Menü-Orbit übernimmt (main.js)
}
```
Sensitivität aus `game.settings.sensitivity` (Basis 0.0023 rad/px), Pitch ±85°,
FOV 75 → 80 beim Sprint (lerp), Headbob subtil (Amplitude 0.018 m·speed01).

### player/RemotePlayer.js

```js
export class RemotePlayer {
  constructor(game, { id, name, classId })   // classId 'mage'|'knight'|'dragon'|'dummy'
  pushState(msg)                  // S_STATE-Payload + Empfangszeit puffern
  update(dt)                      // Interpolation (INTERP_DELAY_MS), Rig-Anim, Nameplate-Billboard
  playAttack(slot); setHealth(frac)
  onDamaged(point)                // Hit-Flash am Rig
  get position()                  // interpolierte Fußpunkt-Position (Vector3)
  get capsule()                   // {p:Vector3(Fußpunkt), radius, height} für Treffertests
  dispose()                       // aus Szene entfernen
}
```
Dummy (`classId 'dummy'`): statisch, kein State-Push nötig, Rig „Trainingsgolem“.

### combat/AbilitySystem.js

```js
export class AbilitySystem {
  constructor(classDef)
  isReady(slot); remaining(slot); fraction(slot)   // 0=bereit … 1=voll auf CD
  trigger(slot)                    // Cooldown starten
  resetForRound()                  // alles bereit, Ultimate auf vollen CD, Atem-Meter voll
  // Charge (Feuerball): beginCharge(); get charge01(); endCharge() → charge01
  // Atem (Drache): breathMeter01; drainBreath(dt) → bool (noch Luft); refillLocked bis cd
  update(dt)
}
```

### combat/HealthSystem.js

```js
export class HealthSystem {
  constructor(game)
  applyDamage(msg)                 // S_DAMAGE-Payload einarbeiten (hp/shield-Spiegel)
  resetFromRoster()                // maxHp je classId aus Roster, voll heilen
  mine()   // {hp, maxHp, shield}
  theirs() // {hp, maxHp, shield, id}  (Gegner oder Dummy)
  setShield(id, amount)            // S_SHIELD
  get myFrac(); get theirFrac()
}
```

### combat/MeleeHitbox.js (pure Funktionen)

```js
export function coneHit(originV3, dirV3, range, arcDeg, capsule) // → {hit:bool, point:Vector3|null}
export function sphereHit(centerV3, radius, capsule)             // → {hit, point}
export function capsuleClosestPoint(pointV3, capsule)            // → Vector3
```
Kapsel = `{p:Vector3(Fußpunkt), radius, height}`. Kegeltest: Distanz zur Kapselachse ≤ range
UND Winkel zwischen dir und (closest − origin) ≤ arcDeg/2 (horizontal großzügig: Winkel in 3D).

### combat/Projectiles.js

```js
export class ProjectileManager {
  constructor(game)
  spawnLocal({slot, def /*ability*/, origin, dir, charge, color}) // eigenes Projektil (löst C_HIT/C_AOE aus)
  spawnRemote({slot, def, origin, dir, charge, color})            // Gegner-Projektil (nur Visual + kosmetische Explosion)
  update(dt); clear()
}
```
Treffertest eigener Projektile: Welt (`colliders.raycast` segmentweise) + Gegner-Kapsel
(`game.remote.capsule`). Arkanblitz → `C_HIT` bei Direkttreffer; Feuerball → IMMER
`C_AOE {slot:'secondary', center:impact}` + lokale Explosion `vfx.explosion`.
Max. 2 dynamische PointLights gleichzeitig (Pool). Glühende Kugel + Trail via `vfx.trail`.

### combat/CombatSystem.js (Integrator — liest die echten Module)

```js
export class CombatSystem {
  constructor(game)
  combatEnabled = false            // von main.js je Phase gesetzt
  update(dt)                       // Input → Abilities ausführen (kind-Switch), Windups, Breath-Ticks
  handleAttack(msg)   // S_ATTACK → Remote-VFX/-Anim/-Sound (+ spawnRemote bei Projektilen, Telegraph bei Nova)
  handleDamage(msg)   // S_DAMAGE → health.applyDamage, VFX am Punkt, Shake/Vignette (ich), Hitmarker (Angreifer ich), Knockback (ich)
  handleShield(msg); handleDeath(msg)
  cancelChannels()                 // bei Phasenwechsel/Tod: Charge/Breath/Windup abbrechen
}
```
Ausführung je `kind` (lokal): melee → `coneHit` gegen `remote.capsule` → `C_ATTACK` immer,
`C_HIT` bei Treffer; charged → halten/loslassen; blink → Raycast-Clamp gegen Wände,
teleport + VFX; dash → `controller.startDash` + Kontaktprüfung während Dash (einmalig);
shield/breath/leap/aoe_self/aoe_target gemäß Balancing; Nova: Zielpunkt =
Kamera-Raycast (range 24, sonst Clamp), Telegraph 0.8 s (VFX + `C_ATTACK` sofort,
`C_AOE` nach Windup). Dragon-Ult: 0.6 s Windup (Tempo ×0.4, Glühen, Roar) → `C_AOE`.

### world/Colliders.js

```js
export class Colliders {
  addBox(minV3, maxV3); addCylinder(x, z, r, y0, y1)
  resolveCapsule(pos /*Fußpunkt, wird mutiert*/, radius, height, velocity /*mutiert*/, stepUp = 0.4)
       // → {grounded:bool}
  raycast(originV3, dirV3, maxDist)        // → {hit:bool, point, normal, dist}
  groundHeight(x, z, fromY)                // höchste Oberfläche ≤ fromY+stepUp, sonst 0
}
```

### world/ArenaManager.js & world/Arena.js

```js
// ArenaManager.js
export const ARENAS = { ruinenburg: { name:'Ruinenburg', build: buildRuinenburg } };
export function buildArena(game, key = 'ruinenburg')
// → { key, spawns:[{p:Vector3, ry}, {p, ry}], center:Vector3, update(dt), dispose() }
```
Arena.js exportiert `buildRuinenburg(game)`: ~46×46 m; Steinboden (prozedurale
Canvas-Textur: Quader-Fugen + Noise, RepeatWrapping), erhöhte Mittelplattform
(2 Stufen + Rampen/Treppen), gebrochener Außenwall (Segmente, var. Höhe, Lücken —
dahinter UNSICHTBARE Blocker-Boxen, niemand fällt raus), 8–10 Säulen (2–3 gestürzt),
Schutthaufen, 2 Deckungsmauern, 2 Spawn-Podeste (gegenüber, Blick zur Mitte),
10–12 Fackeln (Stab + `vfx.torchFlame(pos)` + max. 6 echte PointLights mit Flacker-Update,
Rest nur Emissive), Mond-DirectionalLight (bläulich, castShadow, 2048er Map, enge
Shadow-Cam), HemisphereLight schwach, `THREE.FogExp2(0x0a0d14, 0.016)`,
Sky-Kuppel (invertierte Kugel, Gradient-Shader oder VertexColors) + Sterne (Points) +
Mond-Sprite, ferne Ruinen-Silhouetten, Ambient-Partikel via `vfx.ambient(...)`.
JEDES solide Element registriert Collider. Alles statisch → `matrixAutoUpdate = false`.
Materialien: `MeshStandardMaterial`, Stein roughness ~0.9. `update(dt)` = Fackel-Flackern.

### characters/CharacterRig.js

```js
export function buildRig(classId, { firstPerson = false } = {})
// → { group:THREE.Group, update(dt), setMove(speed01), playAttack(slot),
//     setBlocking(b), setBreath(b), setCharging(c01), die(), reset() }
export function makeNameplate(name)  // → {sprite:THREE.Sprite, setHealth(frac), dispose()}
```
- **Ritter:** dunkler Stahl (metalness 0.85, roughness 0.35) + Goldkanten, Helm mit
  Busch, Schultern, Brustpanzer tailliert, Umhang (Plane), Schwert (Klinge mit dezenter
  Emissive-Kante), Wappenschild. Attack = Arm-/Schwert-Schwungkurven, Block = Schild hoch.
- **Magierin:** schlanke, elegante Silhouette, dunkelviolette Robe mit glühenden
  Runen-Streifen (emissive), Kapuze, schwebt 5 cm (Idle-Bob), Stab mit Arkankristall
  (Emissive + kleines PointLight beim Charging), lange Handschuhe. Stilvoll, nicht plakativ.
- **Drache:** 1.4× Maßstab, gedrungener Körper, Hals + Kopf mit Hörnern/Schnauze,
  Membran-Flügel (Flap-Anim), Schwanz aus 4 Segmenten (Wellen-Anim), dunkelrote/
  schwarze Schuppen, glühender Brust-/Maulkern (emissive). Breath = Maul auf + Glühen.
- **Dummy:** Holzpfahl + Strohpuppe mit Zielscheibe.
- **firstPerson:** nur Arme + Waffe (Schwert/Stab/Klauen), tief rechts im Bild;
  `playAttack` = Viewmodel-Schwung; `setCharging` skaliert Glüh-Orb; `setBlocking`
  hebt Schild/Arm. Gruppe wird von main.js an die Kamera gehängt (Position ~(0.25,-0.3,-0.5)).
Alle Animationen prozedural (sin/Lerp-Kurven, keine Keyframe-Assets). Materialien teilen.

### fx/VFXManager.js

```js
export class VFXManager {
  constructor(scene)
  update(dt); clearTransient()
  // Einmal-Effekte:
  muzzleFlash(pos, colorHex); hitSparks(pos, normal, colorHex); bloodPuff(pos)
  explosion(pos, radius, palette /* 'fire'|'arcane' */)   // Flash-Licht (Pool ≤3), Funken, Rauch, Stoßring
  shockwave(pos, maxRadius, colorHex)                     // expandierender Bodenring
  groundSlam(pos, radius)                                 // Ring + Trümmer + Staub
  novaTelegraph(center, radius, durationS)                // glühender Warnring am Boden
  blinkFlash(fromPos, toPos, colorHex)
  // Anhaltende Effekte (Handle = {set(on)/setLevel(x), update intern, dispose()}):
  trail(object3D, colorHex)            // Projektil-Schweif
  breathCone(parentObj, colorHex)      // Feueratem-Kegel, set(on)
  shieldBubble(parentObj, radius, colorHex, durationS)
  chargeOrb(parentObj, colorHex)       // setLevel(0..1)
  torchFlame(pos)                      // Fackelflamme + Glut (Dauer-Emitter)
  ambient(bounds)                      // Staub/Glutpartikel in der Arena
}
```
Implementierung: gepoolte `THREE.Points`-Partikelsysteme (BufferGeometry, additive
Canvas-Glow-Textur, CPU-Update; Caps: ~2000 Partikel gesamt), Ringe als `RingGeometry`
mit additivem `MeshBasicMaterial` (Fade über Opacity), Schildkugel transparent + Puls.
Transiente Lichter aus festem Pool (max 3), nie unbegrenzt Lights erzeugen.

### fx/ScreenShake.js

```js
export class ScreenShake {
  add(amount /*0..1*/); update(dt)
  offsetPos /*Vector3*/, offsetRot /*Euler*/   // von CameraController NACH Mouselook addiert
}
```
Trauma-Modell: `trauma = min(1, trauma+amount)`, Abkling 1.4/s, Offset ∝ trauma²
(Pos ≤ 0.12 m, Rot ≤ 0.7°), Simplex/Sin-Rauschen.

### fx/PostFX.js

```js
export class PostFX {
  constructor(renderer, scene, camera)
  render(dt); resize(w, h); setQuality(q /* 'low'|'medium'|'high' */)
  damagePulse(strength01)   // rote Rand-Vignette aufblitzen
  deathFade(on)             // Entsättigung/Abdunkeln
}
```
Composer: RenderPass → UnrealBloomPass (0.55/0.6/0.85) → OutputPass → eigener
Grade-ShaderPass (Vignette 0.35, animiertes Grain 0.035, leichte chromatische
Aberration, Damage-/Death-Uniforms). Renderer: `ACESFilmicToneMapping`,
`toneMappingExposure 1.05`, Schatten PCFSoft. Quality: low = kein Bloom, pixelRatio 1;
medium = pixelRatio ≤ 1.5; high = pixelRatio ≤ 2. `setQuality` darf Composer neu aufbauen.

### audio/AudioFeedback.js

```js
export class AudioFeedback {
  constructor()
  unlock()                  // im User-Gesture aufrufen (AudioContext resume)
  setVolume(v01); setListener(pos, forward)   // einfache Stereo-Pan/Distanz-Logik
  play(id, { pos = null, vol = 1, pitch = 1 } = {})
  loop(id, { pos = null, vol = 1 } = {})  // → {stop(), setPos(p)}
  startAmbience()           // Wind-Drone + gelegentliches Fackel-Knistern
}
```
Alle Sounds prozedural (WebAudio: Noise-Buffer, Oszillatoren, Filter, Envelopes,
Waveshaper für Roar). **Verbindliche IDs:** `ui_click, ui_hover, cast_arcane,
fireball_launch, charge_loop, explosion_small, explosion_big, sword_swing,
sword_hit, heavy_swing, heavy_hit, block_impact, shield_up, shield_break, blink,
dash, claw, breath_loop, roar, tail_whoosh, slam, nova_cast, nova_blast, hurt,
death, hitmarker, footstep, jump, land, countdown_tick, round_start, round_win,
round_lose, match_win, match_lose, heartbeat`. Unbekannte ID → still ignorieren.

### ui/UIManager.js + index.html + css/ui.css

index.html enthält: Import-Map (`three` → `/vendor/three/three.module.js`,
`three/addons/` → `/vendor/three/addons/`), `<canvas id="game-canvas">`,
alle Screens als DOM, `<script type="module" src="/js/main.js">`.

```js
export class UIManager {
  constructor()             // greift sich DOM-Elemente; KEINE three-Imports
  callbacks = { onEnter(name), onSelectClass(classId), onReady(ready), onRematch(),
                onSolo(), onLeaveSolo(), onResume(), onLeave(), onSettings(settings) }
  showScreen(name)          // 'menu'|'lobby'|'class'|'hud'|'pause'|'result'|'disconnected'
  get currentScreen()
  // Menü/Lobby:
  setJoinInfo(lanIp, port)  // "Spieler 2 öffnet: http://IP:8080"
  setRoster(players, myId)  // Klassenwahl-Status, Gegner bereit?
  setSoloAvailable(b)
  // HUD:
  tickHud(game)             // pro Frame: HP/Schild-Balken, Cooldown-Slots (fraction), Charge/Atem-Meter, Timer
  setScores(mine, theirs, round); setTimer(seconds|null)
  announce(text, { sub = '', ms = 1800, big = false } = {})
  countdown(n)              // große 3/2/1/Zahl
  hitmarker(); damageDirection(angleRad)   // Richtungs-Vignette
  showDamageNumber(amount, screenX01, screenY01)  // optional schwebende Zahl
  setEnemyInfo(name, classId)
  // Result:
  showResult({ victory, scoreMine, scoreTheirs, soloAllowed })
  toast(text, ms = 3000)
  getSettings(); // liest/persistiert localStorage 'aschenthron-settings'
}
```
**Screens:** Menü (Titel ASCHENTHRON, Untertitel „1v1 Arena-Duell“, Name-Feld,
„Arena betreten“, Steuerungs-Übersicht, Qualität/Empfindlichkeit/Lautstärke),
Lobby (Warten + Join-URL groß + Solo-Button), Klassenwahl (3 Karten: Name, Tagline,
Stat-Balken aus `stats`, Fähigkeitenliste mit Tasten, Hover-Glow, Auswahl-Rahmen,
„Bereit“-Button, Gegner-Status), HUD (eigene HP unten links + Schild-Overlay,
Gegner-HP oben mittig mit Name/Klasse, 5 Ability-Slots unten mittig mit Tasten-Label +
Cooldown-Sweep über `conic-gradient`, Charge-/Atem-Balken, Runden-Pips, Timer,
klassen-spezifisches Crosshair (CSS), Ansagen-Layer, Hitmarker, Damage-Vignette,
Low-HP-Puls < 25 %), Pause (Fortsetzen, Regler, Verlassen), Ergebnis (SIEG/NIEDERLAGE,
Score, Revanche, Klasse wechseln), Disconnect-Screen.
**Stil:** tiefes Schwarzblau (#07090f), Glut-Gold (#c98a3d), Arkan-Cyan (#6fd3e8),
Blutrot (#a2293a); Serifen-Display (Georgia/Palatino, Kapitälchen, letter-spacing),
Panels mit `backdrop-filter: blur`, feine Goldränder (Gradient-Border), Glow-Schatten,
sanfte Einblend-Animationen. KEINE externen Fonts/CDNs (offline-fähig). Erwachsen,
edel, dark-fantasy — nicht verspielt.

---

## Wiring-Tabelle (wer ruft wen)

| Ereignis | Fluss |
|---|---|
| Bewegung | Input → PlayerController → Colliders; NetworkClient.startStateLoop sendet C_STATE |
| Gegnerbewegung | S_STATE → RemotePlayer.pushState → Interpolation |
| Angriff lokal | Input → CombatSystem (kind-Switch) → C_ATTACK/C_HIT/C_AOE/C_BREATH + lokale VFX/Audio/Viewmodel |
| Angriff Gegner | S_ATTACK → CombatSystem.handleAttack → RemotePlayer.playAttack + VFX/Audio (+spawnRemote) |
| Schaden | S_DAMAGE → CombatSystem.handleDamage → HealthSystem + UI (Vignette/Hitmarker/Zahlen) + Shake + Knockback (wenn ich Ziel) |
| Phase | S_PHASE → main.js → UIManager.showScreen + Locks + Ansagen |
| Reset | S_RESET → main.js (Teleport, Heal, Remote/Dummy-Aufbau, clear) |

## Hinweise für Implementierer

- Defensive Checks: `game.remote` kann `null` sein; Nachrichten unbekannter Spieler ignorieren.
- Keine `console.log`-Flut; `console.warn` nur für echte Anomalien.
- Kein `THREE.*` im Server/Bot/Shared-Code (läuft in Node ohne DOM).
- Alle Vektoren über die Leitung als Arrays `[x,y,z]`; Konvertierung an den Rändern.
- Wiederverwendbare `Vector3`-Temporaries statt Allokationen im Hot Path.
- `dispose()` für Geometrien/Materialien bei clear/dispose-Pfaden wo praktikabel.
