/**
 * check-bundle.mjs — Statischer Bundle-Check für den Client-Code.
 * Bildet das URL-Mapping des Servers nach (/shared/ → shared/, three extern),
 * damit esbuild den gesamten Modulgraphen auflösen und auf Syntax-/Import-/
 * Referenzfehler prüfen kann, ohne three tatsächlich zu bündeln.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.join(ROOT, 'shared');

// Plugin: three/Addons extern, /shared- und ../shared-Pfade auf shared/ umbiegen.
const serverMapping = {
  name: 'aschenthron-server-mapping',
  setup(b) {
    b.onResolve({ filter: /^three(\/.*)?$/ }, () => ({ external: true }));
    b.onResolve({ filter: /shared\/[\w.-]+\.js$/ }, (args) => {
      const file = args.path.split('shared/').pop();
      return { path: path.join(SHARED, file) };
    });
  },
};

try {
  const result = await build({
    entryPoints: [path.join(ROOT, 'public/js/main.js')],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [serverMapping],
  });
  if (result.errors && result.errors.length) {
    console.error('Bundle-Check FEHLGESCHLAGEN:', result.errors);
    process.exit(1);
  }
  console.log('Bundle-Check OK — alle Client-Module aufgelöst und geparst.');
} catch (err) {
  console.error('Bundle-Check FEHLGESCHLAGEN:\n');
  for (const e of err.errors || [{ text: err.message }]) {
    const loc = e.location ? ` (${e.location.file}:${e.location.line}:${e.location.column})` : '';
    console.error('  • ' + e.text + loc);
  }
  process.exit(1);
}
