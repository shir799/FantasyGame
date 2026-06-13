# ASCHENTHRON — Roadmap

Priorisierte nächste Schritte vom spielbaren Prototyp zum hochwertigen Spiel.
Die Reihenfolge ist bewusst: **erst das Spielgefühl schärfen, dann hübsch machen,
dann mehr Inhalt, dann Technik vertiefen.** Jeder Punkt nennt konkret, wo im
bestehenden Code anzusetzen ist.

## Stufe 1 — Gameplay-Tiefe (das Duell muss sich großartig anfühlen)

### 1.1 Trefferfeedback-Tuning
Die Stellschrauben existieren bereits, sie müssen nur ausbalanciert werden:
`ScreenShake.add(amount)` pro Trefferart (leichter Hit ~0.15, Ultimate ~0.6),
`PostFX.damagePulse(strength01)` proportional zum erlittenen Schaden,
`CameraController.fovPunch()`/`kick()` bei eigenen Treffern sowie
`UIManager.hitmarker()` und `showDamageNumber(...)` in `CombatSystem.handleDamage`.
Ziel: Jeder Treffer ist spürbar, ohne dass das Bild bei Dauerfeuer zum Wackelpudding wird.

### 1.2 Balancing-Iteration
Sämtliche Kampfwerte (Schaden, Cooldowns, Reichweiten, Knockback) liegen zentral
in `shared/classes.js` — Server und Client lesen dieselbe Datei, eine Änderung
wirkt also sofort überall konsistent. Vorgehen: Duelle spielen (oder `npm run bot`
mit verschiedenen Klassen), Sieg-Tendenzen notieren, gezielt **eine** Zahl ändern,
erneut testen. Typische erste Kandidaten: Feuerball-Maximalschaden vs.
Ritter-Blockfaktor, Drachen-HP vs. seine geringe Mobilität.

### 1.3 Solo-Training erweitern
Der Dummy-Pfad steht (`c_solo`, `RemotePlayer` mit `id 'dummy'`, Respawn-Event).
Naheliegende Ergänzung: DPS-Anzeige im Training — in `CombatSystem.handleDamage`
Schaden gegen den Dummy aufsummieren und über `UIManager.toast(...)` oder eine
kleine HUD-Zeile ausgeben.

## Stufe 2 — Assets (vom prozeduralen Look zur echten Optik)

Quellen und Lizenz-Hinweise: siehe [ASSETS.md](ASSETS.md).

### 2.1 GLTF-Charaktere + Mixamo-Animationen
Modelle (z. B. Quaternius Fantasy-Pack) per `GLTFLoader` laden und in
`characters/CharacterRig.js` hinter der bestehenden `buildRig`-Schnittstelle
einbauen — `RemotePlayer` und das Viewmodel merken davon nichts. Pro Charakter
ein `THREE.AnimationMixer` mit einer kleinen State-Machine (Idle ↔ Run ↔ Attack ↔
Block ↔ Death), die in `update(dt)` Clips per `crossFadeTo` blendet; `setMove(speed01)`
und `playAttack(slot)` werden zu Zustandsübergängen statt Sinus-Kurven.

### 2.2 PBR-Texturen für die Arena
In `world/Arena.js` die prozedurale Canvas-Bodentextur durch Poly-Haven-Material
(map + normalMap + roughnessMap, RepeatWrapping) ersetzen; gleiche Technik für
Wall-Segmente und Säulen. Collider und Layout bleiben unverändert — rein visuelle
Aufwertung mit großem Effekt, da der Boden den halben Bildschirm füllt.

### 2.3 Echte Sounds
`audio/AudioFeedback.js` intern auf `AudioBuffer`-Wiedergabe umstellen, die
`play(id)`-Schnittstelle und die verbindliche ID-Liste beibehalten — der Synth
bleibt als Fallback für noch nicht ersetzte IDs. Die wirkungsvollsten zuerst:
`sword_hit`, `explosion_big`, `roar`, `round_start`.

## Stufe 3 — Mehr Inhalt

