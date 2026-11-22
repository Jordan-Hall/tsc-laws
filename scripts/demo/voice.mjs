// Renders each line of narration.json to <outDir>/<key>.wav with Kokoro, an open neural text-to-speech that runs offline.
// Usage: KOKORO_DIR=<dir with kokoro-js installed> node voice.mjs <outDir> [voice]   (voice defaults to af_heart)
// PAUSE_MS=300 puts a short silence between sentences, and SPEED=0.9 slows the voice (defaults: no pause, 0.93).
// The model (Kokoro-82M, Apache-2.0) is fetched once from Hugging Face and cached by kokoro-js.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [out, voice = 'af_heart'] = process.argv.slice(2);
const dir = process.env.KOKORO_DIR;
if (!dir) throw new Error('set KOKORO_DIR to a folder where `npm i kokoro-js` was run');
const { KokoroTTS } = await import(pathToFileURL(createRequire(join(dir, 'x.js')).resolve('kokoro-js')).href);
const lines = JSON.parse(readFileSync(new URL(process.env.NARRATION ?? 'narration.json', import.meta.url), 'utf8'));
mkdirSync(out, { recursive: true });
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
const pause = Number(process.env.PAUSE_MS ?? 0) / 1000;
const speed = Number(process.env.SPEED ?? 0.93);
for (const [key, text] of Object.entries(lines)) {
  if (!pause) {
    const audio = await tts.generate(text, { voice, speed });
    await audio.save(join(out, `${key}.wav`));
    continue;
  }
  const parts = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) parts.push(await tts.generate(sentence, { voice, speed }));
  const rate = parts[0].sampling_rate;
  const gap = new Float32Array(Math.round(rate * pause));
  const samples = parts.flatMap((part, i) => (i ? [gap, part.audio] : [part.audio]));
  const all = new Float32Array(samples.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of samples) {
    all.set(a, at);
    at += a.length;
  }
  await new parts[0].constructor(all, rate).save(join(out, `${key}.wav`));
}
console.log(`rendered ${Object.keys(lines).length} lines with ${voice}`);
