// Synthesizes a warm cinematic synth-orchestral score & subtle physical foley, ducks cleanly under Kokoro `af_heart`
// narration, normalizes to -14 LUFS, muxes with the Blender-rendered video, and generates the README GIF preview.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SR = 48000;
const TAU = Math.PI * 2;

function writeWavStereo(path, left, right, rate = SR) {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

function readWavMono(path) {
  const buf = readFileSync(path);
  const rate = buf.readUInt32LE(24);
  const dataOff = buf.indexOf('data') + 8;
  const n = (buf.length - dataOff) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
  return { samples: out, rate };
}

function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLen = Math.round(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = samples[i0] ?? 0;
    const b = samples[Math.min(samples.length - 1, i0 + 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function addBell(L, R, startSec, freq, dur, amp, pan = 0) {
  const i0 = Math.round(startSec * SR);
  const len = Math.round(dur * SR);
  const gL = amp * Math.cos(((pan + 1) * Math.PI) / 4);
  const gR = amp * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < len && i0 + i < L.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.006) * Math.exp(-t / (dur * 0.34));
    const sig =
      Math.sin(TAU * freq * t) * 0.65 +
      Math.sin(TAU * freq * 2.0 * t) * 0.25 * Math.exp(-t * 3.5) +
      Math.sin(TAU * freq * 3.01 * t) * 0.1 * Math.exp(-t * 6.5);
    L[i0 + i] += sig * env * gL;
    R[i0 + i] += sig * env * gR;
  }
}

export function mixAndMaster(outDir, finalMp4, finalGif) {
  const timing = JSON.parse(readFileSync(join(__dirname, 'timing.json'), 'utf8'));
  const totalSec = timing.scenes.at(-1).endSec;
  const totalSamples = Math.round(totalSec * SR);

  const L = new Float32Array(totalSamples);
  const R = new Float32Array(totalSamples);
  const duck = new Float32Array(totalSamples).fill(1.0);

  // Place Kokoro `af_heart` voiceover and compute smooth ducking envelope
  const voiceManifest = JSON.parse(readFileSync(join(outDir, 'voice', 'manifest.json'), 'utf8'));
  const voiceBuf = new Float32Array(totalSamples);
  for (const v of voiceManifest) {
    const raw = readWavMono(v.wavPath);
    const res = resample(raw.samples, raw.rate, SR);
    const i0 = Math.round(v.startSec * SR);
    for (let i = 0; i < res.length && i0 + i < totalSamples; i++) voiceBuf[i0 + i] += res[i];
    const pad = Math.round(0.28 * SR);
    for (let i = Math.max(0, i0 - pad); i < Math.min(totalSamples, i0 + res.length + pad); i++) {
      const dist = i < i0 ? (i0 - i) / pad : i > i0 + res.length ? (i - (i0 + res.length)) / pad : 0;
      const target = 0.26 + 0.74 * Math.min(1, dist);
      if (target < duck[i]) duck[i] = target;
    }
  }

  // Warm lush cinematic orchestral-ambient pad (D minor 9 -> Bb maj7 -> F maj7 -> C add9)
  const chords = [
    [146.83, 220.0, 261.63, 329.63], // Dm9
    [116.54, 174.61, 220.0, 293.66], // Bbmaj7
    [174.61, 220.0, 261.63, 329.63], // Fmaj7
    [130.81, 196.0, 246.94, 293.66], // Cadd9
  ];
  const barSec = (60 / timing.bpm) * 4;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SR;
    const fadeIn = Math.min(1, t / 1.8);
    const fadeOut = Math.min(1, Math.max(0, (totalSec - t) / 2.6));
    const chIdx = Math.floor(t / (barSec * 2)) % chords.length;
    const ch = chords[chIdx];
    const breath = 0.78 + 0.22 * Math.sin(TAU * (t / (barSec * 2)));
    let sL = 0;
    let sR = 0;
    for (let k = 0; k < ch.length; k++) {
      const f = ch[k];
      sL += Math.sin(TAU * f * t + k * 0.7) * 0.036 + Math.sin(TAU * (f * 1.003) * t) * 0.02;
      sR += Math.sin(TAU * (f * 0.997) * t + k * 1.1) * 0.036 + Math.sin(TAU * f * t) * 0.02;
    }
    // Warm deep cello-like sub harmonic
    const bassF = ch[0] * 0.5;
    const sub = Math.sin(TAU * bassF * t) * 0.055 * (0.7 + 0.3 * Math.sin(TAU * (t / barSec)));
    const env = fadeIn * fadeOut * breath * duck[i];
    L[i] += (sL + sub) * env;
    R[i] += (sR + sub) * env;
  }

  // Crystalline chimes on scene transitions + induction cascade!
  const sc = Object.fromEntries(timing.scenes.map((s) => [s.id, s]));
  for (const s of timing.scenes) {
    if (s.startSec > 0.1) addBell(L, R, s.startSec, 587.33, 1.4, 0.09, -0.2);
  }
  // Induction crystal staircase ascending chimes (Scene 3)
  const indScale = [293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];
  for (let k = 0; k < indScale.length; k++) {
    addBell(L, R, sc.proofs.startSec + 1.8 + (k * 7) / timing.fps, indScale[k], 0.9, 0.065, -0.6 + (k / 11) * 1.2);
  }
  // Closing harmonic chime
  addBell(L, R, sc.cta.startSec + 0.5, 587.33, 2.2, 0.11, -0.35);
  addBell(L, R, sc.cta.startSec + 0.72, 880.0, 2.4, 0.09, 0.35);

  // Mix voiceover center-channel with crisp studio presence
  for (let i = 0; i < totalSamples; i++) {
    const v = voiceBuf[i] * 0.88;
    L[i] = Math.tanh((L[i] + v) * 0.95);
    R[i] = Math.tanh((R[i] + v) * 0.95);
  }

  const mixWav = join(outDir, 'mix.wav');
  writeWavStereo(mixWav, L, R, SR);

  // Assemble rendered frame sequence from Blender -> silent MP4 -> two-pass loudnorm master MP4
  const framesPattern = join(outDir, 'frames', 'frame_%04d.jpg');
  const silentMp4 = join(outDir, 'video-silent.mp4');
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-framerate',
      String(timing.fps),
      '-i',
      framesPattern,
      '-vf',
      'scale=1920:1080:flags=lanczos',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '23',
      '-preset',
      'slow',
      '-movflags',
      '+faststart',
      silentMp4,
    ],
    { stdio: 'inherit' },
  );

  // Measure loudness (pass 1)
  const probe = execFileSync(
    'ffmpeg',
    ['-v', 'info', '-i', mixWav, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // ffmpeg writes loudnorm JSON to stderr, fallback to single-pass if not parsed
  let af = 'loudnorm=I=-14:TP=-1.5:LRA=11';
  const m = probe.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
  if (m) {
    const j = JSON.parse(m[0]);
    af = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  }

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-i',
      silentMp4,
      '-i',
      mixWav,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-af',
      af,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      finalMp4,
    ],
    { stdio: 'inherit' },
  );
  console.log(`Mastered final MP4: ${finalMp4}`);

  if (finalGif) {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-i',
        finalMp4,
        '-vf',
        'fps=4,scale=560:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=32:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
        finalGif,
      ],
      { stdio: 'inherit' },
    );
    console.log(`Generated README GIF: ${finalGif}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? join(process.env.TEMP ?? '/tmp', 'film-1.2-blender'));
  const mp4 = resolve(process.argv[3] ?? join(outDir, 'tslaws-1.2-launch.mp4'));
  const gif = process.argv[4] ? resolve(process.argv[4]) : null;
  mixAndMaster(outDir, mp4, gif);
}
