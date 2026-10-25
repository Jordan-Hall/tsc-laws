// Renders each line of narration.json to <outDir>/<key>.wav with Kokoro, an open neural text-to-speech that runs offline.
// Usage: KOKORO_DIR=<dir with kokoro-js installed> node voice.mjs <outDir> [voice]   (voice defaults to af_heart)
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
for (const [key, text] of Object.entries(lines)) {
  const audio = await tts.generate(text, { voice, speed: 0.93 });
  await audio.save(join(out, `${key}.wav`));
}
console.log(`rendered ${Object.keys(lines).length} lines with ${voice}`);
