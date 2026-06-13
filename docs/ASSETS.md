# ASCHENTHRON — Asset-Quellen & Integration

ASCHENTHRON läuft komplett **ohne externe Assets**: Charaktere, Arena, Effekte und
sogar alle Sounds entstehen prozedural im Code. Das ist bewusst so — null Downloads,
null Lizenzfragen, sofort spielbar. Wenn du das Spiel später optisch und akustisch
aufwerten willst, findest du hier **kuratierte kostenlose Quellen** und die
**technische Anleitung**, wie Assets in den bestehenden Code kommen.

## Lizenz-Schnellkurs

- **CC0 (Public Domain):** Frei für alles, keine Namensnennung nötig. Die sorgenfreiste Wahl.
- **CC-BY:** Frei nutzbar, aber der Urheber **muss genannt** werden (z. B. im README oder einem Credits-Screen).
- **CC-BY-NC / CC-BY-ND:** Vorsicht — „NC“ verbietet kommerzielle Nutzung, „ND“ verbietet Bearbeitung. Für ein Hobbyprojekt oft ok, aber genau lesen.
- **Engine-gebundene Lizenzen vermeiden:** Assets aus dem **Unity Asset Store** oder **Unreal-Marktplatz/Fab** (auch hochwertige Pakete von Studios wie Kokku) sind lizenzrechtlich meist **an die jeweilige Engine gebunden** — sie dürfen in einem Three.js-Projekt **nicht** verwendet werden, selbst wenn sie „free“ heißen. Bleib bei den unten gelisteten engine-neutralen Quellen.

**Tipp:** Lege eine `CREDITS.md` an, sobald du das erste CC-BY-Asset einbaust —
nachträglich zusammensuchen ist mühsam.

## Empfohlene Quellen

### 3D-Modelle & Umgebungen

