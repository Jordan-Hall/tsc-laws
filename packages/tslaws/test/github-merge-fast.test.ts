// `github merge` proves only what it will act on: nothing for a project whose lock already records every law, and only the
// changed laws otherwise. Nothing a pull request wrote counts as a proof, so a law the lock does not record is run on the
// merged code, and the lock only ever takes what that run passes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { githubCommand, projectState, type GithubContext } from '../dist/githubCli.js';
import { readReport } from '../dist/isolate.js';
import { acceptChanges, lockChanges, writeLockValue } from '../dist/lock.js';
import type { CheckOptions } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
// Inside the repo so a law file's `tslaws` import resolves through its node_modules.
const root = mkdtempSync(join(here, '..', '.tmp-ghf-'));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const hex = (c: string) => c.repeat(40);
let counter = 0;

/** A law that records its own name in `marker` when it runs, then passes or fails as asked. */
const lawSource = (marker: string, laws: Record<string, boolean>): string =>
  `import { law } from 'tslaws';
const mark = (name: string) => {
  const fs = (globalThis as any).process.getBuiltinModule('node:fs');
  fs.appendFileSync(${JSON.stringify(marker)}, name + '\\n');
};
${Object.entries(laws)
  .map(([name, passes]) => `law('${name}', () => { mark('${name}'); return ${passes}; });`)
  .join('\n')}
`;

function project(files: Record<string, Record<string, boolean>>) {
  const dir = join(root, `p${(counter += 1)}`);
  mkdirSync(join(dir, '.git'), { recursive: true });
  const marker = join(dir, 'ran.txt');
  writeFileSync(join(dir, 'tslaws.json'), JSON.stringify({ github: { bot: 'tslaws[bot]' } }));
  for (const [file, laws] of Object.entries(files)) writeFileSync(join(dir, file), lawSource(marker, laws));
  const options: CheckOptions = {
    cwd: dir,
    files: Object.keys(files),
    compiler: process.env.TSC_LAWS_BIN ?? 'builtin',
    lockFile: join(dir, 'tsc-laws.lock'),
    runs: 5,
    noProve: true,
    bound: 8,
    proofTimeoutMs: 1000,
    noRegressions: true,
    sandbox: false,
  };
  const ran = (): string[] =>
    existsSync(marker)
      ? readFileSync(marker, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .sort()
      : [];
  /** Records every law as it is now, as a person's `tslaws accept` would. */
  const accept = (): void => {
    const state = projectState(options);
    const every = new Set(lockChanges(state.lock, state.laws, state.exempt, state.levels).map((c) => c.fingerprint));
    writeLockValue(options.lockFile, acceptChanges(state.lock, state.laws, state.exempt, state.levels, every));
  };
  return { dir, options, marker, ran, accept };
}

async function merge(
  p: ReturnType<typeof project>,
  comments: object[] = [],
): Promise<{ code: number; out: string; calls: { method: string; path: string; body?: unknown }[] }> {
  writeFileSync(
    join(p.dir, 'event.json'),
    JSON.stringify({ ref: 'refs/heads/master', before: hex('a'), after: hex('c'), commits: [] }),
  );
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let out = '';
  const code = await githubCommand('merge', {
    cwd: p.dir,
    options: p.options,
    env: { GITHUB_EVENT_PATH: join(p.dir, 'event.json'), GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: hex('c') },
    flags: new Map(),
    out: (t) => void (out += t),
    err: (t) => void (out += t),
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method !== 'GET') return {};
      if (path.includes('/contents/tsc-laws.lock')) throw new Error('GitHub GET: 404 not found');
      if (/\/git\/ref\/heads\/[^/]+$/.test(path)) return { object: { sha: hex('c') } };
      if (path.includes('/pulls') && path.includes('/commits/')) return [{ number: 7, user: { login: 'someone' } }];
      if (path.includes('/issues/7/comments')) return comments;
      return [];
    },
  });
  return { code, out, calls };
}

