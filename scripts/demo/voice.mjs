// Renders each line of narration.json to <outDir>/<key>.wav with Piper, a neural text-to-speech that runs offline.
// Usage: node voice.mjs <outDir> <piper.exe> <voice.onnx>
// The voice used is en_GB-jenny_dioco-medium (https://huggingface.co/rhasspy/piper-voices); the .onnx.json config sits beside the model.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [out, piper, model] = process.argv.slice(2);
const lines = JSON.parse(readFileSync(new URL('narration.json', import.meta.url), 'utf8'));
mkdirSync(out, { recursive: true });
for (const [key, text] of Object.entries(lines)) {
  const run = spawnSync(
    piper,
    [
      '-m',
      model,
      '-c',
      `${model}.json`,
      '-f',
      join(out, `${key}.wav`),
      '--length_scale',
      '1.08',
      '--sentence_silence',
      '0.35',
    ],
    { input: text, encoding: 'utf8', cwd: dirname(piper) },
  );
  if (run.status !== 0) throw new Error(`${key}: ${run.stderr}`);
}
console.log(`rendered ${Object.keys(lines).length} lines`);
