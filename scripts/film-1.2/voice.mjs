// Generates Kokoro narration WAVs for the tslaws 1.2 Blender launch film (`af_heart`, speed 0.93).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function writeWav(path, samples, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

function concatSamples(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function generateVoice(outDir) {
  const timing = JSON.parse(readFileSync(join(__dirname, 'timing.json'), 'utf8'));
  const voiceDir = join(outDir, 'voice');
  mkdirSync(voiceDir, { recursive: true });

  const kokoroBase = process.env.KOKORO_DIR ?? resolve(__dirname, '..', '..', '..', 'film-tools');
  const req = createRequire(join(kokoroBase, 'package.json'));
  const { KokoroTTS } = await import(pathToFileURL(req.resolve('kokoro-js')).href);
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'fp32',
    device: 'cpu',
  });

  const { voice, speed: defaultSpeed, lines } = timing.voice;
  const manifest = [];
  for (const line of lines) {
    const parts = [];
    let rate = 24000;
    for (const s of line.sentences) {
      const spoken = s.say ?? s.text;
      const audio = await tts.generate(spoken, { voice, speed: s.speed ?? defaultSpeed });
      rate = audio.sampling_rate;
      parts.push(audio.audio);
      if (s.gapMs) parts.push(new Float32Array(Math.round((s.gapMs / 1000) * rate)));
    }
    const merged = concatSamples(parts);
    const wavPath = join(voiceDir, `${line.id}.wav`);
    writeWav(wavPath, merged, rate);
    const dur = merged.length / rate;
    manifest.push({ id: line.id, startSec: line.startSec, durationSec: dur, endSec: line.startSec + dur, wavPath });
    console.log(
      `voice ${line.id.padEnd(8)} start=${line.startSec.toFixed(2)}s dur=${dur.toFixed(2)}s end=${(line.startSec + dur).toFixed(2)}s`,
    );
  }
  writeFileSync(join(voiceDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? join(process.env.TEMP ?? '/tmp', 'film-1.2-blender'));
  await generateVoice(outDir);
}