const writes = (calls: { method: string }[]) => calls.filter((c) => c.method === 'PUT' || c.method === 'POST');

describe('github merge runs only what it acts on', () => {
  it('runs no law, writes nothing and says nothing when the lock already records every law', async () => {
    const p = project({ 'a.laws.ts': { first: true, second: true }, 'b.laws.ts': { third: true } });
    p.accept();
    const { code, out, calls } = await merge(p);
    assert.equal(code, 0, out);
    assert.match(out, /already records every law; no law ran/);
    assert.deepEqual(p.ran(), [], 'no law ran');
    assert.deepEqual(writes(calls), [], 'no lock commit and no comment');
  });

  it('runs only the laws the lock does not record, and accepts them', async () => {
    const p = project({ 'a.laws.ts': { first: true, second: true }, 'b.laws.ts': { third: true } });
    p.accept();
    // The merge adds a law and edits one; the other two stay as they were.
    writeFileSync(join(p.dir, 'a.laws.ts'), lawSource(p.marker, { first: true, second: true, fourth: true }));
    writeFileSync(
      join(p.dir, 'b.laws.ts'),
      lawSource(p.marker, { third: true }).replace('return true', 'return !false'),
    );
    const { code, out, calls } = await merge(p);
    assert.equal(code, 0, out);
    assert.deepEqual(p.ran(), ['fourth', 'third'], 'only the added and the changed law ran');
    const put = calls.find((c) => c.method === 'PUT' && c.path.includes('/contents/tsc-laws.lock'));
    assert.ok(put, 'the lock was written');
    const locked = JSON.parse(Buffer.from((put.body as { content: string }).content, 'base64').toString('utf8')) as {
      laws: Record<string, string>;
    };
    assert.deepEqual(Object.keys(locked.laws).sort(), [
      'a.laws.ts::first',
      'a.laws.ts::fourth',
      'a.laws.ts::second',
      'b.laws.ts::third',
    ]);
  });

  it('still holds a changed law that fails, and still accepts the one beside it that passes', async () => {
    const p = project({ 'a.laws.ts': { first: true } });
    p.accept();
    writeFileSync(join(p.dir, 'a.laws.ts'), lawSource(p.marker, { first: true, good: true, bad: false }));
    const { code, out, calls } = await merge(p);
    assert.equal(code, 1, out);
    assert.deepEqual(p.ran(), ['bad', 'good']);
    assert.match(out, /“?bad”?.*not accepted/s);
    const put = calls.find((c) => c.method === 'PUT' && c.path.includes('/contents/tsc-laws.lock'));
    const locked = JSON.parse(Buffer.from((put!.body as { content: string }).content, 'base64').toString('utf8')) as {
      laws: Record<string, string>;
    };
    assert.deepEqual(Object.keys(locked.laws).sort(), ['a.laws.ts::first', 'a.laws.ts::good']);
  });

  it('takes no word from the pull request that a law was already proved', async () => {
    const p = project({ 'a.laws.ts': { first: true } });
    p.accept();
    writeFileSync(join(p.dir, 'a.laws.ts'), lawSource(p.marker, { first: true, bad: false }));
    // A report comment that the pull request's own job could have written, claiming the law passed.
    const forged = [
      {
        user: { login: 'tslaws[bot]', type: 'Bot' },
        body: '<!-- tslaws -->\n- ✅ “bad” (a.laws.ts, added) proved\n',
      },
    ];
    const { code, out, calls } = await merge(p, forged);
    assert.equal(code, 1, out);
    assert.deepEqual(p.ran(), ['bad'], 'the law ran on the merged code anyway');
    assert.deepEqual(
      calls.filter((c) => c.method === 'PUT'),
      [],
      'the failing law reached no lock',
    );
  });
});

