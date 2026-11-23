// Renders film.html frame by frame on the GPU (headless Chrome via Playwright) into silent H.264.
// Usage:
//   node render.mjs stills <outDir> <t0> <t1> <step>      JPEG stills for review
//   node render.mjs video  <out.mp4> [workers]            frames 0..N-1 piped into ffmpeg
//   node render.mjs frame  <out.jpg> <frame> [cold]       one frame, optionally in a fresh page
// PLAYWRIGHT_DIR points at a directory that has playwright-core in node_modules.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR ?? here, 'noop.js'))('playwright-core');
const timing = JSON.parse(readFileSync(join(here, 'timing.json'), 'utf8'));
const FPS = timing.fps;
const N = timing.frames;
const url = pathToFileURL(join(here, 'film.html')).href;
const [mode, out, a, b, c] = process.argv.slice(2);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
async function page() {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  p.on('console', (m) => (m.type() === 'error' ? console.error('console', m.text()) : null));
  await p.goto(url);
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  return p;
}
const grab = (p, f, q = 0.95) =>
  p.evaluate(([t, quality]) => window.grab(t, quality), [f / FPS, q]).then((s) => Buffer.from(s, 'base64'));

if (mode === 'stills') {
  mkdirSync(out, { recursive: true });
  const p = await page();
  const t0 = Number(a);
  const t1 = Number(b);
  const step = Number(c);
  let i = 0;
  for (let t = t0; t <= t1 + 1e-9; t += step, i++) {
    const f = Math.round(t * FPS);
    writeFileSync(join(out, `s${String(f).padStart(5, '0')}.jpg`), await grab(p, f, 0.92));
  }
  console.log('stills', i);
} else if (mode === 'frame') {
  const p = await page();
  const frame = Number(a);
  if (b !== 'cold') await grab(p, Math.max(0, frame - 1));
  writeFileSync(out, await grab(p, frame, 1));
} else if (mode === 'video') {
  const workers = Number(a ?? 3);
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(FPS),
      '-c:v',
      'mjpeg',
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-preset',
      'slow',
      '-crf',
      '14',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(FPS),
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const pages = await Promise.all(Array.from({ length: workers }, page));
  const pending = new Map();
  let next = 0;
  let written = 0;
  const t0 = Date.now();
  async function work(p) {
    for (;;) {
      const f = next++;
      if (f >= N) return;
      while (f - written > workers * 6) await new Promise((r) => setTimeout(r, 5));
      pending.set(f, await grab(p, f, 0.97));
    }
  }
  const flusher = (async () => {
    while (written < N) {
      if (pending.has(written)) {
        const buf = pending.get(written);
        pending.delete(written);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
        written++;
        if (written % 240 === 0) console.log(`frame ${written}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } else await new Promise((r) => setTimeout(r, 5));
    }
    ff.stdin.end();
  })();
  await Promise.all([...pages.map(work), flusher]);
  await new Promise((r) => ff.on('close', r));
  console.log('done', N, 'frames', ((Date.now() - t0) / 1000).toFixed(0), 's');
} else if (mode === 'mascot') {
  // mascot width in pixels at the middle of every shot
  const p = await page();
  const res = await p.evaluate(() =>
    window
      .shotList()
      .map((s) => ({ id: s.id, frame: s.frame, ...window.mascotWidthPx((s.frame + s.frames / 2) / 60) })),
  );
  writeFileSync(out, JSON.stringify(res, null, 1));
  for (const r of res) console.log(String(r.id).padEnd(10), r.frame, r.px.toFixed(0), r.visiblePx.toFixed(0));
}
await browser.close();
