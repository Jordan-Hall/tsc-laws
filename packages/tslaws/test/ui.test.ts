// The dashboard server: serves the page and state, reruns on request, and refuses requests that are not from the page.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import { isFlaky, serveUi } from '../dist/ui.js';
import type { CheckOptions } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-ui-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

describe('tslaws ui', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('serves the page and the state, reruns on request and refuses foreign requests', async () => {
    const cwd = join(root, 'p');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/f.ts'), 'export const add = (a: number, b: number): number => a + b;\n');
    writeFileSync(
      join(cwd, 'src/f.laws.ts'),
      "import { add } from './f';\nexport law addCommutes(a: number, b: number) { return add(a, b) === add(b, a); }\n",
    );
    const opts: CheckOptions = {
      files: ['src/f.laws.ts'],
      cwd,
      runs: 50,
      compiler: compiler!,
      lockFile: join(cwd, 'tsc-laws.lock'),
      noProve: false,
      bound: 4,
      proofTimeoutMs: 5000,
    };
    writeLock(opts.lockFile, readManifest(compiler!, opts.files, cwd));
    let announced = '';
    const done = serveUi({
      cwd,
      port: 0,
      open: false,
      run: (_only, onEvent) => check({ ...opts, onEvent }, true),
      log: (line) => (announced = line),
    });
    for (let i = 0; i < 100 && announced === ''; i++) await new Promise((r) => setTimeout(r, 50));
    const port = Number(/:(\d+)\//.exec(announced)![1]);

    const html = await get(port, '/');
    assert.equal(html.status, 200);
    assert.match(html.body, /<title>tslaws<\/title>/);

    let state: {
      running: boolean;
      runs: number;
      report?: { ok: boolean; results: { name: string; status: string; hint?: string }[] };
      sources: Record<string, string>;
    } = {
      running: true,
      runs: 0,
      sources: {},
    };
    for (let i = 0; i < 400 && (state.running || state.report === undefined); i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = JSON.parse((await get(port, '/api/state')).body);
    }
    assert.equal(state.report?.ok, true, JSON.stringify(state.report));
    assert.equal(state.report?.results[0]?.name, 'addCommutes');
    assert.match(state.sources['src/f.laws.ts'] ?? '', /export law addCommutes/);
    const before = state.runs;

    // A rerun needs the header the page sends, and a loopback Host.
    assert.equal((await get(port, '/api/run', {}, 'POST')).status, 403);
    assert.equal((await get(port, '/', { host: 'evil.example' })).status, 403);
    assert.equal((await get(port, '/api/run', { 'x-tslaws': '1', origin: 'http://evil.example' }, 'POST')).status, 403);
    assert.equal((await get(port, '/api/run?file=src%2Ff.laws.ts', { 'x-tslaws': '1' }, 'POST')).status, 202);
    for (let i = 0; i < 400 && state.runs === before; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = JSON.parse((await get(port, '/api/state')).body);
    }
    assert.ok(state.runs > before, 'the run was repeated');

    assert.equal(state.report?.results.length, 1, 'a rerun of one file keeps the results');
    assert.equal((await get(port, '/api/screenshot?path=..%2F..%2Fpackage.json')).status, 404);
    process.emit('SIGINT');
    assert.equal(await done, 0);
  });

  it('times laws, keeps a history of full runs, and reruns a single law', async () => {
    const cwd = join(root, 'q');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/f.ts'), 'export const add = (a: number, b: number): number => a + b;\n');
    writeFileSync(
      join(cwd, 'src/f.laws.ts'),
      "import { add } from './f';\n" +
        'export law addCommutes(a: number, b: number) { return add(a, b) === add(b, a); }\n' +
        'export law addZero(a: number) { return add(a, 0) === a; }\n',
    );
    const opts: CheckOptions = {
      files: ['src/f.laws.ts'],
      cwd,
      runs: 20,
      compiler: compiler!,
      lockFile: join(cwd, 'tsc-laws.lock'),
      noProve: true,
      bound: 4,
      proofTimeoutMs: 5000,
    };
    writeLock(opts.lockFile, readManifest(compiler!, opts.files, cwd));
    let announced = '';
    const done = serveUi({
      cwd,
      port: 0,
      open: false,
      run: (files, onEvent, laws) => check({ ...opts, files: files ?? opts.files, only: laws, onEvent }, true),
      log: (line) => (announced = line),
    });
    for (let i = 0; i < 100 && announced === ''; i++) await new Promise((r) => setTimeout(r, 50));
    const port = Number(/:(\d+)\//.exec(announced)![1]);

    type Entry = { name: string; status: string; durationMs?: number; flaky?: boolean };
    type S = {
      running: boolean;
      runs: number;
      history: { ok: boolean; counts: Record<string, number> }[];
      report?: { results: Entry[] };
    };
    const read = async (): Promise<S> => JSON.parse((await get(port, '/api/state')).body);
    const until = async (runs: number): Promise<S> => {
      let st = await read();
      for (let i = 0; i < 600 && (st.running || st.runs < runs); i++) {
        await new Promise((r) => setTimeout(r, 100));
        st = await read();
      }
      return st;
    };
    const post = (query: string): Promise<{ status: number }> =>
      get(port, `/api/run${query}`, { 'x-tslaws': '1' }, 'POST');

    let st = await until(1);
    assert.equal(st.report?.results.length, 2);
    for (const r of st.report!.results) {
      assert.equal(typeof r.durationMs, 'number', `${r.name} is timed`);
      assert.equal(r.flaky, false);
    }
    assert.equal(st.history.length, 1);
    assert.equal(st.history[0]!.ok, true);
    assert.equal(st.history[0]!.counts.tested, 2);
    const commutes = JSON.stringify(st.report!.results.find((r) => r.name === 'addCommutes'));

    // A single law's rerun is accepted, replaces only that law's entry and adds no history.
    assert.equal((await post('?file=src%2Ff.laws.ts&law=addZero')).status, 202);
    st = await until(2);
    assert.equal(st.report?.results.length, 2);
    assert.equal(JSON.stringify(st.report!.results.find((r) => r.name === 'addCommutes')), commutes);
    assert.equal(typeof st.report!.results.find((r) => r.name === 'addZero')?.durationMs, 'number');
    assert.equal(st.history.length, 1, 'a law rerun is not a run of the project');

    assert.equal((await post('?file=src%2Ff.laws.ts')).status, 202);
    st = await until(3);
    assert.equal(st.history.length, 1, 'a file rerun is not a run of the project');

    assert.equal((await post('')).status, 202);
    st = await until(4);
    assert.equal(st.history.length, 2, 'a full run adds one entry');
    assert.ok(st.report!.results.every((r) => r.flaky === false));
    process.emit('SIGINT');
    assert.equal(await done, 0);
  });
});

describe('flaky rule', () => {
  it('needs a pass and a failure among the last five statuses', () => {
    assert.equal(isFlaky(undefined), false);
    assert.equal(isFlaky(['tested', 'tested', 'proved']), false);
    assert.equal(isFlaky(['failed', 'error', 'open']), false);
    assert.equal(isFlaky(['tested', 'failed']), true);
    assert.equal(isFlaky(['bounded', 'open', 'bounded']), true);
    assert.equal(
      isFlaky(['failed', 'tested', 'tested', 'tested', 'tested', 'tested']),
      false,
      'only the last five count',
    );
    assert.equal(isFlaky(['uncovered', 'tested']), false);
  });
});
