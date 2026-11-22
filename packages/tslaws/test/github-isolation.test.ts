// The laws of a GitHub run never reach a token: `report` and `merge` run them in a child process with an allowlisted
// environment, and with `--results-out` / `--results` in a different job from the one that holds the token.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { githubCommand } from '../dist/githubCli.js';
import { readReport, scrubbedEnv } from '../dist/isolate.js';

const here = dirname(fileURLToPath(import.meta.url));
// Inside the repo so a law file's `tslaws` import resolves through its node_modules.
const root = mkdtempSync(join(here, '..', '.tmp-ghi-'));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const secret = 'ghs_isolation_probe_0123456789';
const credentials: Record<string, string> = {
  GITHUB_TOKEN: secret,
  GH_TOKEN: secret,
  ACTIONS_RUNTIME_TOKEN: secret,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: secret,
  TSLAWS_APP_KEY: secret,
  NPM_TOKEN: secret,
  APP_PRIVATE_KEY: secret,
};
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const [name, value] of Object.entries(credentials)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const hex = (c: string) => c.repeat(40);
let counter = 0;

/** A project whose one law reports what it can see of its environment, as the code of a pull request could. */
function project(): { dir: string; probe: string } {
  const dir = join(root, `p${(counter += 1)}`);
  mkdirSync(join(dir, '.git'), { recursive: true });
  const probe = join(dir, 'probe.json');
  writeFileSync(join(dir, 'tslaws.json'), JSON.stringify({ github: { bot: 'tslaws[bot]' } }));
  // What actions/checkout leaves behind unless it is told persist-credentials: false.
  writeFileSync(join(dir, '.git', 'config'), `[http]\n\textraheader = AUTHORIZATION: basic ${secret}\n`);
  writeFileSync(
    join(dir, 'a.laws.ts'),
    `import { law } from 'tslaws';
law('probe', () => {
  const node = (globalThis as any).process;
  const fs = node.getBuiltinModule('node:fs');
  let environ = '';
  try {
    environ = fs.readFileSync('/proc/self/environ', 'utf8');
  } catch {}
  fs.writeFileSync(
    ${JSON.stringify(probe)},
    JSON.stringify({
      env: Object.entries(node.env).map(([k, v]) => k + '=' + v).join('\\n'),
      environ,
      names: Object.keys(node.env),
    }),
  );
  return true;
});
`,
  );
  return { dir, probe };
}

async function run(
  mode: 'report' | 'merge',
  dir: string,
  flags: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
  after = hex('c'),
) {
  const event =
    mode === 'merge'
      ? { ref: 'refs/heads/master', before: hex('a'), after, commits: [] }
      : { pull_request: { number: 5, head: { sha: hex('c') } } };
  writeFileSync(join(dir, 'event.json'), JSON.stringify(event));
  const calls: { method: string; path: string }[] = [];
  let out = '';
  const code = await githubCommand(mode, {
    cwd: dir,
    options: {
      cwd: dir,
      files: ['a.laws.ts'],
      compiler: process.env.TSC_LAWS_BIN ?? 'builtin',
      lockFile: join(dir, 'tsc-laws.lock'),
      runs: 5,
      noProve: true,
      bound: 8,
      proofTimeoutMs: 1000,
      noRegressions: true,
    },
    // The parent holds the token, as it does in the action.
    env: {
      GITHUB_EVENT_PATH: join(dir, 'event.json'),
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_SHA: hex('c'),
      GITHUB_TOKEN: secret,
      ...extraEnv,
    },
    flags: new Map(Object.entries(flags)),
    out: (t) => void (out += t),
    err: (t) => void (out += t),
    api: async (method, path) => {
      calls.push({ method, path });
      if (method !== 'GET') return {};
      if (path.includes('/contents/tsc-laws.lock')) throw new Error('GitHub GET: 404 not found');
      if (/\/git\/ref\/heads\/[^/]+$/.test(path)) return { object: { sha: hex('c') } };
      return [];
    },
  });
  return { code, out, calls };
}

const seen = (probe: string) =>
  JSON.parse(readFileSync(probe, 'utf8')) as { env: string; environ: string; names: string[] };

function assertTokenFree(probe: string): void {
  const found = seen(probe);
  assert.ok(
    found.names.some((name) => name.toUpperCase() === 'PATH'),
    'the law ran with a working environment',
  );
  assert.ok(!found.env.includes(secret), 'process.env holds the token');
  for (const name of Object.keys(credentials)) assert.ok(!found.names.includes(name), `process.env has ${name}`);
  if (process.platform === 'linux') {
    assert.ok(found.environ.length > 0, '/proc/self/environ was read');
    assert.ok(!found.environ.includes(secret), '/proc/self/environ holds the token');
  }
}

