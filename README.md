# ASCHENTHRON

> **1v1 Dark-Fantasy-Arena-Duell** — First Person, Best of 3, direkt im Browser.

Zwei Kämpfer betreten eine verfallene Ruinenburg unter blutrotem Mond. Magierin,
Ritter oder Drache — drei Klassen, fünf Fähigkeiten, eine Arena. Wer zwei Runden
gewinnt, besteigt den Aschenthron. Gespielt wird zu zweit im lokalen Netzwerk
(z. B. zwei Macs im selben WLAN), komplett ohne Build-Step und ohne externe Dienste:
Ein kleiner Node.js-Server liefert das Spiel aus und schiedsrichtert das Match,
Three.js rendert die Welt direkt im Browser.

## Features

- **Drei spielbare Klassen** mit eigenem Stil:
  - **Magierin** — schnell und zerbrechlich: Arkanblitze, aufladbarer Feuerball, Blink, Arkanschild, Arkan-Nova.
  - **Ritter** — Stahl und Disziplin: Schwerthiebe, Schildblock, Sturmangriff, Erdspalter.
  - **Drache** — wandelnde Naturgewalt: Klauen, Feueratem, Schwingenstoß, Schwanzfeger, Infernoschlag.
- **Best of 3** mit 90-Sekunden-Rundenlimit — läuft die Zeit ab, gewinnt, wer prozentual mehr Lebenspunkte übrig hat.
- **First-Person-Kampf** mit Projektilen, Nahkampf-Kegeln, Flächenschaden, Knockback, Block und Telegraph-Ultimates.
- **Server-Autorität** für Phasen, Schaden und Cooldowns — kein Schummeln bei Treffern und Timern.
- **Stimmungsvolle Arena „Ruinenburg“**: prozedural gebaut, Fackeln, Mondlicht, Nebel, Sternenhimmel.
- **Komplett prozedural**: Charaktere, Effekte und sogar alle Sounds (WebAudio-Synth) entstehen im Code — keine Asset-Downloads nötig.
- **Solo-Training** gegen einen Trainingsgolem sowie ein Headless-Bot als Übungsgegner.
- **Null Build-Step**: ES-Module + Import-Map, `npm start` genügt.

## Schnellstart (5 Schritte)

1. **Node.js ≥ 18 installieren** — LTS-Installer von [nodejs.org](https://nodejs.org) **oder** `brew install node`.
2. **Abhängigkeiten installieren** — im Projektordner: `npm install`
3. **Server starten** — `npm start`. Das Terminal zeigt ein Banner mit den Spiel-URLs.
   Fragt macOS „Soll node eingehende Verbindungen akzeptieren?“ → **Erlauben**.
4. **Spieler 1** (Host-Mac) öffnet `http://localhost:8080` in **Chrome** (empfohlen; Safari geht auch).
5. **Spieler 2** öffnet `http://<LAN-IP>:8080` auf seinem Mac — die LAN-IP steht im
   Server-Banner **und** im Lobby-Screen des Spiels. Beide müssen im **selben WLAN/Netz** sein.

**Allein testen?** Im Lobby-Screen **Solo-Training** starten (Trainingsgolem), in einem
zweiten Terminal `npm run bot` als Gegner laufen lassen — oder einfach zwei
Browser-Tabs auf demselben Mac öffnen.

Ausführliche Anleitung inkl. Troubleshooting: [docs/SETUP.md](docs/SETUP.md)

## Steuerung

| Eingabe | Aktion |
|---|---|
| **W A S D** | Bewegen |
| **Maus** | Umsehen / Zielen |
| **Shift** | Sprinten |
| **Leertaste** | Springen |
| **Linke Maustaste** | Primärangriff |
| **Rechte Maustaste** | Sekundärangriff (z. B. Feuerball halten zum Aufladen) |
| **Q / E** | Skill 1 / Skill 2 |
| **R** | Ultimate |
| **ESC** | Pause-Menü |

## Projektstruktur

```
FantasyArenaGame/
├── package.json                       Projekt-Metadaten, Scripts (start, bot, check)
├── server/server.js                   Statik-Server + WebSocket + Match-Autorität (Phasen, Schaden, Cooldowns)
├── shared/protocol.js                 Nachrichtentypen, Phasen, Port — von Client UND Server genutzt
├── shared/classes.js                  Klassen-/Fähigkeitsdaten, Balancing, Match-Regeln
├── test/bot.js                        Headless-Testclient: verbindet sich als zweiter Spieler
├── public/
│   ├── index.html                     Import-Map, Canvas, alle UI-Screens (DOM)
│   ├── css/ui.css                     Komplettes UI-Styling (Dark Fantasy)
│   └── js/
│       ├── main.js                    Bootstrap, Game-Kontext, Game-Loop, Phasen-Logik
│       ├── core/Input.js              Tastatur, Maus, Pointer-Lock
│       ├── net/NetworkClient.js       WebSocket-Client + Server-Zeit-Synchronisation
│       ├── player/PlayerController.js Lokale Bewegung/Physik (Kapsel, Sprung, Dash)
│       ├── player/CameraController.js Mouselook, FOV, Headbob, Shake-Anwendung
│       ├── player/RemotePlayer.js     Gegner-Interpolation + Rig + Nameplate (+ Trainings-Dummy)
│       ├── combat/CombatSystem.js     Fähigkeiten ausführen, Treffer melden, Server-Events verarbeiten
│       ├── combat/AbilitySystem.js    Cooldowns, Feuerball-Charge, Atem-Meter (lokal)
│       ├── combat/HealthSystem.js     Client-Spiegel der HP/Schilde
│       ├── combat/Projectiles.js      Projektil-Pool (eigene + gegnerische Geschosse)
│       ├── combat/MeleeHitbox.js      Kegel-/Kugel-Treffertests (pure Funktionen)
│       ├── world/Colliders.js         AABB-/Zylinder-Kollision, Raycast, Bodenhöhe
│       ├── world/ArenaManager.js      Arena-Registry — vorbereitet für weitere Arenen
│       ├── world/Arena.js             Arena „Ruinenburg“, prozedural gebaut
│       ├── characters/CharacterRig.js Prozedurale Charaktermodelle + First-Person-Viewmodels
│       ├── fx/VFXManager.js           Partikel, Explosionen, Ringe, Schilde, Feueratem
│       ├── fx/ScreenShake.js          Trauma-basiertes Kamera-Shake
│       ├── fx/PostFX.js               Bloom, Vignette, Grain, Damage-/Death-Effekte
│       ├── audio/AudioFeedback.js     Alle Sounds prozedural per WebAudio-Synth
│       └── ui/UIManager.js            Screens, HUD, Ansagen, Einstellungen
├── README.md                          Diese Datei
└── docs/                              Weitere Dokumentation (siehe unten)
```

## Dokumentation

| Datei | Inhalt |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Schritt-für-Schritt-Einrichtung, 2-Mac-Test, Troubleshooting, Performance-Tipps |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Der verbindliche Modul-Vertrag: alle öffentlichen APIs, Netzprotokoll, Balancing |
| [docs/ASSETS.md](docs/ASSETS.md) | Kostenlose Asset-Quellen (Modelle, Texturen, Sounds) + technische Integration |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Priorisierte nächste Schritte vom Prototyp zum hochwertigen Spiel |

## Voraussetzungen

- **Node.js ≥ 18** (für Server und Bot)
- Ein moderner Browser — **Chrome empfohlen**, Safari funktioniert ebenfalls
- Für 2-Spieler-Duelle: beide Rechner im **selben WLAN/Netz**
