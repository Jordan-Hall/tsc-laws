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
import { serveUi } from '../dist/ui.js';
import type { CheckOptions } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-ui-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: string }> {
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
    writeFileSync(join(cwd, 'src/f.laws.ts'), "import { add } from './f';\nexport law addCommutes(a: number, b: number) { return add(a, b) === add(b, a); }\n");
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
    const done = serveUi({ cwd, port: 0, open: false, run: () => check(opts, true), log: (line) => (announced = line) });
    for (let i = 0; i < 100 && announced === ''; i++) await new Promise((r) => setTimeout(r, 50));
    const port = Number(/:(\d+)\//.exec(announced)![1]);

    const html = await get(port, '/');
    assert.equal(html.status, 200);
    assert.match(html.body, /<title>tslaws<\/title>/);

    let state: { running: boolean; runs: number; report?: { ok: boolean; results: { name: string; status: string; hint?: string }[] }; sources: Record<string, string> } = {
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
    assert.equal((await get(port, '/api/run', { 'x-tslaws': '1' }, 'POST')).status, 202);
    for (let i = 0; i < 400 && state.runs === before; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = JSON.parse((await get(port, '/api/state')).body);
    }
    assert.ok(state.runs > before, 'the run was repeated');

    process.emit('SIGINT');
    assert.equal(await done, 0);
  });
});
