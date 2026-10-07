// Checks TypeScript's compiler and conformance test cases with the translated
// checker and with tsgo, and reports the files whose diagnostics differ.
//
// Usage: node tools/corpus.mjs [--native] [--jobs N] [compiler|conformance ...]
//
// --native uses dist/check; the default runs the translated checker under Node.
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const native = args.includes('--native');
const jobsAt = args.indexOf('--jobs');
const jobs = jobsAt >= 0 ? Number(args[jobsAt + 1]) : Math.max(1, Math.min(8, availableParallelism() >> 1));
const suites = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--jobs');
const libs = resolve('upstream/typescript-go/internal/bundled/libs');
const work = mkdtempSync(join(tmpdir(), 'tsts-corpus-'));

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out.sort();
}

let check = [resolve('dist/check')];
if (!native) {
  const out = join(work, 'js');
  const tsc = spawnSync(
    resolve('node_modules/.bin/tsc'),
    [
      ...['--outDir', out, '--target', 'es2024', '--module', 'nodenext', '--moduleResolution', 'nodenext'],
      ...['--skipLibCheck', '--types', 'node', 'src/drivers/check.ts'],
    ],
    { stdio: 'inherit' },
  );
  if (tsc.status !== 0) throw new Error('could not compile the translated checker');
  check = [process.execPath, '--stack-size=16000', '--max-old-space-size=6000', join(out, 'drivers/check.js')];
}

// Runs a batch and returns diagnostics by file. A batch that crashes or
// times out reports its unfinished files as missing.
function run(command, list) {
  const listFile = join(work, `list-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(listFile, list.join('\n') + '\n');
  return new Promise((done) => {
    const child = spawn(command[0], [...command.slice(1), listFile, libs, '--batch'], { timeout: 600_000 });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('close', () => {
      const byFile = new Map();
      let current;
      for (const line of text.split('\n')) {
        if (line.startsWith('== ')) byFile.set((current = line.slice(3)), []);
        else if (current !== undefined && line !== '') byFile.get(current).push(line);
      }
      done(byFile);
    });
  });
}

async function runAll(command, list) {
  const chunks = [];
  for (let i = 0; i < list.length; i += 200) chunks.push(list.slice(i, i + 200));
  const results = new Map();
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < chunks.length) {
        for (const [file, diags] of await run(command, chunks[next++])) results.set(file, diags);
      }
    }),
  );
  return results;
}

let failed = false;
for (const suite of suites.length ? suites : ['compiler', 'conformance']) {
  const list = files(resolve('upstream/TypeScript/tests/cases', suite));
  const [expected, actual] = await Promise.all([runAll([resolve('dist/check-oracle')], list), runAll(check, list)]);
  const differ = list.filter(
    (f) => expected.has(f) && JSON.stringify(expected.get(f)) !== JSON.stringify(actual.get(f)),
  );
  console.log(`${suite}: ${list.length - differ.length} of ${list.length} files match tsgo`);
  for (const f of differ) console.log(`  ${f}${actual.has(f) ? '' : ' (crashed)'}`);
  failed ||= differ.length > 0;
}
process.exitCode = failed ? 1 : 0;
