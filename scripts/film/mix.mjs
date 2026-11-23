// Builds the soundtrack for the film and muxes it onto the silent render.
// Music and hit effects are synthesised here from timing.json; the voice lines come from voice.mjs.
// Every hit is placed one frame after its picture (timing.json "hits"), the voice at its line frame.
// Usage: node mix.mjs <voiceDir> <silent.mp4> <out.mp4> [workDir]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const timing = JSON.parse(readFileSync(join(here, 'timing.json'), 'utf8'));
const [voiceDir, silent, out, workArg] = process.argv.slice(2);
const work = workArg ?? dirname(out);
mkdirSync(work, { recursive: true });
const SR = 48000;
const FPS = timing.fps;
const total = Math.ceil((timing.frames / FPS) * SR);
const mixBus = (n = total) => new Float32Array(n);

// ---------- wav io ----------
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
  if (fmt.rate !== SR) throw new Error(`${path}: expected ${SR} Hz, got ${fmt.rate}`);
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

// ---------- synthesis helpers ----------
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const TAU = Math.PI * 2;
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));
function add(bus, start, len, fn, gain = 1) {
  const s0 = Math.round(start * SR);
  for (let i = 0; i < len * SR && s0 + i < bus.length; i++) bus[s0 + i] += fn(i / SR) * gain;
}
const sine = (f, t) => Math.sin(TAU * f * t);
const sweep = (f0, f1, dur, t) => Math.sin(TAU * (f0 * t + ((f1 - f0) * t * t) / (2 * dur)));
function lp(coef) {
  let y = 0;
  return (x) => (y += coef * (x - y));
}
const SFX = {
  land: (b, t) => {
    add(b, t, 0.25, (x) => sweep(150, 55, 0.2, x) * env(x, 0.002, 0.07), 0.9);
    const f = lp(0.2);
    add(b, t, 0.05, (x) => f(rnd()) * env(x, 0.001, 0.012), 0.3);
  },
  tap: (b, t) => {
    add(b, t, 0.12, (x) => (sine(820, x) + 0.5 * sine(1640, x)) * env(x, 0.001, 0.018), 0.5);
    const f = lp(0.5);
    add(b, t, 0.03, (x) => f(rnd()) * env(x, 0.0005, 0.006), 0.35);
  },
  gavel: (b, t) => {
    add(b, t, 0.2, (x) => (sine(520, x) + 0.4 * sine(1180, x)) * env(x, 0.001, 0.03), 0.6);
    add(b, t, 0.1, (x) => sweep(180, 90, 0.1, x) * env(x, 0.001, 0.03), 0.5);
  },
  paper: (b, t) => {
    const f = lp(0.12);
    add(b, t, 0.3, (x) => f(rnd()) * Math.sin((Math.PI * x) / 0.3) ** 2, 0.55);
  },
  chime: (b, t) => {
    for (const [fr, g] of [
      [698.46, 0.5],
      [1046.5, 0.35],
      [1396.9, 0.18],
    ])
      add(b, t, 1.6, (x) => sine(fr, x) * env(x, 0.004, 0.45), g * 0.7);
  },
  hum: (b, t) =>
    add(
      b,
      t,
      0.9,
      (x) => (sine(110 + 40 * x, x) + 0.4 * sine(220 + 80 * x, x)) * Math.sin((Math.PI * x) / 0.9) ** 2,
      0.35,
    ),
  clack: (b, t) => {
    for (const d of [0, 0.07]) {
      const f = lp(0.6);
      add(b, t + d, 0.04, (x) => f(rnd()) * env(x, 0.0005, 0.006), 0.6);
      add(b, t + d, 0.05, (x) => sine(240, x) * env(x, 0.001, 0.012), 0.4);
    }
  },
  whirr: (b, t) =>
    add(
      b,
      t,
      0.6,
      (x) => ((((sweep(180, 420, 0.6, x) % 1) + 1) % 1) - 0.5) * 0.5 * Math.sin((Math.PI * x) / 0.6),
      0.25,
    ),
  stamp: (b, t) => {
    add(b, t, 0.3, (x) => sweep(120, 60, 0.25, x) * env(x, 0.001, 0.07), 0.9);
    const f = lp(0.3);
    add(b, t, 0.08, (x) => f(rnd()) * env(x, 0.001, 0.02), 0.5);
  },
  stampSoft: (b, t) => {
    add(b, t, 0.25, (x) => sweep(130, 70, 0.2, x) * env(x, 0.002, 0.05), 0.55);
  },
  stampBad: (b, t) => {
    SFX.stamp(b, t);
    add(b, t, 0.6, (x) => (sine(196, x) + sine(207.7, x)) * env(x, 0.002, 0.2), 0.3);
  },
  stampCert: (b, t) => {
    SFX.stamp(b, t);
    add(b, t + 0.03, 1.0, (x) => sine(1046.5, x) * env(x, 0.003, 0.3), 0.25);
  },
  print: (b, t) => {
    for (let k = 0; k < 24; k++) {
      const f = lp(0.5);
      add(b, t + k * 0.035, 0.02, (x) => f(rnd()) * env(x, 0.0003, 0.004), 0.25);
    }
  },
  tick: (b, t) => add(b, t, 0.08, (x) => sine(1760, x) * env(x, 0.0008, 0.016), 0.4),
  rise: (b, t) => add(b, t, 0.5, (x) => sweep(320, 920, 0.5, x) * Math.sin((Math.PI * x) / 0.5), 0.3),
  lock: (b, t) => {
    add(b, t, 0.08, (x) => sine(2400, x) * env(x, 0.0005, 0.01), 0.45);
    add(b, t + 0.06, 0.2, (x) => sweep(200, 90, 0.2, x) * env(x, 0.001, 0.05), 0.6);
  },
  scribble: (b, t) => {
    const f = lp(0.35);
    add(b, t, 0.55, (x) => f(rnd()) * (0.5 + 0.5 * Math.sin(x * 70)) * Math.sin((Math.PI * x) / 0.55), 0.4);
  },
  pop: (b, t) => add(b, t, 0.12, (x) => sweep(700, 220, 0.1, x) * env(x, 0.001, 0.025), 0.5),
  bonk: (b, t) => {
    add(b, t, 0.3, (x) => sweep(230, 110, 0.25, x) * env(x, 0.001, 0.07), 0.8);
    add(b, t, 0.1, (x) => sine(700, x) * env(x, 0.001, 0.015), 0.3);
  },
  click: (b, t) => {
    const f = lp(0.6);
    add(b, t, 0.03, (x) => f(rnd()) * env(x, 0.0005, 0.005), 0.5);
    add(b, t, 0.05, (x) => sine(1200, x) * env(x, 0.0005, 0.008), 0.3);
  },
  creak: (b, t) =>
    add(
      b,
      t,
      0.6,
      (x) =>
        (((sweep(240, 190, 0.6, x) * 1) % 1) + 0) * 0 +
        Math.sin(TAU * (210 * x + 6 * Math.sin(x * 38))) * Math.sin((Math.PI * x) / 0.6),
      0.14,
    ),
  clink: (b, t) => {
    for (const fr of [3150, 4120]) add(b, t, 0.4, (x) => sine(fr, x) * env(x, 0.0005, 0.07), 0.2);
  },
};

