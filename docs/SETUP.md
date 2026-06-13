# ASCHENTHRON — Setup-Anleitung

Diese Anleitung führt dich Schritt für Schritt von „leerer Mac“ bis „laufendes
1v1-Duell auf zwei Rechnern“. Du brauchst keine Vorkenntnisse mit Node.js —
nur ein Terminal und ein paar Minuten.

## 1. Node.js installieren

ASCHENTHRON braucht **Node.js Version 18 oder neuer**. Es gibt zwei einfache Wege:

**Variante A — Installer (empfohlen für Einsteiger):**

1. Öffne [nodejs.org](https://nodejs.org).
2. Lade die **LTS-Version** herunter (der links/grün hervorgehobene Button).
3. Öffne die `.pkg`-Datei und klicke dich durch den Installer.

**Variante B — Homebrew (falls du `brew` bereits nutzt):**

```bash
brew install node
```

**Prüfen, ob alles klappt** — öffne das Terminal (Programme → Dienstprogramme → Terminal) und tippe:

```bash
node -v
```

Es sollte etwas wie `v18.x.x`, `v20.x.x` oder neuer erscheinen. Zeigt die Zahl
nach dem `v` mindestens **18**, bist du startklar.

## 2. Projekt installieren

Wechsle im Terminal in den Projektordner und installiere die Abhängigkeiten
(das lädt Three.js und die WebSocket-Bibliothek herunter — einmalig nötig):

```bash
cd /Pfad/zum/FantasyArenaGame
npm install
```

## 3. Server starten

```bash
npm start
```

Der Server startet und zeigt im Terminal ein **Banner mit den Spiel-URLs**, etwa:

```
  ASCHENTHRON läuft!
  Spieler 1 (dieser Mac):  http://localhost:8080
  Spieler 2 (im WLAN):     http://192.168.1.42:8080
```

> **macOS-Firewall:** Beim ersten `npm start` fragt macOS eventuell:
> *„Soll node eingehende Verbindungen akzeptieren?“* → **Erlauben** klicken!
> Sonst kann Spieler 2 nicht beitreten. Hast du versehentlich „Nicht erlauben“
> gewählt: **Systemeinstellungen → Netzwerk → Firewall** öffnen und `node`
> dort eingehende Verbindungen erlauben (oder die Firewall-Option für `node` entfernen
> und den Server neu starten, damit die Frage erneut erscheint).

Der Server läuft, solange das Terminal-Fenster offen ist. Beenden: `Ctrl+C`.

## 4. Spieler 1 — auf dem Host-Mac spielen

Öffne **Chrome** (empfohlen — beste Performance; **Safari funktioniert auch**)
und gehe auf:

```
http://localhost:8080
```

Du landest im Hauptmenü: Namen eingeben, „Arena betreten“ — fertig.

## 5. Spieler 2 — zweiter Mac im selben Netz

1. Stelle sicher, dass **beide Macs im selben WLAN/Netz** sind (gleicher Router!).
2. Spieler 2 öffnet im Browser:

```
http://<LAN-IP>:8080
```

Die `<LAN-IP>` (z. B. `192.168.1.42`) findest du an **zwei Stellen**:

- im **Server-Banner** im Terminal (Schritt 3), und
- im **Lobby-Screen** des Spiels — dort wird die Join-URL für Spieler 2 groß angezeigt.

Sobald beide verbunden sind, geht es automatisch in die **Klassenwahl**: Klasse
aussuchen (Magierin, Ritter oder Drache), „Bereit“ klicken — der Countdown startet.

## 6. Allein testen (ohne zweiten Mac)

Drei Möglichkeiten:

| Methode | So geht's | Gut für |
|---|---|---|
| **Solo-Training** | Im Lobby-Screen den Solo-Button klicken — ein Trainingsgolem (Dummy) erscheint in der Arenamitte | Fähigkeiten ausprobieren, Schaden testen |
| **Bot-Gegner** | Zweites Terminal öffnen, im Projektordner `npm run bot` ausführen — der Bot tritt als zweiter Spieler bei | Echtes Match-Gefühl, Phasen testen |
| **Zwei Browser-Tabs** | Auf demselben Mac zweimal `http://localhost:8080` öffnen | Netzwerk-/UI-Verhalten beider Seiten sehen |

Der Bot wählt standardmäßig den Ritter; mit Argumenten geht auch anderes,
z. B. `node test/bot.js ws://localhost:8080 dragon`.

## 7. Steuerung (Kurzreferenz)

**WASD** bewegen · **Maus** umsehen · **Shift** sprinten · **Leertaste** springen ·
**LMB/RMB** Angriffe · **Q/E** Skills · **R** Ultimate · **ESC** Pause.

Gespielt wird **Best of 3**; eine Runde dauert maximal **90 Sekunden** — bei
Zeitablauf gewinnt, wer prozentual mehr HP übrig hat.

> **Pointer-Lock:** Das Spiel „fängt“ deine Maus, sobald der Kampf beginnt und du
> ins Spielfenster klickst (der Mauszeiger verschwindet — das ist gewollt).
> **ESC** gibt die Maus frei und öffnet das Pause-Menü; ein Klick auf „Fortsetzen“
> fängt sie wieder ein. Browser erlauben das erneute Einfangen manchmal erst nach
> ca. einer Sekunde — kurz warten und nochmal klicken.

## 8. Troubleshooting

| Problem | Wahrscheinliche Ursache | Lösung |
|---|---|---|
| Spieler 2 kann die Seite nicht öffnen | macOS-Firewall blockiert `node` | Server neu starten und die Verbindungsfrage **erlauben**; oder Systemeinstellungen → Netzwerk → Firewall → eingehende Verbindungen für `node` erlauben |
| Spieler 2 kann die Seite nicht öffnen (Firewall ok) | Die Macs sind **nicht im selben Netz** (z. B. einer im Gäste-WLAN, einer im Hotspot) | Beide Macs ins selbe WLAN bringen; Gastnetzwerke isolieren Geräte oft voneinander |
| Welche IP hat mein Mac? | — | Steht im **Server-Banner** und im **Lobby-Screen**; alternativ im Terminal: `ipconfig getifaddr en0` |
| `npm start` bricht ab: „address already in use“ / „EADDRINUSE“ | Port 8080 ist schon belegt (anderer Server, alter Spiel-Prozess) | Alten Prozess beenden (`Ctrl+C` im alten Terminal) — oder den Port ändern: `PORT` in `shared/protocol.js` anpassen (z. B. `8090`) und Server neu starten; beide Spieler nutzen dann den neuen Port in der URL |
| Maus dreht die Kamera nicht | Pointer-Lock nicht aktiv | Ins Spielfenster klicken; nach ESC kurz warten und erneut klicken |
| „Server voll“-Meldung | Es sind schon 2 Spieler verbunden (max. 2) | Überzähligen Tab/Bot schließen; vergessene Tabs zählen mit! |
| Seite lädt, bleibt aber schwarz/leer | Veralteter Browser oder Konsolen-Fehler | Chrome aktualisieren; Browser-Konsole prüfen (Cmd+Alt+J in Chrome) |
| Ruckler, niedrige Framerate | Rechner am Limit | Siehe Performance-Tipps unten |
| `node -v` zeigt Version < 18 | Alte Node-Installation | Neue LTS von nodejs.org installieren bzw. `brew upgrade node` |

## 9. Performance-Tipps

- **Qualität im Menü senken:** Im Hauptmenü bzw. Pause-Menü die Qualitätsstufe
  auf „Mittel“ oder „Niedrig“ stellen — das reduziert Auflösung und schaltet
  Bloom ab, was auf älteren Macs viel bringt.
- **Chrome verwenden:** Chrome liefert in diesem Spiel die stabilste
  WebGL-Performance; Safari funktioniert, kann aber langsamer sein.
- **Andere Tabs und Programme schließen:** Browser-Tabs mit Video/Animationen
  und schwere Programme im Hintergrund kosten spürbar Frames — vor dem Duell
  aufräumen lohnt sich.
- **Netzteil anschließen:** MacBooks drosseln im Akkubetrieb teils die GPU.
