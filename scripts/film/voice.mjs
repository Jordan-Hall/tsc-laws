// Renders the narration in timing.json with Kokoro (open neural text to speech, runs offline) to <outDir>/<id>.wav.
// Each sentence is spoken on its own, so its pace and the breath after it are set in timing.json (speed, gapMs).
// Usage: KOKORO_DIR=<dir where `npm i kokoro-js` was run> node voice.mjs <outDir> [voice]
// Writes <outDir>/durations.json (seconds of each line) and polishes each line: trim, low cut, soft compression.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [out, voiceArg] = process.argv.slice(2);
const dir = process.env.KOKORO_DIR;
if (!out || !dir) throw new Error('usage: KOKORO_DIR=<kokoro-js dir> node voice.mjs <outDir> [voice]');
const { KokoroTTS } = await import(pathToFileURL(createRequire(join(dir, 'x.js')).resolve('kokoro-js')).href);
const timing = JSON.parse(readFileSync(new URL('timing.json', import.meta.url), 'utf8'));
const { voice: defaultVoice, speed: defaultSpeed, lines } = timing.voice;
const voice = voiceArg ?? defaultVoice;
mkdirSync(out, { recursive: true });
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });

const durations = {};
const starts = {};
for (const line of lines) {
  const parts = [];
  for (const s of line.sentences) {
    const audio = await tts.generate(s.say ?? s.text, { voice, speed: s.speed ?? defaultSpeed });
    parts.push({ audio, gap: (s.gapMs ?? 380) / 1000 });
  }
  const rate = parts[0].audio.sampling_rate;
  const chunks = [];
  const offsets = [];
  let cursor = 0;
  parts.forEach(({ audio, gap }, i) => {
    offsets.push(cursor);
    cursor += audio.audio.length / rate + (i < parts.length - 1 ? gap : 0);
    chunks.push(audio.audio);
    if (i < parts.length - 1) chunks.push(new Float32Array(Math.round(rate * gap)));
  });
  const all = new Float32Array(chunks.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const raw = join(out, `${line.id}.raw.wav`);
  await new parts[0].audio.constructor(all, rate).save(raw);
  // Trim the silence at both ends, cut rumble, and level the phrases gently so quiet words stay clear.
  const filter = [
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.04',
    'areverse',
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08',
    'areverse',
    'highpass=f=70',
    'equalizer=f=250:t=q:w=1:g=1.5',
    'equalizer=f=3500:t=q:w=1.2:g=1.2',
    'acompressor=threshold=-24dB:ratio=2.2:attack=8:release=140:makeup=3',
  ].join(',');
  const target = join(out, `${line.id}.wav`);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af', filter, '-ar', '48000', target]);
  if (r.status) throw new Error(String(r.stderr));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target], {
    encoding: 'utf8',
  });
  durations[line.id] = Number(Number(probe.stdout).toFixed(3));
  // Where each sentence begins in the trimmed file, so picture can land on the word.
  const head = all.findIndex((x) => Math.abs(x) > 0.00316) / rate - 0.04;
  starts[line.id] = offsets.map((o) => Number(Math.max(0, o - Math.max(0, head)).toFixed(3)));
}
writeFileSync(join(out, 'durations.json'), JSON.stringify({ durations, starts }, null, 2));
console.log(`rendered ${lines.length} lines with ${voice}`, JSON.stringify(starts));