describe('the environment a law gets', () => {
  it('is an allowlist, and drops every credential', () => {
    const env = scrubbedEnv({
      PATH: '/bin',
      HOME: '/home/x',
      TSC_LAWS_BIN: '/x/tsc',
      TSLAWS_JOBS: '2',
      TSLAWS_APP_KEY: 'k',
      GITHUB_TOKEN: 't',
      GH_TOKEN: 't',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'u',
      ACTIONS_RUNTIME_TOKEN: 't',
      NPM_TOKEN: 't',
      AWS_SECRET_ACCESS_KEY: 's',
      SOMETHING_ELSE: 'x',
      NODE_OPTIONS: '--require /evil.js --max-old-space-size=4096 --import=./evil.mjs',
    });
    assert.deepEqual(env, {
      PATH: '/bin',
      HOME: '/home/x',
      TSC_LAWS_BIN: '/x/tsc',
      TSLAWS_JOBS: '2',
      NODE_OPTIONS: '--max-old-space-size=4096',
    });
  });
});

describe('a report from the laws, which the token holder does not trust', () => {
  const expected = {
    laws: new Set(['a.laws.ts::one', 'a.laws.ts::two']),
    lock: new Set(['a.laws.ts::gone']),
    exempt: new Set(['src/x.ts::skip']),
  };
  const result = (name: string, extra: Record<string, unknown> = {}) => ({
    file: 'a.laws.ts',
    name,
    line: 3,
    status: 'proved',
    method: 'smt',
    ...extra,
  });
  const report = (results: unknown[], extra: Record<string, unknown> = {}) => ({
    results,
    compileDiagnostics: '',
    compileOk: true,
    lockMissing: false,
    notices: [],
    ok: true,
    ...extra,
  });
  const good = () => [result('one'), result('two')];

  it('accepts what a check reports', () => {
    const read = readReport(
      report([
        ...good(),
        result('gone', {
          status: 'tampered',
          method: 'lock',
          line: 0,
          proposal: { reason: 'removed', status: 'proved', method: 'lock' },
        }),
        { file: 'src/x.ts', name: 'skip', line: 1, status: 'uncovered', method: 'coverage' },
      ]),
      expected,
    );
    assert.equal(read.results.length, 4);
    assert.equal(read.ok, false, 'the parent works out ok itself');
  });
  it('rebuilds each result and drops the fields it does not check', () => {
    const read = readReport(
      report([
        result('one', {
          certificate: { status: 'certified', problemHash: 'a', proofHash: 'b', checkerHash: 'c' },
          exercises: [{ name: 'x' }],
          extra: 'x',
          __proto__: { polluted: true },
        }),
        result('two', {
          status: 'tampered',
          proposal: {
            reason: 'added',
            status: 'proved',
            method: 'smt',
            certificate: { status: 'certified', problemHash: 'a', proofHash: 'b', checkerHash: 'c' },
            extra: 1,
          },
        }),
      ]),
      expected,
    );
    for (const r of read.results) {
      assert.deepEqual(
        Object.keys(r).filter((k) => !['file', 'name', 'line', 'status', 'method', 'proposal'].includes(k)),
        [],
      );
      assert.equal((r as unknown as Record<string, unknown>).certificate, undefined);
    }
    const proposal = read.results[1]!.proposal as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(proposal).sort(), ['method', 'reason', 'status']);
  });
  it('works out ok itself rather than taking it', () => {
    const read = readReport(report([result('one'), result('two', { status: 'failed' })], { ok: true }), expected);
    assert.equal(read.ok, false);
  });
  it('refuses a result for a law the project does not have', () => {
    assert.throws(() => readReport(report([...good(), result('forged')]), expected), /not a law of this project/);
    assert.throws(
      () => readReport(report([...good(), result('gone', { status: 'proved' })]), expected),
      /not a law of this project/,
    );
    assert.throws(
      () =>
        readReport(
          report([
            ...good(),
            result('nope', { status: 'tampered', proposal: { reason: 'removed', status: 'proved', method: 'lock' } }),
          ]),
          expected,
        ),
      /not a law of this project/,
    );
  });
  it('refuses a report with a law missing or reported twice', () => {
    assert.throws(() => readReport(report([result('one')]), expected), /two has no result|::two has no result/);
    assert.throws(() => readReport(report([...good(), result('one')]), expected), /reported twice/);
  });
  it('refuses the wrong types and oversized values', () => {
    assert.throws(() => readReport(null, expected), /not valid/);
    assert.throws(() => readReport([], expected), /not valid/);
    assert.throws(() => readReport(report([{ file: 1 }]), expected), /not valid/);
    assert.throws(() => readReport(report('one'), expected), /not valid/);
    assert.throws(() => readReport(report(good(), { compileOk: 'yes' }), expected), /not a boolean/);
    assert.throws(() => readReport(report(good(), { notices: [1] }), expected), /not text/);
    const bad = (extra: Record<string, unknown>) => readReport(report([result('one', extra), result('two')]), expected);
    assert.throws(() => bad({ status: 'great' }), /no status/);
    assert.throws(() => bad({ line: '3' }), /line/);
    assert.throws(() => bad({ line: -1 }), /line/);
    assert.throws(() => bad({ runs: 1.5 }), /runs/);
    assert.throws(() => bad({ runs: 1e12 }), /runs/);
    assert.throws(() => bad({ seed: 'x' }), /seed/);
    assert.doesNotThrow(() => bad({ seed: -123456 }));
    assert.throws(() => bad({ message: 5 }), /not text/);
    assert.throws(() => bad({ message: 'x'.repeat(20001) }), /longer than/);
    assert.throws(() => bad({ counterexample: 'x'.repeat(20001) }), /longer than/);
    assert.throws(() => bad({ method: 'x'.repeat(201) }), /longer than/);
    assert.throws(() => bad({ assumptions: 'x' }), /assumptions/);
    assert.throws(() => bad({ assumptions: Array.from({ length: 101 }, () => 'x') }), /assumptions/);
    assert.throws(() => bad({ screenshot: '../../etc/passwd' }), /leaves the project/);
    assert.throws(() => bad({ screenshot: '/etc/passwd' }), /leaves the project/);
    assert.throws(() => bad({ proposal: { reason: 'sure', status: 'proved', method: 'm' } }), /no reason/);
    assert.throws(() => bad({ proposal: { reason: 'added', status: 'tampered', method: 'm' } }), /no status/);
    assert.throws(
      () => bad({ proposal: { reason: 'added', status: 'proved', method: 'm', message: 'x'.repeat(20001) } }),
      /longer than/,
    );
  });
});

