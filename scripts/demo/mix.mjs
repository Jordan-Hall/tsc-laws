// Lays the voice, a soft music bed and small sound cues over the recording. Usage: node mix.mjs <vo-dir> <out-dir> <result.mp4>
// Everything but the voice is synthesised here (a slow A minor, F, C, G pad with a quiet bell, and short click, pass and fail
// sounds), so there is nothing to license. The cues mark what is on screen: a click, a run that passed, a run that failed.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [voDir, outDir, result] = process.argv.slice(2);
const { lines, cues } = JSON.parse(readFileSync(join(outDir, 'timings.json'), 'utf8'));
const video = join(
  outDir,
  'video',
  readdirSync(join(outDir, 'video')).find((f) => f.endsWith('.webm')),
);
const keys = Object.keys(lines);

const total = Number(
  spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], {
    encoding: 'utf8',
  }).stdout,
);

const args = ['-v', 'error', '-y', '-i', video];
for (const key of keys) args.push('-i', join(voDir, `${key}.wav`));

// The browser clock and the video start a moment apart; this nudge is measured against the first caption.
const nudge = Number(process.env.VOICE_NUDGE ?? 0.1);
const ms = (seconds) => Math.max(0, Math.round((seconds + nudge) * 1000));
const voice = keys.map((key, i) => `[${i + 1}:a]adelay=${ms(lines[key])}|${ms(lines[key])}[v${i}]`);

// Cue sounds: one short source for each kind, split once for each time it is heard.
const sources = {
  click: "aevalsrc='sin(2*PI*1500*t)*exp(-70*t)*0.30':d=0.12:s=44100",
  pass: "aevalsrc='(sin(2*PI*659.25*t)*exp(-5*t)+gte(t,0.12)*sin(2*PI*987.77*(t-0.12))*exp(-5*(t-0.12)))*0.26':d=1.0:s=44100",
  fail: "aevalsrc='(sin(2*PI*196*t)+0.5*sin(2*PI*98*t))*exp(-5*t)*0.34':d=0.8:s=44100",
};
const cueFilters = [];
const cueOutputs = [];
let next = keys.length + 1;
for (const [type, source] of Object.entries(sources)) {
  const times = cues.filter((c) => c.type === type).map((c) => c.t);
  if (times.length === 0) continue;
  args.push('-f', 'lavfi', '-i', source);
  const input = next++;
  const copies = times.map((_, i) => `[${type}${i}s]`);
  cueFilters.push(`[${input}:a]${times.length === 1 ? 'anull' : `asplit=${times.length}`}${copies.join('')}`);
  times.forEach((t, i) => {
    cueFilters.push(`[${type}${i}s]adelay=${ms(t)}|${ms(t)}[${type}${i}d]`);
    cueOutputs.push(`[${type}${i}d]`);
  });
}

// Music: a chord every eight seconds (A minor, F, C, G), each with a soft pad, a bass note and a plucked arpeggio of its notes
// every 0.3 seconds. It is ducked under the voice, so it is clearly there between lines and out of the way during them.
const chords = [
  [220, 261.63, 329.63, 392], // A minor
  [174.61, 220, 261.63, 349.23], // F
  [196, 261.63, 329.63, 392], // C
  [196, 246.94, 293.66, 392], // G
];
const bass = [55, 43.65, 65.41, 49];
const window = (i) => `lt(mod(t+32-${8 * i},32),8)`;
const swell = (i) => `pow(sin(PI*mod(t+32-${8 * i},32)/8),2)`;
const music = chords
  .map((notes, i) => {
    const pad = notes.map((f) => `sin(2*PI*${f}*t)`).join('+');
    const pluck = notes.map((f, j) => `eq(mod(floor(t/0.3),4),${j})*sin(2*PI*${f * 2}*t)`).join('+');
    return `${window(i)}*(${swell(i)}*(0.07*(${pad})+0.2*sin(2*PI*${bass[i]}*t))+0.09*exp(-9*mod(t,0.3))*(${pluck}))`;
  })
  .join('+');

const filter = [
  ...voice,
  `${keys.map((_, i) => `[v${i}]`).join('')}amix=inputs=${keys.length}:normalize=0,lowpass=f=9000[vo]`,
  `[vo]loudnorm=I=-16:TP=-2:LRA=7,asplit=2[von][key]`,
  `aevalsrc='${music}':s=44100:d=${total.toFixed(2)}[m0]`,
  `[m0]lowpass=f=2600,afade=t=in:d=2,afade=t=out:st=${(total - 4).toFixed(2)}:d=4[m1]`,
  `[m1][key]sidechaincompress=threshold=0.015:ratio=5:attack=30:release=500:makeup=1[music]`,
  ...cueFilters,
  `[von][music]${cueOutputs.join('')}amix=inputs=${2 + cueOutputs.length}:normalize=0:weights=${['1', '1', ...cueOutputs.map(() => '0.8')].join(' ')},alimiter=limit=0.95[a]`,
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
  '-ar',
  '44100',
  '-ac',
  '2',
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