### 3.1 Weitere Arenen
`world/ArenaManager.js` ist dafür vorbereitet: Neue Arena = neue Build-Funktion
(nach dem Muster von `buildRuinenburg(game)`), die `{ key, spawns, center,
update(dt), dispose() }` zurückgibt und alle soliden Elemente bei `game.colliders`
registriert — dann nur noch in die `ARENAS`-Registry eintragen. Ideen mit eigenem
Charakter:

- **Drachenhöhle (Lava):** Lavabecken als Todeszonen (unter `KILL_Y`-Logik bzw.
  eigene Schadensflächen), glühendes Punktlicht-Ambiente, enge Sichtachsen.
- **Waldtempel:** überwucherte Plattformen, viel vertikales Spiel für Blink/Schwingenstoß.
- **Bergfestung:** Windkante mit Absturzgefahr, lange Sichtlinien — Magierin-Terrain.
- **Kathedrale:** Innenraum mit Säulenreihen als Deckung, Buntglas-Lichtkegel.
- **Kristallhöhle:** emissive Kristalle statt Fackeln, Spiegel-Glints, enge Korridore.

Arena-Wahl: Vor `class_select` per Zufall vom Server bestimmen und den Key über
eine kleine Protokoll-Erweiterung (z. B. Feld in `S_RESET`) an `buildArena(game, key)` geben.

### 3.2 Match-Varianten
`MATCH` in `shared/classes.js` parametrisiert Rundenzahl und -dauer bereits —
ein „Best of 5“- oder „Blitz (45 s)“-Modus ist primär eine Lobby-UI-Option plus
ein Feld in `c_ready`/Phasenstart auf dem Server.

## Stufe 4 — Technik

### 4.1 Server-Reconciliation für Bewegung
Heute ist Bewegung client-autoritativ (`C_STATE`-Relay). Für mehr Robustheit:
Server simuliert die Kapselphysik aus `PlayerController` nach (die Konstanten
g/Beschleunigung/Reibung in ein shared-Modul ziehen, da `Colliders` three-frei
formulierbar ist), Client sendet Inputs mit Sequenznummern, prädiziert lokal und
korrigiert sanft bei Abweichung. Lohnt vor allem als Grundlage für Internet-Play.

### 4.2 Spectator-Modus
Der Server lehnt einen dritten Socket aktuell mit `S_FULL` ab — stattdessen als
Rolle `spectator` akzeptieren: erhält `S_ROSTER`/`S_PHASE`/`S_STATE` beider Spieler,
darf nichts senden. Client-seitig: zwei `RemotePlayer`-Instanzen statt einer,
Kamera im Menü-Orbit-Modus (`CameraController.active = false`) oder frei fliegend.

### 4.3 Internet-Play
Variante A: **Port-Forwarding** — Port `8080` (bzw. `PORT` aus `shared/protocol.js`)
im Router auf den Host-Mac weiterleiten, Spieler 2 nutzt die öffentliche IP; dafür
sollte der Client-Connect in `NetworkClient` weiterhin `location.host` nutzen
(funktioniert dann automatisch). Variante B: **Relay** — den bestehenden Server
unverändert auf einen kleinen Cloud-Host (Node ≥ 18) deployen; da er Statik UND
WebSocket bedient, reicht `npm start` dort. Für WSS hinter HTTPS einen Reverse-Proxy
davorsetzen und in `NetworkClient` `wss://` bei `https:`-Seiten wählen.

### 4.4 Gamepad-Unterstützung
Die Gamepad-API in `core/Input.js` hinter der bestehenden Action-Schnittstelle
(`isDown`/`wasPressed`/`consumeMouseDelta`) integrieren: Sticks auf Bewegung/
Umsehen mappen (rechter Stick speist das Maus-Delta), Trigger/Buttons auf die
Slots. Kein anderes Modul muss sich ändern — genau dafür ist die Abstraktion da.

### 4.5 Replays
Da der gesamte Spielzustand über Nachrichten läuft, genügt es, server- oder
client-seitig alle `S_*`-Nachrichten mit Zeitstempel als JSON-Zeilen aufzuzeichnen.
Wiedergabe = die Aufzeichnung zeitgesteuert in die bestehenden `net.on(...)`-Handler
einspeisen (NetworkClient um eine Playback-Quelle erweitern), kombiniert mit dem
Spectator-Rendering aus 4.2.
