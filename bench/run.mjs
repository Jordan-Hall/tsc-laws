#!/usr/bin/env node
// Benchmarks tslaws against Vitest, Rstest, Vitest browser mode and Playwright Test.
//
//   node bench/run.mjs --quick                  smallest size (10 tests), 3 repeats, every workload
//   node bench/run.mjs                          sizes 10, 100 and 1000, 5 repeats
//   node bench/run.mjs --workloads unit-prop,e2e --sizes 10,100 --repeats 7
//   node bench/run.mjs --tools tslaws,vitest    only those tool ids
//
// Per repeat, each tool runs twice: cold (its own caches cleared) and warm (the same project after one source file
// changed, caches kept). Results go to bench/results/<name>.json and <name>.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { generate, params, perFile, touch, touchTarget, workloadNames } from './lib/gen.mjs';
import { writeProjectLock } from './lib/lock.mjs';
import { ensureWrapper, measure, median, percentile } from './lib/measure.mjs';
import { renderMarkdown } from './lib/report.mjs';
import { clearCaches, dirOf, repoRoot, toolsFor } from './lib/tools.mjs';

const benchRoot = import.meta.dirname;
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : (argv[at + 1] ?? '');
};
const has = (name) => argv.includes(`--${name}`);

if (has('help') || has('h')) {
  process.stdout.write(
    readFileSync(import.meta.filename, 'utf8')
      .split('\n')
      .slice(1, 12)
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n') + '\n',
  );
  process.exit(0);
}

const quick = has('quick');
const list = (name, fallback) => (flag(name) === undefined ? fallback : flag(name).split(',').filter(Boolean));
const sizes = list('sizes', quick ? ['10'] : ['10', '100', '1000']).map(Number);
const repeats = Number(flag('repeats') ?? (quick ? 3 : 5));
const workloads = list('workloads', workloadNames);
const onlyTools = list('tools', undefined);
const timeoutMs = Number(flag('timeout-s') ?? (quick ? 300 : 900)) * 1000;
const name = flag('name') ?? (quick ? 'quick' : 'full');
const resultsDir = join(benchRoot, 'results');
mkdirSync(resultsDir, { recursive: true });
const logDir = join(benchRoot, '.logs');
mkdirSync(logDir, { recursive: true });

for (const w of workloads)
  if (!workloadNames.includes(w)) throw new Error(`unknown workload ${w}; known: ${workloadNames.join(', ')}`);
if (!existsSync(join(benchRoot, 'node_modules', 'vitest'))) throw new Error('run `npm install` in bench/ first');
if (!existsSync(join(repoRoot, 'packages', 'tslaws', 'dist', 'cli.js')))
  throw new Error('build tslaws first: npx tsc -p packages/tslaws/tsconfig.json');

// ---- environment ----

function chromeExecutable() {
  const fromEnv = process.env.BENCH_CHROME;
  if (fromEnv) return fromEnv;
  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA])
      if (base) candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin')
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  else
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    );
  const found = candidates.find((c) => existsSync(c));
  if (found) return found;
  return spawnSync(process.execPath, ['-e', "console.log(require('playwright').chromium.executablePath())"], {
    cwd: benchRoot,
    encoding: 'utf8',
  }).stdout.trim();
}

