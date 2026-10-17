// Records which tsc-ts source files and functions each test file runs, and writes scripts/ci/coverage-map.json,
// which select-tests.mjs reads to choose the tests a change needs.
//
// Usage: node scripts/ci/coverage-map.mjs [test file ...]
//
// Needs npm ci, npm run fetch:upstream and `npx turbo run build:oracle`. Copies packages/tsc-ts into a temporary
// directory, makes every source file start V8 function coverage (node:inspector) in each process and thread that
// loads it, builds the copy, and runs each tsc-ts test file there. A process writes the source files it loaded and
// the names of the functions it ran when it exits. Test files default to all of packages/tsc-ts/tests/*.test.mjs.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const named = process.argv.slice(2);

const work = mkdtempSync(join(tmpdir(), 'tsc-ts-coverage-'));
const records = join(work, 'records');
const pkg = join(work, 'packages/tsc-ts');
mkdirSync(records);
mkdirSync(join(work, 'packages'));
cpSync(join(root, 'packages/tsc-ts'), pkg, {
  recursive: true,
  filter: (path) => !/[\\/](dist|node_modules)$/.test(path),
});
for (const name of ['node_modules', 'upstream', 'package.json']) symlinkSync(join(root, name), join(work, name));
symlinkSync(join(root, 'packages/tsgo'), join(work, 'packages/tsgo'));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const src = join(pkg, 'src');
const sources = walk(src).map((path) => relative(src, path));

// The hook: started by the first source module a process or thread evaluates, written out at exit. It lives outside
// src/ and is imported by absolute URL, so tsc leaves it out of each compilation and output layouts stay the same.
// A worker thread also writes before each message it posts, since the main thread may exit without waiting for it, and
// a process stopped by SIGTERM, SIGINT or SIGHUP writes before it exits.
const hook = join(work, 'coverage-hook.mjs');
writeFileSync(
  hook,
  `import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import { parentPort, threadId } from 'node:worker_threads';

if (!globalThis.coverageHook) {
  globalThis.coverageHook = true;
  const session = new Session();
  session.connect();
  session.post('Profiler.enable');
  session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  // Taking coverage resets its counts, so what each take finds accumulates here.
  const scripts = {};
  const save = () => {
    session.post('Profiler.takePreciseCoverage', (error, coverage) => {
      if (error) return;
      for (const script of coverage.result) {
        if (!script.url.startsWith('file:')) continue;
        const [top, ...rest] = script.functions;
        const ran = rest.filter((f) => f.ranges[0].count > 0).map((f) => f.functionName);
        if (top.ranges[0].count === 0 && ran.length === 0) continue;
        const entry = (scripts[script.url] ??= { loaded: false, ran: new Set() });
        entry.loaded ||= top.ranges[0].count > 0;
        for (const name of ran) entry.ran.add(name);
      }
      const out = {};
      for (const [url, { loaded, ran }] of Object.entries(scripts)) out[url] = { loaded, ran: [...ran] };
      writeFileSync(${JSON.stringify(records)} + '/' + process.pid + '-' + threadId + '.json', JSON.stringify(out));
    });
  };
  process.on('exit', save);
  // Tests stop watch processes and over-time runs with signals; those processes write too.
  if (!parentPort)
    for (const [signal, number] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]])
      process.on(signal, () => process.exit(128 + number));
  if (parentPort) {
    const post = parentPort.postMessage;
    parentPort.postMessage = function (...args) {
      save();
      return post.apply(this, args);
    };
  }
}
`,
);
for (const file of sources) {
  const path = join(src, file);
  writeFileSync(path, `import '${pathToFileURL(hook).href}';\n` + readFileSync(path, 'utf8'));
}

const built = spawnSync('npm', ['run', 'build'], { cwd: pkg, stdio: 'inherit' });
if (built.status !== 0) throw new Error('build failed');

/** The source file a script URL was compiled from, matched by its path below src/. */
const bySuffix = new Map(sources.map((file) => [file.replace(/\.ts$/, ''), file]));
function sourceOf(url) {
  const parts = fileURLToPath(url)
    .replace(/\.(js|ts)$/, '')
    .split(/[\\/]/);
  for (let i = 0; i < parts.length; i++) {
    const file = bySuffix.get(parts.slice(i).join('/'));
    if (file !== undefined) return file;
  }
  return undefined;
}

const tests = named.length
  ? named.map((t) => t.replace(/^.*tests\//, ''))
  : readdirSync(join(pkg, 'tests'))
      .filter((n) => n.endsWith('.test.mjs'))
      .sort();

/** Runs one test file with its own record directory; returns its source files and functions. */
function runTest(test) {
  const dir = join(records, test);
  mkdirSync(dir);
  return new Promise((done) => {
    const started = Date.now();
    // Tests compile the instrumented copy themselves rather than take a prebuilt one.
    const child = spawn(process.execPath, ['--stack-size=16000', '--test', join('tests', test)], {
      cwd: pkg,
      env: { ...process.env, TSC_TS_TEST_BUILD: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (status) => {
      console.log(`${test}: exit ${status}, ${((Date.now() - started) / 1000).toFixed(0)} s`);
      if (status !== 0) console.log(output.split('\n').slice(-30).join('\n'));
      done();
    });
  });
}

// Records carry no test name, so test files run one at a time per record directory: the hook's directory is fixed
// at build time, and each finished test file's records are moved to its own directory.
const result = {};
for (const test of tests) {
  await runTest(test);
  const files = {};
  for (const name of readdirSync(records)) {
    const path = join(records, name);
    if (statSync(path).isDirectory()) continue;
    for (const [url, { loaded, ran }] of Object.entries(JSON.parse(readFileSync(path, 'utf8')))) {
      const file = sourceOf(url);
      if (file === undefined) continue;
      const entry = (files[file] ??= { loaded: false, ran: new Set() });
      entry.loaded ||= loaded;
      for (const name of ran) entry.ran.add(name);
    }
    rmSync(path);
  }
  result[test] = files;
}

// The sources the map describes, named by the last commit that changed them, which stays reachable when commits after it
// are rebased. select-tests.mjs reads the sources at this commit to tell new functions from ones no test runs.
const git = spawnSync('git', ['-C', root, 'log', '-1', '--format=%H', '--', 'packages/tsc-ts/src'], {
  encoding: 'utf8',
}).stdout.trim();
const map = { commit: git, tests: tests.map((t) => 'packages/tsc-ts/tests/' + t), files: {} };
for (const file of sources.sort()) {
  const entry = { loaded: [], ran: [], functions: {} };
  tests.forEach((test, index) => {
    const seen = result[test][file];
    if (seen === undefined) return;
    if (seen.loaded) entry.loaded.push(index);
    if (seen.ran.size > 0) entry.ran.push(index);
    for (const name of seen.ran) (entry.functions[name || '<anonymous>'] ??= []).push(index);
  });
  map.files['packages/tsc-ts/src/' + file] = entry;
}
const out = join(root, 'scripts/ci/coverage-map.json');
writeFileSync(out, JSON.stringify(map) + '\n');
spawnSync(join(root, 'node_modules/.bin/oxfmt'), [out], { stdio: 'inherit' });
rmSync(work, { recursive: true, force: true });
console.log('wrote scripts/ci/coverage-map.json');
