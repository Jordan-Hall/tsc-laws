// End-to-end laws: node generates inputs, a real browser drives a whole running app (a tiny Node server). Needs Chrome,
// Edge or Chromium (or TSLAWS_BROWSER), the built compiler in TSC_LAWS_BIN, and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-e2e-'));

function hasBrowser(): boolean {
  if (process.env.TSLAWS_BROWSER !== undefined) return existsSync(process.env.TSLAWS_BROWSER);
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
  const found = bases.some(
    (b) =>
      b !== undefined &&
      (existsSync(join(b, 'Google/Chrome/Application/chrome.exe')) ||
        existsSync(join(b, 'Microsoft/Edge/Application/msedge.exe'))),
  );
  return (
    found ||
    existsSync('/Applications/Google Chrome.app') ||
    ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some(existsSync)
  );
}

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

// The app under test: a product page and a cart page. With the `bug` argument the cart miscounts from 3 items up.
const serverSource = `
import { createServer } from 'node:http';
const port = Number(process.argv[2]);
const bug = process.argv[3] === 'bug';
const price = 7;
const page = (body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><main>' + body + '</main></body></html>';
createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/stock') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ stock: 5 }));
  } else if (url.pathname === '/cart') {
    const n = Number(url.searchParams.get('items') ?? 0);
    const total = bug && n >= 3 ? price * n + 1 : price * n;
    res.setHeader('content-type', 'text/html');
    res.end(page('<h1>Cart</h1><p id="total">Total: ' + total + '</p>'));
  } else if (url.pathname === '/') {
    res.setHeader('content-type', 'text/html');
    res.setHeader('set-cookie', 'visited=1; Path=/');
    res.end(page('<h1>Shop</h1><label for="qty">Quantity</label><input id="qty" type="number" value="1">' +
      '<button id="add">Add to cart</button><p id="stock">Stock: ?</p>' +
      '<script>document.getElementById("add").onclick = () => { location.href = "/cart?items=" + document.getElementById("qty").value; };' +
      'fetch("/api/stock").then((r) => r.json()).then((s) => { document.getElementById("stock").textContent = "Stock: " + s.stock; });</script>'));
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(port, '127.0.0.1');
`;

const hangSource = `
import { writeFileSync } from 'node:fs';
writeFileSync('pid.txt', String(process.pid));
setTimeout(() => {}, 999999);
`;

const spawnedSource = `
import { writeFileSync } from 'node:fs';
writeFileSync('spawned.txt', 'yes');
setTimeout(() => {}, 999999);
`;

interface Setup {
  laws: string[];
  server?: Record<string, unknown> | ((port: number) => Record<string, unknown>);
  port?: number;
  /** The laws file, relative to the project. Default `src/shop.browser.laws.ts`. */
  file?: string;
}

