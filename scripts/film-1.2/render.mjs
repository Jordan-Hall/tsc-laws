// Renders the standalone `tslaws 1.2` editorial kinetic keynote launch film (dark obsidian studio style).
// Usage:
//   PLAYWRIGHT_DIR=<dir> KOKORO_DIR=<dir> node scripts/film-1.2/render.mjs preview <workDir>
//   PLAYWRIGHT_DIR=<dir> KOKORO_DIR=<dir> node scripts/film-1.2/render.mjs all <workDir> <out.mp4> <out.gif>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const timing = JSON.parse(readFileSync(join(here, 'timing.json'), 'utf8'));
const FPS = timing.fps;
const TOTAL_FRAMES = Math.round(timing.durationSec * FPS);
const SR = 48000;
const [mode, workDir, outMp4, outGif] = process.argv.slice(2);
if (!mode || !workDir) throw new Error('usage: node render.mjs <preview|all> <workDir> [out.mp4] [out.gif]');
mkdirSync(workDir, { recursive: true });

// ---- 1. Kokoro TTS narration (am_michael) ----
async function renderVoice() {
  const voiceDir = join(workDir, 'voice');
  mkdirSync(voiceDir, { recursive: true });
  const { voice, speed: defaultSpeed, lines } = timing.voice;
  if (mode === 'all' && lines.every((l) => existsSync(join(voiceDir, `${l.id}.wav`)))) {
    console.log('Reusing existing voice WAVs in', voiceDir);
    return voiceDir;
  }
  const kokoroDir = process.env.KOKORO_DIR ?? 'D:/tmp/film-tools';
  const { KokoroTTS } = await import(pathToFileURL(createRequire(join(kokoroDir, 'x.js')).resolve('kokoro-js')).href);
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const durations = {};
  for (const line of lines) {
    const parts = [];
    for (const s of line.sentences) {
      const audio = await tts.generate(s.say ?? s.text, { voice, speed: s.speed ?? defaultSpeed });
      parts.push({ audio, gap: (s.gapMs ?? 320) / 1000 });
    }
    const rate = parts[0].audio.sampling_rate;
    const chunks = [];
    parts.forEach(({ audio, gap }, i) => {
      chunks.push(audio.audio);
      if (i < parts.length - 1) chunks.push(new Float32Array(Math.round(rate * gap)));
    });
    const all = new Float32Array(chunks.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    const raw = join(voiceDir, `${line.id}.raw.wav`);
    const target = join(voiceDir, `${line.id}.wav`);
    await new parts[0].audio.constructor(all, rate).save(raw);
    const filter = [
      'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.04',
      'areverse',
      'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08',
      'areverse',
      'highpass=f=65',
      'equalizer=f=180:t=q:w=1.0:g=1.8',
      'equalizer=f=3400:t=q:w=1.2:g=1.4',
      'acompressor=threshold=-22dB:ratio=2.4:attack=6:release=120:makeup=3',
    ].join(',');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af', filter, '-ar', String(SR), target]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target], {
      encoding: 'utf8',
    });
    durations[line.id] = Number(Number(probe.stdout).toFixed(3));
  }
  writeFileSync(join(voiceDir, 'durations.json'), JSON.stringify(durations, null, 2));
  console.log('Voice durations (s):', JSON.stringify(durations));
  // Verify each line fits cleanly inside its scene
  for (const line of lines) {
    const scene = timing.scenes.find((s) => s.id === line.id);
    if (scene) {
      const end = line.startSec + durations[line.id];
      const slack = scene.end - end;
      console.log(
        `  ${line.id.padEnd(8)} ${line.startSec.toFixed(1)}s -> ${end.toFixed(2)}s (scene ends ${scene.end}s, slack ${slack.toFixed(2)}s)`,
      );
    }
  }
  return voiceDir;
}

// ---- 2. Stills & Video capture ----
async function openBrowser() {
  const pwDir = process.env.PLAYWRIGHT_DIR ?? join(here, '..', '..');
  const { chromium } = createRequire(join(pwDir, 'noop.js'))('playwright-core');
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling'],
  });
}

async function openPage(browser) {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(pathToFileURL(join(here, 'film.html')).href);
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  return p;
}

async function renderStills() {
  const stillsDir = join(workDir, 'stills');
  mkdirSync(stillsDir, { recursive: true });
  const browser = await openBrowser();
  const p = await openPage(browser);
  const samples = [
    ['s1-hero', 3.5],
    ['s2-refine', 14.0],
    ['s3-proofs', 25.0],
    ['s4-browser', 35.6],
    ['s5-speed', 45.0],
    ['s6-cta', 50.0],
  ];
  for (const [name, sec] of samples) {
    const b64 = await p.evaluate((t) => window.grab(t, 0.94), sec);
    writeFileSync(join(stillsDir, `${name}.jpg`), Buffer.from(b64, 'base64'));
  }
  await browser.close();
  console.log('Rendered 6 preview stills in', stillsDir);
}