describe('a partial check', () => {
  it('runs only the laws it is given, and leaves coverage alone', async () => {
    const p = project({ 'a.laws.ts': { first: true, second: true } });
    p.accept();
    const report = await check({ ...p.options, onlyKeys: ['a.laws.ts::second'] }, true);
    assert.deepEqual(p.ran(), ['second']);
    assert.deepEqual(
      report.results.map((r) => r.name),
      ['second'],
    );
    assert.ok(!report.results.some((r) => r.status === 'uncovered'), 'coverage did not run');
  });

  it('is held to the laws it was asked for, and to the laws of the project', () => {
    const result = (name: string) => ({ file: 'a.laws.ts', name, line: 1, status: 'proved', method: 'property' });
    const body = (names: string[]) => ({
      results: names.map(result),
      compileDiagnostics: '',
      compileOk: true,
      lockMissing: false,
      notices: [],
    });
    const expected = {
      laws: new Set(['a.laws.ts::first', 'a.laws.ts::second']),
      lock: new Set<string>(),
      exempt: new Set<string>(),
      required: new Set(['a.laws.ts::second']),
    };
    assert.equal(readReport(body(['second']), expected).results.length, 1);
    assert.equal(readReport(body(['second', 'first']), expected).results.length, 2);
    assert.throws(() => readReport(body(['first']), expected), /second has no result/);
    assert.throws(() => readReport(body(['second', 'other']), expected), /not a law of this project/);
  });
});

describe('the two-job flow', () => {
  const blobSha = (text: string): string =>
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(text)} `)
      .update(text)
      .digest('hex');

  it('runs only the changed laws in the laws job, and the merge job accepts what they proved', async () => {
    const p = project({ 'a.laws.ts': { first: true, second: true } });
    p.accept();
    writeFileSync(join(p.dir, 'a.laws.ts'), lawSource(p.marker, { first: true, second: true, third: true }));
    const results = join(p.dir, 'results.json');
    const event = { ref: 'refs/heads/master', before: hex('a'), after: hex('c'), commits: [] };
    writeFileSync(join(p.dir, 'event.json'), JSON.stringify(event));
    const context = (flags: Record<string, string>, api: GithubContext['api']): GithubContext => ({
      cwd: p.dir,
      options: p.options,
      env: { GITHUB_EVENT_PATH: join(p.dir, 'event.json'), GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: hex('c') },
      flags: new Map(Object.entries(flags)),
      out: () => {},
      err: () => {},
      api,
    });
    assert.equal(await githubCommand('merge', context({ 'results-out': results }, undefined)), 0);
    assert.deepEqual(p.ran(), ['third'], 'the laws job proved only the new law');

    const lockText = readFileSync(p.options.lockFile, 'utf8');
    const calls: { method: string; path: string }[] = [];
    const code = await githubCommand(
      'merge',
      context({ results }, async (method, path) => {
        calls.push({ method, path });
        if (method !== 'GET') return {};
        if (path.includes('/contents/tsc-laws.lock')) return { sha: blobSha(lockText), content: '' };
        if (/\/git\/ref\/heads\/[^/]+$/.test(path)) return { object: { sha: hex('c') } };
        return [];
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(p.ran(), ['third'], 'the merge job ran nothing');
    assert.ok(
      calls.some((c) => c.method === 'PUT' && c.path.includes('/contents/tsc-laws.lock')),
      'and wrote the lock',
    );
  });

  it('runs nothing in the laws job when the lock records every law', async () => {
    const p = project({ 'a.laws.ts': { first: true } });
    p.accept();
    const results = join(p.dir, 'results.json');
    writeFileSync(
      join(p.dir, 'event.json'),
      JSON.stringify({ ref: 'refs/heads/master', before: hex('a'), after: hex('c') }),
    );
    const code = await githubCommand('merge', {
      cwd: p.dir,
      options: p.options,
      env: { GITHUB_EVENT_PATH: join(p.dir, 'event.json'), GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: hex('c') },
      flags: new Map([['results-out', results]]),
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(p.ran(), []);
  });
});