// ---------- tracks ----------
const sfx = mixBus();
for (const h of timing.hits) {
  if (!SFX[h.sound]) throw new Error(`no sound for ${h.sound}`);
  SFX[h.sound](sfx, h.frame / FPS);
}

const voice = mixBus();
for (const l of timing.voice.lines) {
  const w = readWav(join(voiceDir, `${l.id}.wav`));
  const s0 = Math.round((l.frame / FPS) * SR);
  for (let i = 0; i < w.length && s0 + i < voice.length; i++) voice[s0 + i] += w[i];
}

// Music: F major, four bars of F Dm Bb C at 90 bpm, a soft pad, a slow bass and a plucked eighth-note figure.
const beat = 60 / timing.music.bpm;
const bar = beat * 4;
const CH = [
  [349.23, 440, 523.25],
  [293.66, 349.23, 440],
  [233.08, 293.66, 349.23],
  [261.63, 329.63, 392],
];
const ROOT = [87.31, 73.42, 58.27, 65.41];
const music = mixBus();
const endT = total / SR;
const outroT = timing.music.outroFrame / FPS;
const hp = (() => {
  let px = 0;
  let py = 0;
  return (x) => {
    py = 0.995 * (py + x - px);
    px = x;
    return py;
  };
})();
for (let i = 0; i < total; i++) {
  const t = i / SR;
  const inOutro = t >= outroT;
  const bi = Math.floor(t / bar);
  const ci = inOutro ? 0 : bi % 4;
  const tb = t - bi * bar;
  // pad: each bar swells in and out so chords cross-fade
  const padEnv = inOutro
    ? Math.exp(-(t - outroT) / 1.6)
    : Math.sin((Math.PI * Math.min(1, tb / bar + 0.0)) ** 1) ** 0.6;
  let pad = 0;
  for (const f of CH[ci])
    pad += Math.sin(TAU * f * t) * 0.5 + Math.sin(TAU * f * 1.003 * t) * 0.3 + Math.sin(TAU * f * 0.5 * t) * 0.35;
  pad *= padEnv * 0.07;
  // bass on the bar and the third beat
  const bt = tb % (beat * 2);
  const bass = inOutro ? 0 : Math.sin(TAU * ROOT[ci] * 2 * t) * env(bt, 0.01, 0.5) * 0.12;
  // pluck figure on eighths
  const eighth = beat / 2;
  const ei = Math.floor(t / eighth);
  const te = t - ei * eighth;
  const note = [0, 2, 1, 2, 0, 1, 2, 1][ei % 8];
  const pluck =
    inOutro && t > outroT + 0.1
      ? 0
      : Math.sin(TAU * CH[ci][note] * 2 * t) * env(te, 0.003, 0.11) * 0.06 * (ei % 2 === 0 ? 1 : 0.7);
  music[i] = hp(pad + bass + pluck);
  // fade in and out
  const fi = Math.min(1, t / 2.5);
  const fo = Math.min(1, Math.max(0, (endT - t) / 1.2));
  music[i] *= fi * fo;
}

