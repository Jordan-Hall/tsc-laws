// End-to-end launcher for the tslaws 1.2 Blender 4.3 Cycles OptiX 3D + live-footage launch film.
// Usage:
//   node scripts/film-1.2/render.mjs [voice|capture|preview|render|mix|all] [outDir] [mp4Out] [gifOut]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureAll } from './capture.mjs';
import { mixAndMaster } from './mix.mjs';
import { generateVoice } from './voice.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const timingPath = join(__dirname, 'timing.json');
const scenePy = join(__dirname, 'scene.py');

function findBlender() {
  if (process.env.BLENDER && existsSync(process.env.BLENDER)) return process.env.BLENDER;
  const candidates = [
    'D:\\tmp\\blender\\blender-4.3.2-windows-x64\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
    '/usr/bin/blender',
    '/Applications/Blender.app/Contents/MacOS/Blender',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'blender';
}

function runBlender(args) {
  const bin = findBlender();
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastLog = 0;
    child.stdout.on('data', (d) => {
      const s = d.toString();
      for (const line of s.split(/\r?\n/)) {
        if (/Saved:|Preview |Rendered frames|Cycles GPU/.test(line)) {
          const now = Date.now();
          if (!/Saved:/.test(line) || now - lastLog > 4000) {
            console.log(line);
            lastLog = now;
          }
        }
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s && !/Warning: Path/.test(s)) console.error(s);
    });
    child.on('close', (code) => (code === 0 ? resolveP() : rejectP(new Error(`Blender exited ${code}`))));
  });
}

async function renderFullParallel(outDir, opts) {
  const timing = JSON.parse(readFileSync(timingPath, 'utf8'));
  const fps = opts.fps ?? timing.fps;
  const totalFrames = Math.round(timing.scenes.at(-1).endSec * fps);
  const workers = Math.max(1, opts.workers ?? 2);

  // Build & save .blend once first so workers don't race on save_as_mainfile
  const chunks = [];
  const per = Math.ceil(totalFrames / workers);
  for (let i = 0; i < workers; i++) {
    const start = i * per + 1;
    const end = Math.min(totalFrames, (i + 1) * per);
    if (start <= end) chunks.push({ start, end });
  }
  console.log(
    `Launching ${chunks.length} Blender ${opts.engine} worker(s) for ${totalFrames} frames @ ${fps}fps (samples=${opts.samples}, scale=${opts.resScale}%)...`,
  );
  const t0 = Date.now();
  await Promise.all(
    chunks.map((c) =>
      runBlender([
        '--background',
        '--python',
        scenePy,
        '--',
        '--out',
        outDir,
        '--timing',
        timingPath,
        '--mode',
        'full',
        '--engine',
        opts.engine,
        '--samples',
        String(opts.samples),
        '--res-scale',
        String(opts.resScale),
        '--fps',
        String(fps),
        '--start',
        String(c.start),
        '--end',
        String(c.end),
      ]),
    ),
  );
  console.log(`All ${totalFrames} Blender frames rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const cmd = process.argv[2] ?? 'all';
const outDir = resolve(process.argv[3] ?? join(process.env.TEMP ?? '/tmp', 'film-1.2-blender'));
const finalMp4 = resolve(process.argv[4] ?? join(__dirname, '..', '..', 'docs', 'media', 'tslaws-1.2-launch.mp4'));
const finalGif = resolve(process.argv[5] ?? join(__dirname, '..', '..', 'docs', 'media', 'tslaws-1.2-launch.gif'));
const engine = process.env.BLENDER_ENGINE ?? 'CYCLES';
const samples = Number(process.env.BLENDER_SAMPLES ?? 14);
const resScale = Number(process.env.BLENDER_RES_SCALE ?? 75);
const workers = Number(process.env.BLENDER_WORKERS ?? 2);

mkdirSync(outDir, { recursive: true });

if (cmd === 'voice' || cmd === 'all') {
  if (!existsSync(join(outDir, 'voice', 'manifest.json'))) await generateVoice(outDir);
  else console.log(`Reusing existing voiceover in ${join(outDir, 'voice')}`);
}
if (cmd === 'capture' || cmd === 'all') {
  if (!existsSync(join(outDir, 'clips', 'clip-browser-3.mp4'))) await captureAll(outDir);
  else console.log(`Reusing existing captured live clips in ${join(outDir, 'clips')}`);
}
if (cmd === 'preview') {
  const r = spawnSync(
    findBlender(),
    [
      '--background',
      '--python',
      scenePy,
      '--',
      '--out',
      outDir,
      '--timing',
      timingPath,
      '--mode',
      'preview',
      '--engine',
      engine,
      '--samples',
      String(samples),
      '--res-scale',
      String(resScale),
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (cmd === 'render' || cmd === 'all') {
  await renderFullParallel(outDir, { engine, samples, resScale, workers });
}
if (cmd === 'mix' || cmd === 'all') {
  mixAndMaster(outDir, finalMp4, finalGif);
}