describe('a law in a GitHub run', () => {
  it('cannot read a token in merge', async () => {
    const { dir, probe } = project();
    const { code, out, calls } = await run('merge', dir);
    assert.equal(code, 0, out);
    assertTokenFree(probe);
    assert.ok(calls.length > 0, 'the parent still talks to GitHub');
  });
  it('cannot read a token in report', async () => {
    const { dir, probe } = project();
    const { out } = await run('report', dir);
    assert.ok(existsSync(probe), out);
    assertTokenFree(probe);
  });
});

describe('the laws in one job and the token in another', () => {
  it('hands the reports over as data, and merge acts on them without running a law', async () => {
    const { dir, probe } = project();
    const results = join(dir, 'results.json');
    // The laws job holds no token at all.
    const collected = await run('merge', dir, { 'results-out': results }, { GITHUB_TOKEN: '' });
    assert.equal(collected.code, 0, collected.out);
    assertTokenFree(probe);
    assert.equal(collected.calls.length, 0, 'collecting needs no GitHub');
    assert.ok(!readFileSync(results, 'utf8').includes(secret));
    rmSync(probe);

    const applied = await run('merge', dir, { results });
    assert.equal(applied.code, 0, applied.out);
    assert.ok(!existsSync(probe), 'the laws did not run again');
    assert.ok(
      applied.calls.some((c) => c.method !== 'GET'),
      'the lock was written',
    );
  });
  it('does the same for report', async () => {
    const { dir, probe } = project();
    const results = join(dir, 'results.json');
    assert.equal((await run('report', dir, { 'results-out': results })).code, 0);
    rmSync(probe);
    const applied = await run('report', dir, { results });
    assert.ok(!existsSync(probe), 'the laws did not run again');
    assert.match(applied.out, /probe/);
  });
  it('refuses a results file that names a law the project does not have, or leaves one out', async () => {
    const { dir } = project();
    const results = join(dir, 'results.json');
    await run('merge', dir, { 'results-out': results });
    const original = readFileSync(results, 'utf8');
    const forged = JSON.parse(original);
    forged.projects[''].report.results.push({
      file: 'a.laws.ts',
      name: 'forged',
      line: 1,
      status: 'proved',
      method: 'smt',
      certificate: { status: 'certified', problemHash: 'a', proofHash: 'b', checkerHash: 'c' },
    });
    writeFileSync(results, JSON.stringify(forged));
    const extra = await run('merge', dir, { results });
    assert.notEqual(extra.code, 0);
    assert.match(extra.out, /not a law of this project/);
    assert.ok(
      extra.calls.every((c) => c.method === 'GET'),
      'nothing was written',
    );

    const missing = JSON.parse(original);
    missing.projects[''].report.results = [];
    writeFileSync(results, JSON.stringify(missing));
    const none = await run('merge', dir, { results });
    assert.notEqual(none.code, 0);
    assert.match(none.out, /has no result/);
  });
  it('refuses results for another commit or another mode, and a changed lock', async () => {
    const { dir } = project();
    const results = join(dir, 'results.json');
    await run('merge', dir, { 'results-out': results });
    const wrongSha = await run('merge', dir, { results }, {}, hex('e'));
    assert.notEqual(wrongSha.code, 0);
    assert.match(wrongSha.out, /made for commit/);
    const otherMode = await run('report', dir, { results });
    assert.notEqual(otherMode.code, 0);
    assert.match(otherMode.out, /holds results for merge/);
    const stale = JSON.parse(readFileSync(results, 'utf8'));
    stale.projects[''].lockSha = 'not the lock';
    writeFileSync(results, JSON.stringify(stale));
    const changed = await run('merge', dir, { results });
    assert.notEqual(changed.code, 0);
    assert.match(changed.out, /lock is not the one/);
  });
});