// Duck the music under the voice: a smoothed envelope of the voice level.
const duck = new Float32Array(total);
{
  let e = 0;
  const att = 1 - Math.exp(-1 / (0.04 * SR));
  const rel = 1 - Math.exp(-1 / (0.45 * SR));
  for (let i = 0; i < total; i++) {
    const a = Math.min(1, Math.abs(voice[i]) * 6);
    e += (a > e ? att : rel) * (a - e);
    duck[i] = 1 - 0.55 * Math.min(1, e);
  }
}
const L = new Float32Array(total);
const R = new Float32Array(total);
for (let i = 0; i < total; i++) {
  const m = music[i] * duck[i] * 1.6;
  L[i] = voice[i] * 1.0 + sfx[i] * 0.55 + m;
  R[i] = voice[i] * 1.0 + sfx[i] * 0.55 + m;
}
const premix = join(work, 'premix.wav');
writeWavStereo(premix, L, R);

// Loudness: two-pass loudnorm to -14 LUFS with a -2.5 dBTP ceiling, then a limiter; verified on the file afterwards.
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
const filt = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,alimiter=limit=0.708:level=disabled:attack=2:release=40,apad=whole_dur=${timing.frames / FPS}`;
run([
  '-y',
  '-hide_banner',
  '-i',
  silent,
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
  '48000',
  '-t',
  String(timing.frames / FPS),
  '-movflags',
  '+faststart',
  out,
]);
console.log('mixed', out, 'measured before', m.input_i, 'LUFS', m.input_tp, 'dBTP');
