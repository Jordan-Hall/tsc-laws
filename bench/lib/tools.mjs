// What the bench runs: for each workload, the tools that do equivalent work, how each is started, which caches a cold run
// clears and how its report is read back to prove it ran every test.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { benchRoot, params, projectDir } from './gen.mjs';

export const repoRoot = join(benchRoot, '..');
const nodeModules = join(benchRoot, 'node_modules');
const tslawsBin = join(repoRoot, 'packages', 'tslaws', 'bin', 'tslaws.js');
const vitestBin = join(nodeModules, 'vitest', 'vitest.mjs');
const rstestBin = join(nodeModules, '@rstest', 'core', 'bin', 'rstest.js');
const playwrightBin = join(nodeModules, '@playwright', 'test', 'cli.js');
const node = process.execPath;

/** Cache directories a cold run clears. Only the bench's own: per-project ones, and the shared ones in bench/node_modules. */
const sharedCaches = ['.vite', '.vite-temp', '.cache', '.rspack', '.rsbuild', '.rstest'].map((name) =>
  join(nodeModules, name),
);
const projectCaches = [
  '.tslaws',
  'node_modules',
  '.vite',
  '.cache',
  '.rstest',
  'dist',
  'report.json',
  'test-results',
  'playwright-report',
];

export function clearCaches(dir) {
  for (const path of [...sharedCaches, ...projectCaches.map((name) => join(dir, name))])
    rmSync(path, { recursive: true, force: true });
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The first JSON object in a log that may have other text around it. */
function jsonIn(text) {
  const start = text.indexOf('{');
  for (let at = start; at !== -1; at = text.indexOf('{', at + 1)) {
    let end = text.lastIndexOf('}');
    while (end > at) {
      try {
        return JSON.parse(text.slice(at, end + 1));
      } catch {
        end = text.lastIndexOf('}', end - 1);
      }
    }
  }
  return undefined;
}

function parseTslaws(log) {
  const report = jsonIn(log);
  if (report === undefined || !Array.isArray(report.results)) return { error: 'no JSON report on stdout' };
  const passing = new Set(['proved', 'bounded', 'tested']);
  const runs = [...new Set(report.results.map((r) => r.runs).filter((r) => r !== undefined))];
  const methods = {};
  for (const r of report.results) methods[r.method ?? r.status] = (methods[r.method ?? r.status] ?? 0) + 1;
  const bad = report.results.find((r) => !passing.has(r.status));
  return {
    total: report.results.length,
    passed: report.results.filter((r) => passing.has(r.status)).length,
    runsPerLaw: runs,
    methods,
    error:
      bad === undefined ? undefined : `${bad.status} ${bad.file ?? ''} ${bad.name ?? ''}: ${bad.message ?? ''}`.trim(),
  };
}

const parseVitest = (log, dir) => {
  const report = readJson(join(dir, 'report.json'));
  const failed = report.testResults?.flatMap((f) => f.assertionResults ?? []).find((t) => t.status !== 'passed');
  return {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    error: failed ? `${failed.fullName}: ${(failed.failureMessages ?? [])[0] ?? ''}` : undefined,
  };
};

function parseRstest(log) {
  const report = jsonIn(log);
  if (report === undefined || report.summary === undefined) return { error: 'no JSON report on stdout' };
  return { total: report.summary.tests, passed: report.summary.passedTests };
}

function parsePlaywright(log, dir) {
  const { stats } = readJson(join(dir, 'report.json'));
  return { total: stats.expected + stats.unexpected + stats.flaky + stats.skipped, passed: stats.expected };
}

const tslawsArgs = (flags) => [node, tslawsBin, 'check', '--compiler', 'builtin', ...flags, '--json'];

/**
 * Tool definitions per workload. `dir` is the generated project folder name. `equivalent: false` marks a row that does
 * different work (shown, never compared as like for like). `probe` runs once and is expected to fail.
 */
export function toolsFor(workload) {
  const runs = String(params.runs);
  if (workload === 'unit-prop')
    return [
      {
        id: 'tslaws',
        label: 'tslaws check --no-prove',
        dir: 'tslaws',
        argv: tslawsArgs(['--no-prove', '--runs', runs]),
        parse: parseTslaws,
        casesPerTest: params.runs,
      },
      {
        id: 'tslaws-prove',
        label: 'tslaws check (prover on, default)',
        dir: 'tslaws',
        argv: tslawsArgs(['--runs', runs]),
        parse: parseTslaws,
        equivalent: false,
        note: 'proves what Z3 can lower instead of running the generated cases',
      },
      {
        id: 'vitest',
        label: 'Vitest',
        dir: 'vitest',
        argv: [node, vitestBin, 'run', '--reporter=json', '--outputFile=report.json'],
        parse: parseVitest,
        casesPerTest: params.runs,
      },
      {
        id: 'rstest',
        label: 'Rstest',
        dir: 'rstest',
        argv: [node, rstestBin, 'run', '--reporter=json'],
        parse: parseRstest,
        casesPerTest: params.runs,
      },
    ];
  if (workload === 'unit-example')
    return [
      {
        id: 'tslaws',
        label: 'tslaws check --no-prove --runs 1',
        dir: 'tslaws',
        argv: tslawsArgs(['--no-prove', '--runs', '1']),
        parse: parseTslaws,
        casesPerTest: 1,
        note: 'a one-parameter law run once: zero-parameter laws do not run',
      },
      {
        id: 'tslaws-zero-param',
        label: 'tslaws check, zero-parameter laws',
        dir: 'tslaws-zero-param',
        argv: tslawsArgs(['--no-prove']),
        parse: parseTslaws,
        probe: true,
        casesPerTest: 1,
      },
      {
        id: 'vitest',
        label: 'Vitest',
        dir: 'vitest',
        argv: [node, vitestBin, 'run', '--reporter=json', '--outputFile=report.json'],
        parse: parseVitest,
        casesPerTest: 1,
      },
      {
        id: 'rstest',
        label: 'Rstest',
        dir: 'rstest',
        argv: [node, rstestBin, 'run', '--reporter=json'],
        parse: parseRstest,
        casesPerTest: 1,
      },
    ];
  if (workload === 'browser')
    return [
      {
        id: 'tslaws',
        label: 'tslaws check --no-prove (browser laws)',
        dir: 'tslaws',
        argv: tslawsArgs(['--no-prove', '--runs', String(params.browserRuns)]),
        parse: parseTslaws,
        casesPerTest: params.browserRuns,
        browser: true,
      },
      {
        id: 'vitest-browser',
        label: 'Vitest browser mode (playwright provider)',
        dir: 'vitest-browser',
        argv: [node, vitestBin, 'run', '--reporter=json', '--outputFile=report.json'],
        parse: parseVitest,
        casesPerTest: params.browserRuns,
        browser: true,
      },
      {
        id: 'playwright',
        label: 'Playwright Test',
        dir: 'playwright',
        argv: [node, playwrightBin, 'test'],
        parse: parsePlaywright,
        casesPerTest: params.browserRuns,
        browser: true,
      },
    ];
  if (workload === 'e2e')
    return [
      {
        id: 'tslaws',
        label: 'tslaws check --no-prove (e2e laws)',
        dir: 'tslaws',
        argv: tslawsArgs(['--no-prove']),
        parse: parseTslaws,
        casesPerTest: params.e2eRuns,
        browser: true,
      },
      {
        id: 'playwright',
        label: 'Playwright Test',
        dir: 'playwright',
        argv: [node, playwrightBin, 'test'],
        parse: parsePlaywright,
        casesPerTest: params.e2eRuns,
        browser: true,
      },
    ];
  throw new Error(`unknown workload ${workload}`);
}

export const dirOf = (workload, size, tool) => projectDir(workload, size, tool.dir);
export { existsSync };
