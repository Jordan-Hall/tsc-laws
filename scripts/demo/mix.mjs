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

// Music: four chords of eight seconds each, swelling in and out, and a quiet bell every two seconds.
const chords = [
  [110, 220, 261.63, 329.63], // A minor
  [174.61, 220, 261.63, 349.23], // F
  [130.81, 196, 261.63, 329.63], // C
  [98, 196, 246.94, 293.66], // G
];
const pad = chords
  .map((notes, i) => {
    const u = `mod(t+32-${8 * i},32)`;
    const tone = notes.map((f) => `sin(2*PI*${f}*t)`).join('+');
    return `if(lt(${u},8),pow(sin(PI*${u}/8),2),0)*(${tone})/4`;
  })
  .join('+');
const step = 'mod(floor(t/2),4)';
const bellPitch = `if(eq(${step},0),659.25,if(eq(${step},1),783.99,if(eq(${step},2),880,783.99)))`;
const bell = `sin(2*PI*${bellPitch}*t)*exp(-3*mod(t,2))*0.25`;

const filter = [
  ...voice,
  `${keys.map((_, i) => `[v${i}]`).join('')}amix=inputs=${keys.length}:normalize=0,lowpass=f=7500,aecho=0.8:0.55:70:0.18[vo]`,
  `[vo]loudnorm=I=-16:TP=-2:LRA=7[von]`,
  `aevalsrc='(${pad})*0.05+(${bell})*0.012':s=44100:d=${total.toFixed(2)}[m0]`,
  `[m0]lowpass=f=2000,afade=t=in:d=3,afade=t=out:st=${(total - 4).toFixed(2)}:d=4[music]`,
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