async function renderSilentVideo() {
  const silentPath = join(workDir, 'silent.mp4');
  const browser = await openBrowser();
  const workers = 4;
  const pages = await Promise.all(Array.from({ length: workers }, () => openPage(browser)));
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
      '20',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(FPS),
      '-movflags',
      '+faststart',
      silentPath,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const pending = new Map();
  let next = 0;
  let written = 0;
  const t0 = Date.now();
  async function work(p) {
    for (;;) {
      const f = next++;
      if (f >= TOTAL_FRAMES) return;
      while (f - written > workers * 8) await new Promise((r) => setTimeout(r, 4));
      const b64 = await p.evaluate((t) => window.grab(t, 0.95), f / FPS);
      pending.set(f, Buffer.from(b64, 'base64'));
    }
  }
  const flusher = (async () => {
    while (written < TOTAL_FRAMES) {
      if (pending.has(written)) {
        const buf = pending.get(written);
        pending.delete(written);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
        written++;
        if (written % 300 === 0)
          console.log(`frame ${written}/${TOTAL_FRAMES} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      } else await new Promise((r) => setTimeout(r, 4));
    }
    ff.stdin.end();
  })();
  await Promise.all([...pages.map(work), flusher]);
  await new Promise((r) => ff.on('close', r));
  await browser.close();
  console.log('Rendered', TOTAL_FRAMES, 'frames in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  return silentPath;
}

// ---- 3. Synthesize 112 BPM electronic keynote soundtrack + mix to -14 LUFS ----
function readWav(path) {
  const b = readFileSync(path);
  let p = 12;
  let fmt;
  let data;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ')
      fmt = {
        tag: b.readUInt16LE(p + 8),
        ch: b.readUInt16LE(p + 10),
        rate: b.readUInt32LE(p + 12),
        bits: b.readUInt16LE(p + 22),
      };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  const bytes = fmt.bits / 8;
  const n = Math.floor(data.length / bytes / fmt.ch);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = (i * fmt.ch + c) * bytes;
      s +=
        fmt.tag === 3
          ? data.readFloatLE(o)
          : fmt.bits === 16
            ? data.readInt16LE(o) / 32768
            : data.readInt32LE(o) / 2147483648;
    }
    mono[i] = s / fmt.ch;
  }
  return mono;
}

function writeWavStereo(path, l, r) {
  const n = l.length;
  const buf = Buffer.alloc(44 + n * 8);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 8, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 8, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(l[i], 44 + i * 8);
    buf.writeFloatLE(r[i], 48 + i * 8);
  }
  writeFileSync(path, buf);
}

function mixAndMux(voiceDir, silentPath, finalMp4, finalGif) {
  const total = Math.ceil(timing.durationSec * SR);
  const TAU = Math.PI * 2;
  const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));
  const sine = (f, t) => Math.sin(TAU * f * t);
  const sweep = (f0, f1, dur, t) => Math.sin(TAU * (f0 * t + ((f1 - f0) * t * t) / (2 * dur)));
  let seed = 98765;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const add = (bus, start, len, fn, gain = 1) => {
    const s0 = Math.round(start * SR);
    for (let i = 0; i < len * SR && s0 + i < bus.length; i++) bus[s0 + i] += fn(i / SR) * gain;
  };
  const lp = (coef) => {
    let y = 0;
    return (x) => (y += coef * (x - y));
  };

  const SFX = {
    whoosh: (b, t) => {
      const f = lp(0.08);
      add(b, t, 0.36, (x) => f(rnd()) * Math.sin((Math.PI * x) / 0.36) ** 1.5, 0.48);
      add(b, t, 0.32, (x) => sweep(140, 380, 0.32, x) * Math.sin((Math.PI * x) / 0.32), 0.14);
    },
    tick: (b, t) => add(b, t, 0.07, (x) => (sine(1568, x) + 0.4 * sine(3136, x)) * env(x, 0.001, 0.015), 0.32),
    click: (b, t) => {
      const f = lp(0.55);
      add(b, t, 0.035, (x) => f(rnd()) * env(x, 0.0005, 0.006), 0.5);
      add(b, t, 0.06, (x) => sine(1320, x) * env(x, 0.0006, 0.01), 0.35);
    },
    alert: (b, t) => {
      add(b, t, 0.28, (x) => (sine(293.66, x) + sine(311.13, x)) * env(x, 0.003, 0.09), 0.36);
    },
    rise: (b, t) => add(b, t, 0.55, (x) => sweep(260, 880, 0.55, x) * Math.sin((Math.PI * x) / 0.55), 0.24),
    chime: (b, t) => {
      for (const [fr, g] of [
        [587.33, 0.45],
        [880.0, 0.35],
        [1174.66, 0.22],
      ])
        add(b, t, 1.4, (x) => sine(fr, x) * env(x, 0.004, 0.38), g * 0.6);
    },
  };

  const sfx = new Float32Array(total);
  for (const h of timing.hits) SFX[h.sound](sfx, h.sec);

  const voice = new Float32Array(total);
  for (const l of timing.voice.lines) {
    const w = readWav(join(voiceDir, `${l.id}.wav`));
    const s0 = Math.round(l.startSec * SR);
    for (let i = 0; i < w.length && s0 + i < voice.length; i++) voice[s0 + i] += w[i];
  }

  // Modern 112 BPM electronic keynote bed: Dm9 -> Bbmaj7 -> Fmaj7 -> Csus4
  const beat = 60 / timing.bpm;
  const bar = beat * 4;
  const CH = [
    [293.66, 349.23, 440.0, 523.25],
    [233.08, 293.66, 349.23, 440.0],
    [261.63, 349.23, 440.0, 523.25],
    [261.63, 349.23, 392.0, 523.25],
  ];
  const ROOT = [73.42, 58.27, 87.31, 65.41];
  const musicL = new Float32Array(total);
  const musicR = new Float32Array(total);
  const outroT = timing.durationSec - 4.0;
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    const inOutro = t >= outroT;
    const bi = Math.floor(t / bar);
    const ci = inOutro ? 2 : bi % 4;
    const tb = t - bi * bar;
    const padEnv = inOutro ? Math.exp(-(t - outroT) / 1.8) : 0.65 + 0.35 * Math.sin((Math.PI * tb) / bar);
    let padL = 0;
    let padR = 0;
    for (const f of CH[ci]) {
      padL += Math.sin(TAU * f * t) * 0.45 + Math.sin(TAU * f * 1.004 * t) * 0.35;
      padR += Math.sin(TAU * f * t) * 0.45 + Math.sin(TAU * f * 0.996 * t) * 0.35;
    }
    padL *= padEnv * 0.05;
    padR *= padEnv * 0.05;
    // Tight 8th-note sub-bass pulse
    const eighth = beat / 2;
    const bt = tb % beat;
    const pulse = inOutro ? 0 : Math.sin(TAU * ROOT[ci] * 2 * t) * env(bt, 0.008, 0.22) * 0.14;
    // Crisp glassy synth arp on 8ths
    const ei = Math.floor(t / eighth);
    const te = t - ei * eighth;
    const noteIdx = [0, 2, 1, 3, 2, 1, 3, 2][ei % 8];
    const arp =
      inOutro && t > outroT + 0.4
        ? 0
        : Math.sin(TAU * CH[ci][noteIdx] * 2 * t) * env(te, 0.003, 0.09) * 0.055 * (ei % 2 === 0 ? 1 : 0.65);
    const fi = Math.min(1, t / 1.4);
    const fo = Math.min(1, Math.max(0, (timing.durationSec - t) / 1.2));
    musicL[i] = (padL + pulse + arp * 1.05) * fi * fo;
    musicR[i] = (padR + pulse + arp * 0.95) * fi * fo;
  }

  // Smooth sidechain duck under voice
  const duck = new Float32Array(total);
  let e = 0;
  const att = 1 - Math.exp(-1 / (0.035 * SR));
  const rel = 1 - Math.exp(-1 / (0.4 * SR));
  for (let i = 0; i < total; i++) {
    const a = Math.min(1, Math.abs(voice[i]) * 6);
    e += (a > e ? att : rel) * (a - e);
    duck[i] = 1 - 0.58 * Math.min(1, e);
  }
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    L[i] = voice[i] * 1.0 + sfx[i] * 0.5 + musicL[i] * duck[i] * 1.5;
    R[i] = voice[i] * 1.0 + sfx[i] * 0.5 + musicR[i] * duck[i] * 1.5;
  }
  const premix = join(workDir, 'premix.wav');
  writeWavStereo(premix, L, R);

  const run = (args) => {
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stderr;
  };
  const target = 'I=-14:TP=-2.5:LRA=9';
  const log = run([
    '-hide_banner',
    '-nostats',
    '-i',
    premix,
    '-af',
    `loudnorm=${target}:print_format=json`,
    '-f',
    'null',
    '-',
  ]);
  const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
  const filt = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,alimiter=limit=0.708:level=disabled:attack=2:release=40,apad=whole_dur=${timing.durationSec}`;
  run([
    '-y',
    '-hide_banner',
    '-i',
    silentPath,
    '-i',
    premix,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-af',
    filt,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    String(SR),
    '-t',
    String(timing.durationSec),
    '-movflags',
    '+faststart',
    finalMp4,
  ]);
  console.log('Mixed', finalMp4, 'measured before', m.input_i, 'LUFS', m.input_tp, 'dBTP');

  if (finalGif) {
    run([
      '-y',
      '-v',
      'error',
      '-i',
      finalMp4,
      '-vf',
      'fps=5,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      finalGif,
    ]);
    console.log('Generated GIF', finalGif);
  }
}

if (mode === 'preview') {
  await Promise.all([renderVoice(), renderStills()]);
} else if (mode === 'all') {
  const [voiceDir, silentPath] = await Promise.all([renderVoice(), renderSilentVideo()]);
  mixAndMux(voiceDir, silentPath, outMp4, outGif);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