/** A project with the app, a tslaws.json for it, and the given laws source. */
async function project(name: string, setup: Setup): Promise<{ opts: CheckOptions; port: number; cwd: string }> {
  const cwd = join(root, name);
  const port = setup.port ?? (await freePort());
  const server =
    typeof setup.server === 'function'
      ? setup.server(port)
      : (setup.server ?? { command: `node server.mjs ${port}`, url: `http://127.0.0.1:${port}/`, timeoutMs: 20000 });
  const files: Record<string, string> = {
    'server.mjs': serverSource,
    'hang.mjs': hangSource,
    'spawned.mjs': spawnedSource,
    'tslaws.json': JSON.stringify({ e2e: { server, runs: 6, timeoutMs: 60000 } }),
    [setup.file ?? 'src/shop.browser.laws.ts']: setup.laws.join('\n'),
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const opts: CheckOptions = {
    files: [setup.file ?? 'src/shop.browser.laws.ts'],
    cwd,
    runs: 200,
    seed: 7,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 30000,
    noRegressions: true,
  };
  writeLock(opts.lockFile, readManifest(compiler!, opts.files, cwd));
  return { opts, port, cwd };
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

const header = [
  "import type { int } from 'tslaws';",
  "import { assume } from 'tslaws';",
  "import { accessible, baseURL, context, newPage, open, page, route, settle } from 'tslaws/e2e';",
];

const totalLaw = (name: string): string[] => [
  `export async law ${name}(qty: int) {`,
  '  assume(qty >= 1 && qty <= 20);',
  "  await open('/');",
  "  await page().fill('#qty', String(qty));",
  "  await page().click('#add');",
  "  await page().waitForURL('**/cart?items=*');",
  "  return (await page().textContent('#total')) === `Total: ${7 * qty}`;",
  '}',
];

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe(
  'end-to-end laws',
  { skip: compiler === undefined || !hasBrowser() ? 'needs TSC_LAWS_BIN and a browser' : false },
  () => {
    it('drive a running app across pages with generated inputs', async () => {
      const { opts } = await project('ok', { laws: [...header, ...totalLaw('totalMatchesQuantity')] });
      const { results, ok, compileDiagnostics } = await check(opts, true);
      assert.equal(compileDiagnostics, '');
      const r = byName(results, 'totalMatchesQuantity');
      assert.equal(r.status, 'tested', JSON.stringify(r));
      assert.equal(r.method, 'e2e');
      assert.equal(r.runs, 6, 'e2e.runs of tslaws.json applies');
      assert.equal(ok, true, JSON.stringify(results));
    });

    it('report a failing law with a shrunk counterexample and a screenshot', async () => {
      const { opts, cwd } = await project('bug', {
        laws: [...header, ...totalLaw('totalMatchesQuantity')],
        server: (port) => ({
          command: `node server.mjs ${port} bug`,
          url: `http://127.0.0.1:${port}/`,
          timeoutMs: 20000,
        }),
      });
      const { results, ok } = await check(opts, true);
      const r = byName(results, 'totalMatchesQuantity');
      assert.equal(r.status, 'failed', JSON.stringify(r));
      assert.equal(r.method, 'e2e');
      assert.equal(r.counterexample, '[3]', 'the smallest quantity that triggers the bug');
      assert.equal(r.screenshot, '.tslaws/screenshots/totalMatchesQuantity.png');
      assert.ok(existsSync(join(cwd, r.screenshot!)), 'screenshot file exists');
      assert.ok(readFileSync(join(cwd, r.screenshot!)).length > 500);
      assert.equal(ok, false);
    });

    it('mock the network with route()', async () => {
      const { opts } = await project('route', {
        laws: [
          ...header,
          'export async law uiShowsTheStock(stock: int) {',
          "  await route('**/api/stock', (r) => r.fulfill({ json: { stock } }));",
          "  await open('/');",
          "  await page().waitForFunction(`document.getElementById('stock').textContent === 'Stock: ${stock}'`, undefined, { timeout: 5000 });",
          '  return true;',
          '}',
          '',
        ],
      });
      const { results } = await check(opts, true);
      const r = byName(results, 'uiShowsTheStock');
      assert.equal(r.status, 'tested', JSON.stringify(r));
    });

    it('drive two tabs of one context', async () => {
      const { opts } = await project('tabs', {
        laws: [
          ...header,
          'export async law secondTabSharesCookiesAndSeesCart(qty: int) {',
          '  assume(qty >= 1 && qty <= 20);',
          "  await open('/');",
          '  const second = await newPage();',
          '  await second.goto(`${baseURL()}cart?items=${qty}`);',
          '  const cookies = await context().cookies();',
          "  return cookies.some((c) => c.name === 'visited') && (await second.textContent('#total')) === `Total: ${7 * qty}`;",
          '}',
          '',
        ],
      });
      const { results } = await check(opts, true);
      const r = byName(results, 'secondTabSharesCookiesAndSeesCart');
      assert.equal(r.status, 'tested', JSON.stringify(r));
    });

    it('hold the page to a speed budget through speed() and fast()', async () => {
      const { opts } = await project('speed', {
        laws: [
          ...header.map((l) => l.replace('accessible,', 'accessible, fast, speed,')),
          'export async law shopPageIsFast(n: int) {',
          '  assume(n >= 0 && n <= 2);',
          "  await open('/');",
          '  await settle();',
          '  return await fast({ fcp: 5000, lcp: 5000, cls: 0.1, blocking: 500, domNodes: 500, load: 10000 });',
          '}',
          'export async law shopPageMissesAnImpossibleBudget(n: int) {',
          '  assume(n >= 0 && n <= 2);',
          "  await open('/');",
          '  await settle();',
          '  const result = await speed({ domNodes: 1, bytes: 1 });',
          "  return !result.ok && result.violations.length === 2 && result.violations[0]!.startsWith('domNodes');",
          '}',
          '',
        ],
      });
      const { results } = await check(opts, true);
      assert.equal(byName(results, 'shopPageIsFast').status, 'tested', JSON.stringify(results));
      assert.equal(byName(results, 'shopPageMissesAnImpossibleBudget').status, 'tested', JSON.stringify(results));
    });

    it('audit the page with axe through accessible()', async () => {
      const { opts } = await project('a11y', {
        laws: [
          ...header,
          'export async law shopPageIsAccessible(n: int) {',
          '  assume(n >= 0 && n <= 2);',
          "  await open('/');",
          '  await settle();',
          '  return await accessible();',
          '}',
          '',
        ],
      });
      const { results } = await check(opts, true);
      const r = byName(results, 'shopPageIsAccessible');
      assert.equal(r.status, 'tested', JSON.stringify(r));
    });

    it('say clearly when the server never starts, and leave nothing running', async () => {
      const { opts, cwd } = await project('hang', {
        laws: [...header, ...totalLaw('totalMatchesQuantity')],
        server: (port) => ({ command: 'node hang.mjs', url: `http://127.0.0.1:${port}/`, timeoutMs: 2500 }),
      });
      const { results, ok } = await check(opts, true);
      const r = byName(results, 'totalMatchesQuantity');
      assert.equal(r.status, 'error', JSON.stringify(r));
      assert.equal(r.method, 'e2e');
      assert.match(r.message ?? '', /did not answer at http:\/\/127\.0\.0\.1:\d+\/ within 2\.5s/);
      assert.equal(ok, false);
      const pid = Number(readFileSync(join(cwd, 'pid.txt'), 'utf8'));
      assert.ok(pid > 0);
      for (let i = 0; i < 20 && running(pid); i++) await new Promise((done) => setTimeout(done, 100));
      assert.equal(running(pid), false, 'the server process is gone');
    });

    it('reuse a server that already answers instead of starting a second', async () => {
      const port = await freePort();
      writeFileSync(join(root, 'own-server.mjs'), serverSource);
      const own = spawn(process.execPath, [join(root, 'own-server.mjs'), String(port)], { stdio: 'ignore' });
      try {
        const url = `http://127.0.0.1:${port}/`;
        for (let i = 0; i < 100; i++) {
          if (
            await fetch(url).then(
              () => true,
              () => false,
            )
          )
            break;
          await new Promise((done) => setTimeout(done, 100));
        }
        const server = { command: 'node spawned.mjs', url, timeoutMs: 5000, reuseExisting: true };
        const { opts, cwd } = await project('reuse', {
          laws: [...header, ...totalLaw('totalMatchesQuantity')],
          server,
          port,
        });
        const { results } = await check(opts, true);
        const r = byName(results, 'totalMatchesQuantity');
        assert.equal(r.status, 'tested', JSON.stringify(r));
        assert.equal(existsSync(join(cwd, 'spawned.txt')), false, 'no second server was started');

        // Without reuseExisting the clash is reported rather than hidden.
        const clash = await project('clash', {
          laws: [...header, ...totalLaw('totalMatchesQuantity')],
          server: { ...server, reuseExisting: false },
          port,
        });
        const again = byName((await check(clash.opts, true)).results, 'totalMatchesQuantity');
        assert.equal(again.status, 'error');
        assert.match(again.message ?? '', /already answers/);
        assert.equal(existsSync(join(clash.cwd, 'spawned.txt')), false);
      } finally {
        own.kill();
      }
    });

    it('accept *.e2e.laws.ts as an alias that always means end to end', async () => {
      const { opts } = await project('alias', {
        file: 'src/shop.e2e.laws.ts',
        laws: [...header, ...totalLaw('totalMatchesQuantity')],
      });
      const r = byName((await check(opts, true)).results, 'totalMatchesQuantity');
      assert.equal(r.status, 'tested', JSON.stringify(r));
      assert.equal(r.method, 'e2e');
    });

    it('refuse a browser laws file that imports both levels', async () => {
      const { opts } = await project('both', {
        laws: [
          ...header,
          "import { mount } from 'tslaws/browser';",
          'export async law mixed(n: int) {',
          '  mount();',
          "  await open('/');",
          '  return true;',
          '}',
        ],
      });
      const r = byName((await check(opts, true)).results, 'mixed');
      assert.equal(r.status, 'error', JSON.stringify(r));
      assert.match(
        r.message ?? '',
        /either component level \(tslaws\/browser\) or end-to-end \(tslaws\/e2e\), not both/,
      );
      assert.match(r.message ?? '', /shop\.browser\.laws\.ts/);
    });

    it('reject unknown e2e options', async () => {
      const { opts, cwd } = await project('config', { laws: [...header, ...totalLaw('totalMatchesQuantity')] });
      writeFileSync(join(cwd, 'tslaws.json'), JSON.stringify({ e2e: { server: { command: 'x', url: 'y', port: 1 } } }));
      await assert.rejects(check(opts, true), /unknown option "server\.port"/);
    });
  },
);
