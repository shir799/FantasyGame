/**
 * PostFX — EffectComposer-Kette: RenderPass → UnrealBloomPass → OutputPass →
 * eigener Grade-Pass (Vignette, animiertes Grain, chromatische Aberration,
 * Damage-Puls, Death-Fade). Konfiguriert Renderer-Tonemapping und Schatten.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Farb-/Stimmungs-Pass NACH OutputPass (arbeitet im Display-Farbraum)
const GradeShader = {
  name: 'AschenthronGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.24 },
    uGrain: { value: 0.035 },
    uAberration: { value: 0.0016 },
    uDamage: { value: 0 },
    uDeath: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uDamage;
    uniform float uDeath;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 d = vUv - 0.5;
      float dist = length(d) * 1.41421356;

      // Chromatische Aberration: radialer Kanalversatz, aussen staerker
      vec2 off = d * (uAberration * (0.5 + dist * dist * 2.0));
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = base.g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      // Vignette
      col *= 1.0 - uVignette * smoothstep(0.45, 1.05, dist);

      // Damage-Puls: roter Rand
      float rim = smoothstep(0.35, 0.95, dist);
      col = mix(col, vec3(0.66, 0.05, 0.07), clamp(rim * uDamage, 0.0, 1.0) * 0.9);

      // Death-Fade: Entsaettigung + Abdunkeln
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum) * 0.4, clamp(uDeath, 0.0, 1.0));

      // Animiertes Grain
      float g = hash(vUv * 1357.0 + vec2(uTime * 61.7, uTime * 123.3));
      col += (g - 0.5) * uGrain;

      gl_FragColor = vec4(col, base.a);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    // Renderer-Grundeinstellungen laut Vertrag
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const size = renderer.getSize(new THREE.Vector2());
    this._w = Math.max(1, size.x);
    this._h = Math.max(1, size.y);

    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(this._w, this._h), 0.55, 0.6, 0.85);
    this.outputPass = new OutputPass();
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
    this.composer.addPass(this.gradePass);

    this._deathTarget = 0;
    this.setQuality('medium');
  }

  /** Pro Frame rendern; Uniform-Animationen (Grain-Zeit, Damage-Abkling, Death-Lerp). */
  render(dt) {
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.016;
    const u = this.gradePass.uniforms;
    u.uTime.value = (u.uTime.value + dt) % 1000;
    // Damage-Puls klingt in 0.4 s linear ab
    u.uDamage.value = Math.max(0, u.uDamage.value - dt * 2.5);
    // Death-Fade lerpt sanft Richtung Zielwert
    u.uDeath.value += (this._deathTarget - u.uDeath.value) * Math.min(1, dt * 3.5);
    this.composer.render(dt);
  }

  /** Render-Targets an neue Groesse anpassen. Camera-Aspect macht main.js. */
  resize(w, h) {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    this._w = w;
    this._h = h;
    this.composer.setSize(w, h);
  }

  /** Qualitaet: low = kein Bloom + pixelRatio 1; medium ≤ 1.5; high ≤ 2. */
  setQuality(q) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    let pr = 1;
    if (q === 'medium') pr = Math.min(dpr, 1.5);
    else if (q === 'high') pr = Math.min(dpr, 2);
    this.bloomPass.enabled = q !== 'low';
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this._w, this._h);
  }

  /** Rote Rand-Vignette aufblitzen lassen (klingt in render() ab). */
  damagePulse(strength01) {
    const s = Number.isFinite(strength01) ? THREE.MathUtils.clamp(strength01, 0, 1) : 0;
    const u = this.gradePass.uniforms.uDamage;
    u.value = Math.max(u.value, s);
  }

  /** Entsaettigen/Abdunkeln ein- oder ausblenden (Tod/Respawn). */
  deathFade(on) {
    this._deathTarget = on ? 1 : 0;
  }
}