function chromeVersion(path) {
  try {
    if (process.platform === 'win32')
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${path}').VersionInfo.ProductVersion`],
        { encoding: 'utf8' },
      ).trim();
    return execFileSync(path, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const packageVersion = (pkg, base = join(benchRoot, 'node_modules')) => {
  try {
    return JSON.parse(readFileSync(join(base, pkg, 'package.json'), 'utf8')).version;
  } catch {
    return 'not installed';
  }
};

const git = (...args) => {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const chrome = chromeExecutable();
const useWrapper = ensureWrapper();
const environment = {
  startedAt: new Date().toISOString(),
  platform: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model.trim(),
  logicalCores: os.cpus().length,
  memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
  node: process.version,
  chrome: { path: chrome, version: chromeVersion(chrome) },
  rssMeasured: useWrapper
    ? 'peak sum of working sets over the whole process tree (job object, sampled every ~8 ms)'
    : 'not measured on this platform',
  tools: {
    tslaws: JSON.parse(readFileSync(join(repoRoot, 'packages', 'tslaws', 'package.json'), 'utf8')).version,
    vitest: packageVersion('vitest'),
    '@vitest/browser-playwright': packageVersion('@vitest/browser-playwright'),
    '@rstest/core': packageVersion('@rstest/core'),
    '@playwright/test': packageVersion('@playwright/test'),
    playwright: packageVersion('playwright'),
    'fast-check': packageVersion('fast-check'),
    typescript: packageVersion('typescript'),
  },
  tslawsSource: {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    commit: git('rev-parse', '--short', 'HEAD'),
    uncommittedFiles: git('status', '--porcelain', '--', 'packages/tslaws/src', 'packages/tslaws/dist')
      .split('\n')
      .filter(Boolean).length,
  },
  parameters: { ...params, testsPerFile: perFile, sizes, repeats, workloads, timeoutSeconds: timeoutMs / 1000 },
};

// ---- the run ----

const baseEnv = { ...process.env, BENCH_CHROME: chrome, TSLAWS_BROWSER: chrome, NO_COLOR: '1', FORCE_COLOR: '0' };
delete baseEnv.CI;
const results = { environment, runs: [], summaries: [] };
const save = () => {
  writeFileSync(join(resultsDir, `${name}.json`), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(join(resultsDir, `${name}.md`), renderMarkdown(results));
};

const tail = (file) => {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').slice(-12).join('\n').slice(-1500);
  } catch {
    return '';
  }
};

async function runOnce(tool, workload, size, dir, phase, repeat) {
  const logFile = join(logDir, `${workload}-${size}-${tool.id}-${phase}-${repeat}.log`);
  const m = await measure({ argv: tool.argv, cwd: dir, env: baseEnv, logFile, timeoutMs, useWrapper });
  let parsed = { error: 'not parsed' };
  try {
    parsed = tool.parse(readFileSync(logFile, 'utf8'), dir);
  } catch (error) {
    parsed = { error: `report unreadable: ${error.message}` };
  }
  const valid = m.exitCode === 0 && !m.timedOut && parsed.total === size && parsed.passed === size;
  const record = {
    workload,
    size,
    tool: tool.id,
    phase,
    repeat,
    wallMs: m.wallMs,
    innerWallMs: m.innerWallMs,
    cpuMs: m.cpuMs,
    peakRssBytes: m.peakRssBytes,
    sumOfProcessPeaksBytes: m.sumOfProcessPeaksBytes,
    peakProcesses: m.peakProcesses,
    totalProcesses: m.totalProcesses,
    leftoverProcesses: m.leftoverProcesses,
    exitCode: m.exitCode,
    timedOut: m.timedOut ?? false,
    tests: parsed.total,
    passed: parsed.passed,
    runsPerLaw: parsed.runsPerLaw,
    methods: parsed.methods,
    valid,
  };
  if (!valid)
    record.failure =
      parsed.error ??
      `exit ${m.exitCode}${m.timedOut ? ' (timed out)' : ''}, ${parsed.passed}/${parsed.total} of ${size} passed\n${tail(logFile)}`;
  return record;
}

const stat = (records, pick) => {
  const values = records.map(pick).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return values.length === 0
    ? null
    : {
        median: median(values),
        p95: percentile(values, 0.95),
        min: Math.min(...values),
        max: Math.max(...values),
        n: values.length,
      };
};

const label = (tool, workload, size) => `${workload}-${size} / ${tool.id}`;

for (const workload of workloads) {
  for (const size of sizes) {
    generate(workload, size);
    const tools = toolsFor(workload).filter((tool) => onlyTools === undefined || onlyTools.includes(tool.id));
    for (const dirName of new Set(tools.map((t) => t.dir)))
      if (dirName.startsWith('tslaws')) await writeProjectLock(dirOf(workload, size, { dir: dirName }));
    for (const tool of tools) {
      const dir = dirOf(workload, size, tool);
      const records = [];
      const rounds = tool.probe ? 1 : repeats;
      process.stdout.write(`${label(tool, workload, size)}: `);
      for (let repeat = 1; repeat <= rounds; repeat += 1) {
        clearCaches(dir);
        const cold = await runOnce(tool, workload, size, dir, 'cold', repeat);
        records.push(cold);
        process.stdout.write(cold.valid ? `cold ${(cold.wallMs / 1000).toFixed(1)}s ` : 'cold FAILED ');
        if (!cold.valid) break;
        if (tool.probe) break;
        touch(touchTarget(workload, tool.dir, size), repeat);
        const warm = await runOnce(tool, workload, size, dir, 'warm', repeat);
        records.push(warm);
        process.stdout.write(warm.valid ? `warm ${(warm.wallMs / 1000).toFixed(1)}s | ` : 'warm FAILED ');
        if (!warm.valid) break;
      }
      process.stdout.write('\n');
      results.runs.push(...records);
      const ok = (phase) => records.filter((r) => r.phase === phase && r.valid);
      const failure = records.find((r) => !r.valid);
      results.summaries.push({
        workload,
        size,
        tool: tool.id,
        label: tool.label,
        equivalent: tool.equivalent !== false,
        probe: tool.probe === true,
        note: tool.note,
        casesPerTest: tool.casesPerTest,
        repeats: ok('cold').length,
        cold: {
          wallMs: stat(ok('cold'), (r) => r.wallMs),
          cpuMs: stat(ok('cold'), (r) => r.cpuMs),
          peakRssBytes: stat(ok('cold'), (r) => r.peakRssBytes),
          testsPerSecond: stat(ok('cold'), (r) => size / (r.wallMs / 1000)),
        },
        warm: {
          wallMs: stat(ok('warm'), (r) => r.wallMs),
          cpuMs: stat(ok('warm'), (r) => r.cpuMs),
          peakRssBytes: stat(ok('warm'), (r) => r.peakRssBytes),
          testsPerSecond: stat(ok('warm'), (r) => size / (r.wallMs / 1000)),
        },
        leftoverProcesses: Math.max(0, ...records.map((r) => r.leftoverProcesses ?? 0)),
        failure: failure === undefined ? undefined : failure.failure,
      });
      save();
    }
  }
}

save();
process.stdout.write(`\nwrote ${join('bench', 'results', `${name}.json`)} and ${name}.md\n`);
const failed = results.summaries.filter((s) => s.failure !== undefined && !s.probe);
if (failed.length > 0) {
  process.stdout.write(
    `${failed.length} tool runs failed: ${failed.map((s) => `${s.workload}-${s.size}/${s.tool}`).join(', ')}\n`,
  );
  process.exitCode = 1;
}
