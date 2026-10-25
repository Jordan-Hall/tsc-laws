// Lays the voice and a quiet music bed over the recording. Usage: node mix.mjs <vo-dir> <out-dir> <result.mp4>
// The music is synthesised here (a slow A minor chord), so there is nothing to license.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [voDir, outDir, result] = process.argv.slice(2);
const timings = JSON.parse(readFileSync(join(outDir, 'timings.json'), 'utf8'));
const video = join(
  outDir,
  'video',
  readdirSync(join(outDir, 'video')).find((f) => f.endsWith('.webm')),
);
const keys = Object.keys(timings);

const total = Number(
  spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], {
    encoding: 'utf8',
  }).stdout,
);

const args = ['-v', 'error', '-y', '-i', video];
for (const key of keys) args.push('-i', join(voDir, `${key}.wav`));
// The browser clock and the video start a moment apart; this nudge is measured against the first caption.
const nudge = Number(process.env.VOICE_NUDGE ?? 0.1);
const voice = keys.map(
  (key, i) =>
    `[${i + 1}:a]adelay=${Math.round((timings[key] + nudge) * 1000)}|${Math.round((timings[key] + nudge) * 1000)}[v${i}]`,
);
const chord = [110, 164.81, 220, 261.63, 329.63]
  .map((f, i) => `sin(2*PI*${f}*t)*(0.5+0.5*sin(2*PI*${0.07 + i * 0.013}*t))`)
  .join('+');
const filter = [
  ...voice,
  `aevalsrc='(${chord})*0.022':s=44100:d=${total.toFixed(2)}[m0]`,
  `[m0]lowpass=f=900,afade=t=in:d=3,afade=t=out:st=${(total - 4).toFixed(2)}:d=4[music]`,
  `${keys.map((_, i) => `[v${i}]`).join('')}amix=inputs=${keys.length}:normalize=0[vo]`,
  `[vo]loudnorm=I=-16:TP=-2:LRA=7[von]`,
  `[von][music]amix=inputs=2:normalize=0,alimiter=limit=0.95[a]`,
].join(';');
args.push(
  '-filter_complex',
  filter,
  '-map',
  '0:v',
  '-map',
  '[a]',
  '-c:v',
  'libx264',
  '-crf',
  '23',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '160k',
  '-t',
  total.toFixed(2),
  '-movflags',
  '+faststart',
  result,
);
const run = spawnSync('ffmpeg', args, { encoding: 'utf8' });
if (run.status !== 0) throw new Error(run.stderr);
console.log('wrote', result);