| Quelle | Lizenz | Empfehlung |
|---|---|---|
| **[Quaternius](https://quaternius.com)** | CC0 | Erste Wahl für dieses Projekt: Die Packs **„Ultimate Fantasy RPG“** und **„Modular Dungeon“** liefern Low-Poly-Charaktere, Waffen, Säulen, Mauern und Requisiten, die stilistisch perfekt zur Ruinenburg passen. Alles als GLTF/GLB verfügbar. |
| **[Kenney.nl](https://kenney.nl)** | CC0 | Riesige, konsistente Asset-Sammlungen. Sieh dir „Fantasy Town Kit“ und die „Prototype“-Texturen an; auch gut für UI-Icons und Partikeltexturen. |
| **[Sketchfab](https://sketchfab.com)** | gemischt | Beim Suchen den **Filter „Downloadable“ + Lizenz „CC0“ oder „CC-BY“** setzen. Viele hochwertige Einzelstücke (Statuen, Drachen, Schwerter) — Lizenz pro Modell prüfen, Download als GLB wählen. |
| **[OpenGameArt](https://opengameart.org)** | gemischt | Fundgrube für Modelle, Texturen und Sounds; Lizenzfilter (CC0/CC-BY) nutzen. Qualität schwankt — Bewertungen beachten. |

### Texturen & Beleuchtung

| Quelle | Lizenz | Empfehlung |
|---|---|---|
| **[Poly Haven](https://polyhaven.com)** | CC0 | Beste Adresse für **PBR-Texturen** (Stein, Mauerwerk, Erde — ideal für den Arenaboden) und **HDRIs** (Nachthimmel als Image-Based-Lighting). 1K/2K-Auflösung reicht für dieses Spiel völlig. |

### Charakter-Animationen

| Quelle | Lizenz | Empfehlung |
|---|---|---|
| **[Mixamo](https://www.mixamo.com)** | kostenlos (Adobe-Konto nötig) | Auto-Rigging + tausende Animationen (Laufen, Schwerthieb, Zauber, Block, Tod). Eigenes humanoides Modell hochladen oder einen Mixamo-Charakter nutzen, Animationen als FBX laden und z. B. in Blender zu GLB konvertieren. Für die Magierin und den Ritter ideal; der Drache braucht eher handgebaute Animationen. |

### Sounds & Musik

| Quelle | Lizenz | Empfehlung |
|---|---|---|
| **[freesound.org](https://freesound.org)** | gemischt | Beim Suchen den **CC0-Filter** aktivieren. Gute Suchbegriffe: „sword whoosh“, „fireball“, „dragon roar“, „stone impact“, „ui click“. Auf einheitliche Lautstärke achten (normalisieren). |
| **[Kenney.nl](https://kenney.nl/assets?q=audio)** | CC0 | Saubere, konsistente UI- und Impact-Sounds als fertige Packs. |
| **[OpenGameArt](https://opengameart.org)** | gemischt | Auch Musik (Ambient/Battle-Loops); Lizenzfilter nutzen. |

---

## Technische Integration

### Wohin mit den Dateien?

Lege Assets unter `public/assets/` ab, sinnvoll gruppiert:

```
public/assets/
├── models/      GLB-Modelle (Charaktere, Requisiten)
├── textures/    PBR-Texturen (jpg/png/webp)
└── audio/       Sounds (mp3/ogg)
```

> **Wichtig:** Der Statik-Server in `server/server.js` kennt laut Vertrag die Routen
> `/css/*` und `/js/*` (→ `public/...`). Bevor du Assets lädst, ergänze dort analog
> eine Route `/assets/*` → `public/assets/` und trage fehlende MIME-Types nach
> (`.glb → model/gltf-binary`, `.gltf → model/gltf+json`, `.mp3 → audio/mpeg`,
> `.ogg → audio/ogg`, `.webp → image/webp`, `.hdr → application/octet-stream`).

### GLTF-Modelle laden

Der `GLTFLoader` liegt bereits unter den Three.js-Addons (Import-Map ist
eingerichtet, kein zusätzliches Paket nötig):

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

// Modell asynchron laden und in die Szene hängen
const gltf = await loader.loadAsync('/assets/models/knight.glb');
const model = gltf.scene;
model.traverse((obj) => {
  if (obj.isMesh) { obj.castShadow = true; obj.receiveShadow = true; }
});
scene.add(model);

// Animationen abspielen (z. B. aus Mixamo)
const mixer = new THREE.AnimationMixer(model);
const idle = mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, 'Idle'));
idle.play();
// im Game-Loop: mixer.update(dt);
```

### Ein Rig in CharacterRig.js ersetzen

Die Charaktere entstehen in `public/js/characters/CharacterRig.js` über
`buildRig(classId, { firstPerson })`. Der Rest des Spiels (RemotePlayer,
Viewmodel) kennt **nur die Rückgabe-Schnittstelle** — solange du sie beibehältst,
musst du sonst nichts anfassen:

```js
// Vertrag: buildRig muss genau dieses Objekt liefern
// { group, update(dt), setMove(speed01), playAttack(slot),
//   setBlocking(b), setBreath(b), setCharging(c01), die(), reset() }
```

Vorgehen:

1. GLB einmalig laden (Modul-weiter Cache, damit nicht jeder Aufruf neu lädt)
   und in `group` (eine `THREE.Group`) hängen. Skalierung an die Kapselmaße der
   Klasse aus `shared/classes.js` anpassen (`height`, `scale`).
2. Einen `THREE.AnimationMixer` anlegen; in `update(dt)` → `mixer.update(dt)`.
3. Die Schnittstellen-Methoden auf Animationen abbilden: `setMove(speed01)`
   blendet Idle↔Run (z. B. `crossFadeTo`), `playAttack(slot)` spielt den passenden
   Angriffsclip einmalig, `die()`/`reset()` Todes-/Aufsteh-Pose, `setBlocking`,
   `setBreath`, `setCharging` schalten Posen oder Zusatzeffekte.
4. **Achtung asynchron:** `buildRig` ist synchron. Praktikabler Ansatz: sofort die
   leere `group` zurückgeben und das geladene Modell nachträglich einhängen
   (bis dahin bleibt das prozedurale Rig als Fallback sichtbar) — oder Modelle
   beim Spielstart vorladen, bevor das erste Rig gebaut wird.
5. `makeNameplate(name)` bleibt unverändert nutzbar.

### Texturen für die Arena

`public/js/world/Arena.js` erzeugt den Steinboden derzeit aus einer prozeduralen
Canvas-Textur. Ersetzen mit echten PBR-Texturen (z. B. Poly Haven „castle brick“):

```js
const texLoader = new THREE.TextureLoader();
const map = texLoader.load('/assets/textures/stone_diff_1k.jpg');
map.colorSpace = THREE.SRGBColorSpace;            // nur für Farb-Maps!
map.wrapS = map.wrapT = THREE.RepeatWrapping;
map.repeat.set(8, 8);

const normalMap = texLoader.load('/assets/textures/stone_nor_1k.jpg');
const roughnessMap = texLoader.load('/assets/textures/stone_rough_1k.jpg');
normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
normalMap.repeat.copy(map.repeat); roughnessMap.repeat.copy(map.repeat);

const floorMat = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap });
```

Normal- und Roughness-Maps bekommen **kein** `colorSpace = SRGBColorSpace`
(sie enthalten Daten, keine Farben). Die Collider in `Arena.js` bleiben unberührt —
Texturen sind rein visuell.

### Echte Sounds statt Synth in AudioFeedback.js

`public/js/audio/AudioFeedback.js` synthetisiert alle Sounds per WebAudio. Die
sauberste Aufwertung: **Schnittstelle behalten** (`play(id, opts)`, `loop(id, opts)`,
die verbindliche ID-Liste aus dem Vertrag), intern aber geladene `AudioBuffer`
abspielen statt Oszillatoren:

```js
// Beim Start: Dateien dekodieren (ctx = bestehender AudioContext)
const buffers = new Map();
async function loadSound(id, url) {
  const res = await fetch(url);
  const data = await res.arrayBuffer();
  buffers.set(id, await ctx.decodeAudioData(data));
}
await loadSound('sword_hit', '/assets/audio/sword_hit.mp3');

// In play(id, ...): Buffer bevorzugen, sonst Synth-Fallback
const buf = buffers.get(id);
if (buf) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = pitch;
  src.connect(gainNode);          // bestehende Lautstärke-/Pan-Kette weiterverwenden
  src.start();
} else {
  // bisheriger prozeduraler Synth als Fallback
}
```

So kannst du Sound für Sound ersetzen — alles, was noch keine Datei hat, klingt
weiter wie bisher. Halte Dateien kurz (< 2 s für Effekte), normalisiert und als
mp3/ogg (klein, von allen Ziel-Browsern unterstützt).
