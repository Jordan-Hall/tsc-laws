// Bundles film.src.js with three.js and timing.json into one self-contained film.html.
// Usage: THREE_DIR=<dir containing node_modules/three> node build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const threeDir = process.env.THREE_DIR ?? here;

const esbuild = createRequire(join(process.env.TOOLS_DIR ?? threeDir, 'noop.js'))('esbuild');
const threePath = join(threeDir, 'node_modules/three/build/three.module.js');
const timing = readFileSync(join(here, 'timing.json'), 'utf8');

const out = await esbuild.build({
  entryPoints: [join(here, 'film.src.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  write: false,
  target: 'chrome120',
  alias: { three: threePath },
  legalComments: 'none',
});
const js = out.outputFiles[0].text.replaceAll('</script', '<\\/script');
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>tslaws v1</title></head>
<body><script>window.__TIMING__=${JSON.stringify(JSON.parse(timing))};</script>
<script>${js}</script></body></html>
`;
writeFileSync(join(here, 'film.html'), html);
console.log('film.html', (html.length / 1024).toFixed(0), 'KiB');
