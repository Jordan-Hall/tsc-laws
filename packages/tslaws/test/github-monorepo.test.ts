// The GitHub flow across a monorepo from the root: one comment, one commit for every lock, approvals scoped to their
// project, a project list the pull request cannot steer, and what a package keeps for itself. The API is a stand-in;
// the projects are real directories, so the tests that run laws need TSC_LAWS_BIN.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../dist/compile.js';
import { readConfig } from '../dist/coverage.js';
import { acceptedFingerprints, proposalsOf, readApprovals, recordComment } from '../dist/github.js';
import { githubCommand, joinRepo, projectState } from '../dist/githubCli.js';
import type { Unit } from '../dist/githubCli.js';
import { lockChanges, writeLock } from '../dist/lock.js';
import { discoverFromFiles, discoverProjects } from '../dist/projects.js';

const compiler = process.env.TSC_LAWS_BIN;
const needsCompiler = { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false };
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'tslaws.js');
const scratch = mkdtempSync(join(here, '..', '.tmp-ghmono-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const good = 'export const dbl = (a: number): number => a + a;\n';
const goodLaws = [
  "import { dbl } from './f';",
  'export law dblIsTwice(a: number) => Object.is(dbl(a), a * 2);',
  '',
].join('\n');
const app = 'tslaws-app[bot]';

function repo(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(scratch, 'r-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

/** A package with the same law as every other, so every package proposes the same fingerprint. */
function pkg(
  name: string,
  github: object | undefined,
  extra: Record<string, unknown> = {},
): Record<string, string | object> {
  return {
    [`packages/${name}/tslaws.json`]: { ...(github === undefined ? {} : { github }), ...extra },
    [`packages/${name}/src/f.ts`]: good,
    [`packages/${name}/src/f.laws.ts`]: goodLaws,
  };
}

const unit = (root: string, rel: string): Unit => ({
  cwd: join(root, rel),
  rel,
  path: rel,
  options: {
    files: ['src/f.laws.ts'],
    cwd: join(root, rel),
    runs: 20,
    compiler: compiler!,
    lockFile: join(root, rel, 'tsc-laws.lock'),
    noProve: true,
    noRegressions: true,
    bound: 4,
    proofTimeoutMs: 5000,
  },
});

/** Writes the lock a person would have accepted. */
function accepted(root: string, rel: string): void {
  writeLock(join(root, rel, 'tsc-laws.lock'), readManifest(compiler!, ['src/f.laws.ts'], join(root, rel)));
}

interface Call {
  method: string;
  path: string;
  body?: any;
}

function fake(handler: (method: string, path: string, body: any) => unknown) {
  const calls: Call[] = [];
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    calls.push({ method, path, body });
    const value = handler(method, path.replace(/[?&]per_page=100&page=\d+$/, ''), body);
    if (value instanceof Error) throw value;
    return value;
  };
  return { api, calls };
}

const missing = new Error('GitHub: 404 Not Found');
const b64 = (text: string) => ({ content: Buffer.from(text).toString('base64'), sha: 'blob' });

async function run(
  mode: string,
  root: string,
  rels: string[],
  api: (method: string, path: string, body?: unknown) => Promise<unknown>,
  payload: object,
  flags: [string, string | true][] = [],
  discovered: string[] = rels,
  projects: Unit[] | undefined = undefined,
) {
  const eventFile = join(scratch, `event-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(eventFile, JSON.stringify(payload));
  let out = '';
  const units = projects ?? rels.map((rel) => unit(root, rel));
  const code = await githubCommand(mode, {
    cwd: root,
    projectPath: '',
    options: units[0]!.options,
    projects: units,
    discovered,
    optionsFor: (rel) => (existsSync(join(root, rel, 'tslaws.json')) ? unit(root, rel).options : undefined),
    env: { GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: 'ref' in payload ? 'push' : '' },
    flags: new Map(flags),
    out: (text) => void (out += text),
    err: (text) => void (out += text),
    api,
  });
  return { code, out };
}

const rootProjects = { 'tslaws.json': { projects: ['packages/*'] } };

describe('report from the root', needsCompiler, () => {
  it('writes one sticky comment with a section per project and a line for the quiet ones', async () => {
    const root = repo({
      ...rootProjects,
      ...pkg('a', { bot: 'tslaws[bot]' }),
      ...pkg('b', { bot: 'tslaws[bot]' }),
      ...pkg('c', { bot: 'tslaws[bot]' }),
    });
    accepted(root, 'packages/c');
    const { api, calls } = fake((_m, path) => (path.endsWith('/comments') ? [] : undefined));
    const { code, out } = await run(
      'report',
      root,
      ['packages/a', 'packages/b', 'packages/c'],
      api,
      { pull_request: { number: 7, head: { sha: 'f'.repeat(40) } } },
      [
        ['pr', '7'],
        ['comment', true],
      ],
    );
    assert.equal(code, 0, out);
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1, 'one comment for the whole repository');
    const body = posts[0]!.body.body as string;
    assert.ok(body.startsWith('<!-- tslaws-proposals -->'));
    assert.match(body, /#### `packages\/a`/);
    assert.match(body, /#### `packages\/b`/);
    assert.match(body, /No change in `packages\/c`\./);
    assert.match(out, /::notice file=packages\/a\/src\/f\.laws\.ts,line=\d+,title=tslaws proposal%3A dblIsTwice/);
    assert.match(out, /::notice file=packages\/b\/src\/f\.laws\.ts/);
    assert.match(out, /2 proposal\(s\) in 3 project\(s\)/);
  });

  it('leaves a project that owns its flow out, and says so', async () => {
    const root = repo({
      ...rootProjects,
      ...pkg('a', { bot: 'tslaws[bot]' }),
      ...pkg('b', { bot: 'tslaws[bot]', flow: 'own' }),
    });
    const { api, calls } = fake((_m, path) => (path.endsWith('/comments') ? [] : undefined));
    const { code, out } = await run(
      'report',
      root,
      ['packages/a', 'packages/b'],
      api,
      { pull_request: { number: 7, head: { sha: 'f'.repeat(40) } } },
      [
        ['pr', '7'],
        ['comment', true],
      ],
    );
    assert.equal(code, 0, out);
    const body = calls.find((c) => c.method === 'POST')!.body.body as string;
    assert.match(body, /packages\/a/);
    assert.doesNotMatch(body, /packages\/b/);
    assert.match(out, /packages\/b has "flow": "own"/);
    assert.doesNotMatch(out, /file=packages\/b\//);
  });

  it("reads each package's own github block over a root base, and fails on its own bad one without hiding the rest", async () => {
    const root = repo({
      ...rootProjects,
      'base.json': { github: { bot: 'tslaws[bot]', approvers: ['write'] } },
      ...pkg('a', { approvers: ['author'] }, { extends: '../../base.json' }),
      ...pkg('b', undefined, { extends: '../../base.json' }),
    });
    assert.deepEqual(readConfig(join(root, 'packages/a')).github, { bot: 'tslaws[bot]', approvers: ['author'] });
    assert.deepEqual(readConfig(join(root, 'packages/b')).github, { bot: 'tslaws[bot]', approvers: ['write'] });
  });
});

describe('merge from the root', needsCompiler, () => {
  const before = 'a'.repeat(40);
  const after_ = 'c'.repeat(40);
  const tree = (rels: string[]) => ({
    tree: ['tslaws.json', ...rels.map((r) => `${r}/tslaws.json`)].map((path) => ({ path, type: 'blob' })),
  });
  const routes =
    (rels: string[], extra: (method: string, path: string) => unknown = () => undefined) =>
    (method: string, path: string, body: unknown) => {
      const given = extra(method, path);
      if (given !== undefined) return given;
      if (path.includes('/git/trees/') && method === 'GET') return tree(rels);
      if (path.includes('/contents/tslaws.json?ref=')) return b64(JSON.stringify({ projects: ['packages/*'] }));
      if (path.includes('/contents/package.json?ref=') || path.includes('/contents/pnpm-workspace.yaml?ref='))
        return missing;
      if (path.endsWith('/pulls')) return [];
      if (path.includes('/contents/') && method === 'GET') return missing;
      if (path.includes('/git/ref/heads/')) return { object: { sha: 'h'.repeat(40) } };
      if (path.includes('/git/commits/')) return { tree: { sha: 't0' } };
      if (path.endsWith('/git/trees')) return { sha: 't1' };
      if (path.endsWith('/git/commits')) return { sha: 'n1' };
      void body;
      return {};
    };
  const push = (commits: object[]) => ({ ref: 'refs/heads/master', before, after: after_, commits });

  it('writes every changed lock in one commit, and skips only the project whose lock someone else changed', async () => {
    const root = repo({
      ...rootProjects,
      ...pkg('a', { bot: 'tslaws[bot]' }),
      ...pkg('b', { bot: 'tslaws[bot]' }),
      ...pkg('c', { bot: 'tslaws[bot]' }),
    });
    const rels = ['packages/a', 'packages/b', 'packages/c'];
    const outside = { id: 'd'.repeat(40), modified: ['packages/c/tsc-laws.lock'], author: { username: 'mallory' } };
    const { api, calls } = fake(
      routes(rels, (_m, path) =>
        path.includes(`/commits/${outside.id}`)
          ? { author: { login: 'mallory' }, commit: { verification: { verified: false } } }
          : undefined,
      ),
    );
    const { code, out } = await run('merge', root, rels, api, push([outside]));
    assert.equal(code, 1, 'a project that cannot be accepted fails the job');
    assert.match(out, /packages\/c\/tsc-laws\.lock but was not made by tslaws\[bot\]/);
    const commits = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/git/commits'));
    assert.equal(commits.length, 1, 'one commit');
    const written = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/git/trees'))[0]!.body.tree;
    assert.deepEqual(
      written.map((entry: { path: string }) => entry.path),
      ['packages/a/tsc-laws.lock', 'packages/b/tsc-laws.lock'],
    );
    assert.match(written[0].content, /dblIsTwice/);
    const moved = calls.find((c) => c.method === 'PATCH')!;
    assert.match(moved.path, /git\/refs\/heads\/master$/);
    assert.equal(moved.body.force, false);
    assert.match(commits[0]!.body.message, /accept 2 law changes in 2 projects/);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    assert.ok(!existsSync(join(root, 'packages/c/tsc-laws.lock')));
  });

  it('writes a single changed lock through the contents API', async () => {
    const root = repo({ ...rootProjects, ...pkg('a', { bot: 'tslaws[bot]' }), ...pkg('b', { bot: 'tslaws[bot]' }) });
    accepted(root, 'packages/b');
    const { api, calls } = fake(routes(['packages/a', 'packages/b']));
    const { code, out } = await run('merge', root, ['packages/a', 'packages/b'], api, push([]));
    assert.equal(code, 0, out);
    const puts = calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(
      puts.map((c) => c.path),
      ['/repos/o/r/contents/packages/a/tsc-laws.lock'],
    );
    assert.equal(calls.filter((c) => c.path.endsWith('/git/commits')).length, 0);
  });

  /** A record comment by the bot, for the proposals of the project at `rel`. */
  function approval(root: string, rel: string, by: string, project: string | undefined) {
    const state = projectState(unit(root, rel).options);
    const items = proposalsOf(lockChanges(state.lock, state.laws, state.exempt, state.levels), undefined, rel).map(
      (p) => ({ key: p.key, fingerprint: p.fingerprint }),
    );
    return {
      id: 1,
      user: { login: app },
      created_at: '2026-01-01T00:00:00Z',
      body: recordComment([{ verb: 'accept', by, sha: 'h', ...(project === undefined ? {} : { project }), items }]),
    };
  }
  const pull = {
    number: 9,
    user: { login: 'dev', type: 'User' },
    head: { sha: 'h' },
    base: { ref: 'master', sha: 'b' },
  };
  const commentMode = (extra: object = {}) => ({ bot: app, accept: 'comment', ...extra });
  const commentRoutes = (rels: string[], comments: object[]) =>
    routes(rels, (_m, path) => {
      if (path.endsWith('/commits/' + after_ + '/pulls')) return [pull];
      if (path.endsWith('/issues/9/comments')) return comments;
      if (path.includes('/collaborators/')) return { permission: 'write' };
      if (path.endsWith('/pulls/9/reviews')) return [];
      return undefined;
    });

  it('counts an accept only for the project it names, though another project proposes the same law', async () => {
    const root = repo({ ...rootProjects, ...pkg('a', commentMode()), ...pkg('b', commentMode()) });
    const rels = ['packages/a', 'packages/b'];
    const { api, calls } = fake(commentRoutes(rels, [approval(root, 'packages/b', 'dev', 'packages/b')]));
    const { code, out } = await run('merge', root, rels, api, push([]));
    assert.equal(code, 1, 'packages/a is held');
    assert.deepEqual(
      calls.filter((c) => c.method === 'PUT').map((c) => c.path),
      ['/repos/o/r/contents/packages/b/tsc-laws.lock'],
    );
    assert.match(out, /packages\/a/);
    assert.match(out, /nobody with authority accepted this version/);
  });

  it('takes a record with no project for the root only', async () => {
    const root = repo({ ...rootProjects, ...pkg('a', commentMode()) });
    const { api, calls } = fake(commentRoutes(['packages/a'], [approval(root, 'packages/a', 'dev', undefined)]));
    const { code } = await run('merge', root, ['packages/a'], api, push([]));
    assert.equal(code, 1);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  });

  it("counts an accept only from the package's own approvers", async () => {
    const root = repo({
      ...rootProjects,
      ...pkg('a', commentMode({ approvers: ['reviewers'] })),
      ...pkg('b', commentMode({ approvers: ['author'] })),
    });
    const rels = ['packages/a', 'packages/b'];
    const comments = [
      approval(root, 'packages/a', 'dev', 'packages/a'),
      approval(root, 'packages/b', 'dev', 'packages/b'),
    ];
    comments[1]!.id = 2;
    const { api, calls } = fake(commentRoutes(rels, comments));
    const { out } = await run('merge', root, rels, api, push([]));
    assert.deepEqual(
      calls.filter((c) => c.method === 'PUT').map((c) => c.path),
      ['/repos/o/r/contents/packages/b/tsc-laws.lock'],
    );
    assert.match(out, /ignoring the records of @dev on #9: no longer an approver/);
  });

  it('does not take a standalone project into a root run', async () => {
    const root = repo({
      ...rootProjects,
      ...pkg('a', { bot: 'tslaws[bot]' }),
      ...pkg('s', { bot: 'tslaws[bot]' }, { standalone: true }),
    });
    const listed = discoverProjects(root).map((p) => p.path);
    assert.deepEqual(listed, ['packages/a']);
    const { api, calls } = fake(routes(['packages/a', 'packages/s']));
    const { code, out } = await run('merge', root, ['packages/a'], api, push([]), [], ['packages/a', 'packages/s']);
    assert.equal(code, 0, out);
    assert.deepEqual(
      calls.filter((c) => c.method === 'PUT').map((c) => c.path),
      ['/repos/o/r/contents/packages/a/tsc-laws.lock'],
    );
  });

  it('still checks a project the push no longer discovers, if it was one on the base commit', async () => {
    const root = repo({ ...rootProjects, ...pkg('a', { bot: 'tslaws[bot]' }), ...pkg('b', { bot: 'tslaws[bot]' }) });
    accepted(root, 'packages/a');
    accepted(root, 'packages/b');
    // The base had both projects; the pushed tslaws.json now lists one.
    const { api } = fake(routes(['packages/a', 'packages/b']));
    const { code, out } = await run('merge', root, ['packages/a'], api, push([]), [], ['packages/a']);
    assert.equal(code, 1);
    assert.match(out, /packages\/b was a project before this push and still exists, but is no longer discovered/);
  });
});

describe('command from the root', needsCompiler, () => {
  const sha = 'e'.repeat(40);
  async function say(body: string, github: Record<string, object>, replyTo: string[] = ['packages/a', 'packages/b']) {
    const root = repo({
      ...rootProjects,
      ...pkg('a', github.a ?? { bot: app, accept: 'comment' }),
      ...pkg('b', github.b ?? { bot: app, accept: 'comment' }),
    });
    const { api, calls } = fake((method, path) => {
      if (path.endsWith('/pulls/5')) return { number: 5, user: { login: 'dev', type: 'User' }, head: { sha } };
      if (path.includes('/collaborators/')) return { permission: 'write' };
      if (path.endsWith('/pulls/5/reviews')) return [];
      return method === 'POST' ? {} : [];
    });
    const result = await run(
      'command',
      root,
      replyTo,
      api,
      {
        action: 'created',
        issue: { number: 5, pull_request: {} },
        comment: { id: 77, body, user: { login: 'dev', type: 'User' } },
      },
      [['head-sha', sha]],
    );
    const posts = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/issues/5/comments'));
    const records = posts.flatMap((c) =>
      readApprovals([{ id: 1, body: c.body.body, user: { login: app }, created_at: 'x' }], app),
    );
    return { ...result, posts, records };
  }

  it('routes an accept to the project its path names', async () => {
    const { records, posts } = await say('/tslaws accept packages/a/src/f.laws.ts::dblIsTwice', {});
    assert.equal(posts.length, 2);
    assert.deepEqual(
      records.map((r) => r.project),
      ['packages/a'],
    );
    assert.equal(records[0]!.items[0]!.key, 'src/f.laws.ts::dblIsTwice');
  });

  it('refuses a --project with no directory instead of reading it as every project', async () => {
    for (const text of [
      '/tslaws accept --project',
      '/tslaws accept dblIsTwice --project',
      '/tslaws accept --project --other',
      '/tslaws accept --project=',
    ]) {
      const { records, posts } = await say(text, {});
      assert.deepEqual(records, [], text);
      assert.equal(posts.length, 1, text);
      assert.match(posts[0]!.body.body, /`--project` needs a directory/, text);
    }
  });

  it('routes an accept to the project --project names', async () => {
    const { records } = await say('/tslaws accept dblIsTwice --project packages/b', {});
    assert.deepEqual(
      records.map((r) => r.project),
      ['packages/b'],
    );
    const equals = await say('/tslaws accept dblIsTwice --project=packages/a', {});
    assert.deepEqual(
      equals.records.map((r) => r.project),
      ['packages/a'],
    );
  });

  it('asks for the path or --project when a bare name is in several projects, and records nothing', async () => {
    const { records, posts, out } = await say('/tslaws accept dblIsTwice', {});
    assert.deepEqual(records, []);
    assert.equal(posts.length, 1);
    assert.match(posts[0]!.body.body, /names laws in several files or projects/);
    assert.match(posts[0]!.body.body, /--project/);
    void out;
  });

  it('accepts all only where the commenter is an approver of that package', async () => {
    const { records, posts } = await say('/tslaws accept all', {
      a: { bot: app, accept: 'comment', approvers: ['reviewers'] },
      b: { bot: app, accept: 'comment', approvers: ['author'] },
    });
    assert.deepEqual(
      records.map((r) => r.project),
      ['packages/b'],
    );
    assert.match(posts[0]!.body.body, /“packages\/a”: not recorded/);
  });

  describe('approving the pull request', () => {
    /** `change` edits the head's files (what the pull request does) and says which files it touched. */
    async function approve(
      body: string,
      github: Record<string, object>,
      change?: (files: Record<string, string>) => string[],
    ) {
      const source = { ...rootProjects, ...pkg('a', github.a), ...pkg('b', github.b) };
      const root = repo(source);
      const base: Record<string, string> = Object.fromEntries(
        Object.entries(source).map(([file, content]) => [
          file,
          typeof content === 'string' ? content : JSON.stringify(content),
        ]),
      );
      const head = { ...base };
      const changed = change?.(head) ?? [];
      const snapshots: Record<string, Record<string, string>> = { b: base, [sha]: head };
      const { api, calls } = fake((method, path) => {
        if (path.endsWith('/pulls/5'))
          return { number: 5, user: { login: 'dev', type: 'User' }, head: { sha }, base: { ref: 'master', sha: 'b' } };
        if (path.endsWith('/pulls/5/files')) return changed.map((filename) => ({ filename }));
        const tree = /\/git\/trees\/(\w+)\?recursive=1$/.exec(path);
        if (tree) return { tree: Object.keys(snapshots[tree[1]!]!).map((p) => ({ path: p, type: 'blob' })) };
        const file = /\/contents\/(.+)\?ref=(\w+)$/.exec(path);
        if (file) {
          const text = snapshots[file[2]!]?.[file[1]!];
          return text === undefined ? missing : b64(text);
        }
        if (path.includes('/collaborators/')) return { permission: 'write' };
        if (path.endsWith('/pulls/5/reviews')) return method === 'POST' ? {} : [];
        if (method === 'GET' && path.endsWith('/issues/5/comments'))
          return calls
            .filter((c) => c.method === 'POST' && c.path.endsWith('/issues/5/comments'))
            .map((c, id) => ({ id, body: c.body.body, user: { login: app }, created_at: 'x' }));
        return method === 'POST' ? {} : [];
      });
      await run(
        'command',
        root,
        ['packages/a', 'packages/b'],
        api,
        {
          action: 'created',
          issue: { number: 5, pull_request: {} },
          comment: { id: 77, body, user: { login: 'dev', type: 'User' } },
        },
        [['head-sha', sha]],
      );
      return calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pulls/5/reviews'));
    }
    const optIn = { bot: app, accept: 'comment', approvePullRequest: true };

    it('approves when every project with proposals is accepted and opted in', async () => {
      const reviews = await approve('/tslaws accept all', { a: optIn, b: optIn });
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0]!.body.event, 'APPROVE');
    });

    it('does not approve while another project still has a pending proposal', async () => {
      const reviews = await approve('/tslaws accept all --project packages/a', { a: optIn, b: optIn });
      assert.deepEqual(reviews, []);
    });

    it('does not approve when the project that holds a proposal has not opted in', async () => {
      const reviews = await approve('/tslaws accept all', { a: optIn, b: { bot: app, accept: 'comment' } });
      assert.deepEqual(reviews, []);
    });

    it('does not approve when a project with proposals was declined for the commenter', async () => {
      const reviews = await approve('/tslaws accept all', { a: optIn, b: { ...optIn, approvers: ['reviewers'] } });
      assert.deepEqual(reviews, []);
    });

    it('does not approve when the pull request changes how projects are found', async () => {
      const reviews = await approve('/tslaws accept all', { a: optIn, b: optIn }, (head) => {
        head['tslaws.json'] = JSON.stringify({ projects: ['packages/a'] });
        return ['tslaws.json'];
      });
      assert.deepEqual(reviews, []);
    });

    it('does not approve when the pull request makes a project standalone or hands it its own flow', async () => {
      const standalone = await approve('/tslaws accept all', { a: optIn, b: optIn }, (head) => {
        head['packages/b/tslaws.json'] = JSON.stringify({ github: optIn, standalone: true });
        return ['packages/b/tslaws.json'];
      });
      assert.deepEqual(standalone, []);
      const own = await approve('/tslaws accept all', { a: optIn, b: optIn }, (head) => {
        head['packages/b/tslaws.json'] = JSON.stringify({ github: { ...optIn, flow: 'own' } });
        return ['packages/b/tslaws.json'];
      });
      assert.deepEqual(own, []);
    });

    it('does not approve when the pull request adds a project the base did not have', async () => {
      const reviews = await approve('/tslaws accept all', { a: optIn, b: optIn }, (head) => {
        head['packages/c/tslaws.json'] = JSON.stringify({ github: optIn });
        head['packages/c/src/f.laws.ts'] = '';
        return ['packages/c/tslaws.json'];
      });
      assert.deepEqual(reviews, []);
    });

    it('does not approve past a project that runs its own flow and has a proposal', async () => {
      const reviews = await approve('/tslaws accept all', { a: optIn, b: { ...optIn, flow: 'own' } });
      assert.deepEqual(reviews, []);
    });
  });
});

describe('approvals are scoped to a project', () => {
  const record = (project: string | undefined, fingerprint = 'f1') => ({
    verb: 'accept' as const,
    by: 'dev',
    sha: 'h',
    ...(project === undefined ? {} : { project }),
    items: [{ key: 'src/f.laws.ts::x', fingerprint }],
  });
  it('counts a record for its own project only, and a record with none for the root', () => {
    const records = [record('packages/a'), record(undefined, 'f2')];
    assert.deepEqual([...acceptedFingerprints(records, 'packages/a').keys()], ['f1']);
    assert.deepEqual([...acceptedFingerprints(records, 'packages/b').keys()], []);
    assert.deepEqual([...acceptedFingerprints(records).keys()], ['f2']);
    assert.deepEqual([...acceptedFingerprints(records, '').keys()], ['f2']);
  });
  it('lets a later reject withdraw an accept in the same project only', () => {
    const reject = { ...record('packages/a'), verb: 'reject' as const };
    assert.equal(acceptedFingerprints([record('packages/a'), reject], 'packages/a').size, 0);
    assert.equal(acceptedFingerprints([record('packages/b'), reject], 'packages/b').size, 1);
  });
  it('round-trips the project through a record comment', () => {
    const comment = { id: 1, body: recordComment([record('packages/a')]), user: { login: app }, created_at: 'x' };
    assert.equal(readApprovals([comment], app)[0]!.project, 'packages/a');
    const bad = { ...comment, body: comment.body.replace('"packages/a"', '7') };
    assert.deepEqual(readApprovals([bad], app), []);
  });
});

describe('verify from the root', () => {
  const cfg = JSON.stringify({ github: { bot: 'tslaws[bot]' } });
  const projectsJson = (...globs: string[]) => JSON.stringify({ projects: globs });
  const baseFiles: Record<string, string> = {
    'tslaws.json': projectsJson('packages/*'),
    'packages/a/tslaws.json': cfg,
    'packages/b/tslaws.json': cfg,
    'packages/a/src/f.laws.ts': '',
  };
  const pull = { number: 3, user: { login: 'a', type: 'User' }, head: { sha: 'h' }, base: { ref: 'master', sha: 'b' } };
  /** What the contents API reports for a file that is a symbolic link. */
  const symlink = '@@symlink@@';

  /** The repository at the base and at the head, the files the pull request changes, and verify's verdict. */
  async function verify(head: Record<string, string>, changed: string[], base: Record<string, string> = baseFiles) {
    const snapshots: Record<string, Record<string, string>> = { b: base, h: head };
    const { api } = fake((_method, path) => {
      if (path.endsWith('/pulls/3/files')) return changed.map((filename) => ({ filename }));
      const tree = /\/git\/trees\/(\w+)\?recursive=1$/.exec(path);
      if (tree) return { tree: Object.keys(snapshots[tree[1]!]!).map((p) => ({ path: p, type: 'blob' })) };
      const file = /\/contents\/(.+)\?ref=(\w+)$/.exec(path);
      if (file) {
        const text = snapshots[file[2]!]?.[file[1]!];
        if (text === symlink) return { type: 'symlink', target: 'elsewhere.json' };
        return text === undefined ? missing : b64(text);
      }
      return [];
    });
    const root = repo({});
    return run('verify', root, ['packages/a', 'packages/b'], api, { pull_request: pull }, [], undefined, [
      { cwd: root, rel: '', path: '', options: {} as never },
    ]);
  }

  it('passes a pull request that touches no lock and no discovery file', async () => {
    const { code, out } = await verify(baseFiles, ['packages/a/src/f.laws.ts']);
    assert.equal(code, 0, out);
  });

  it('catches a settings change in an extends base whose file does not end in .json', async () => {
    const base = {
      ...baseFiles,
      'packages/b/tslaws.json': JSON.stringify({ extends: '../../team.jsonc' }),
      'team.jsonc': cfg,
    };
    const head = { ...base, 'team.jsonc': JSON.stringify({ github: { bot: 'someone-else' } }) };
    const { code, out } = await verify(head, ['team.jsonc'], base);
    assert.equal(code, 1, out);
    assert.match(out, /changes the "github" section of packages\/b\/tslaws\.json/);
    const quiet = await verify(base, ['team.txt'], base);
    assert.equal(quiet.code, 0, quiet.out);
  });

  it('fails closed on an extends target it cannot read, a symlink, or a path it will not follow', async () => {
    const extending = (target: string, extra: Record<string, string> = {}) => ({
      ...baseFiles,
      'packages/b/tslaws.json': JSON.stringify({ extends: target }),
      ...extra,
    });
    const unreadable = await verify(extending('../../gone.jsonc'), [], extending('../../gone.jsonc'));
    assert.equal(unreadable.code, 1, unreadable.out);
    assert.match(unreadable.out, /gone\.jsonc is named by "extends" and cannot be read/);
    const linked = await verify(
      extending('../../team.jsonc', { 'team.jsonc': symlink }),
      [],
      extending('../../team.jsonc', { 'team.jsonc': symlink }),
    );
    assert.equal(linked.code, 1, linked.out);
    assert.match(linked.out, /team\.jsonc is not a regular file/);
    for (const target of [
      '/etc/tslaws.json',
      'C:/tslaws.json',
      'base.json?ref=evil',
      'base.json#x',
      'a&b.json',
      'a%2e.json',
      '..\\team.json',
      '../../../outside.json',
    ]) {
      const refused = await verify(extending(target), [], extending(target));
      assert.equal(refused.code, 1, `${target}: ${refused.out}`);
      assert.match(refused.out, /packages\/b: "extends"/, target);
    }
  });

  it('fails when the pull request stops discovering a project the base has', async () => {
    const head = { ...baseFiles, 'tslaws.json': projectsJson('packages/a') };
    const { code, out } = await verify(head, ['tslaws.json']);
    assert.equal(code, 1);
    assert.match(out, /packages\/b is a project on master but the pull request no longer discovers it/);
    assert.match(out, /changes how projects are discovered \(tslaws\.json\)/);
  });

  it('fails when the pull request moves a project out from under the globs', async () => {
    const head = { ...baseFiles };
    delete head['packages/b/tslaws.json'];
    const { code, out } = await verify(head, ['packages/b/tslaws.json']);
    assert.equal(code, 1);
    assert.match(out, /packages\/b is a project on master/);
  });

  it('reports a change to package.json workspaces or pnpm-workspace.yaml like a github-section change', async () => {
    const base = { ...baseFiles, 'tslaws.json': '{}', 'package.json': JSON.stringify({ workspaces: ['packages/*'] }) };
    const head = { ...base, 'package.json': JSON.stringify({ workspaces: ['packages/a'] }) };
    const changedWorkspaces = await verify(head, ['package.json'], base);
    assert.equal(changedWorkspaces.code, 1);
    assert.match(changedWorkspaces.out, /changes how projects are discovered \(package\.json\)/);
    // an edit that leaves the workspaces alone is not a discovery change
    const sameWorkspaces = await verify(
      { ...base, 'package.json': JSON.stringify({ workspaces: ['packages/*'], name: 'x' }) },
      ['package.json'],
      base,
    );
    assert.equal(sameWorkspaces.code, 0, sameWorkspaces.out);
    const pnpmBase = { ...baseFiles, 'tslaws.json': '{}', 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' };
    const pnpmHead = { ...pnpmBase, 'pnpm-workspace.yaml': 'packages:\n  - packages/a\n' };
    const pnpm = await verify(pnpmHead, ['pnpm-workspace.yaml'], pnpmBase);
    assert.equal(pnpm.code, 1);
    assert.match(pnpm.out, /\(pnpm-workspace\.yaml\)/);
  });

  it("flags a lock added or changed anywhere, in a project or not, with that project's bot", async () => {
    const inProject = await verify(baseFiles, ['packages/a/tsc-laws.lock']);
    assert.equal(inProject.code, 1);
    assert.match(inProject.out, /changes packages\/a\/tsc-laws\.lock; only tslaws\[bot\] writes the lock/);
    const stray = await verify(baseFiles, ['tools/scripts/tsc-laws.lock']);
    assert.equal(stray.code, 1);
    assert.match(stray.out, /changes tools\/scripts\/tsc-laws\.lock.*outside every project/);
    const rootLock = await verify(baseFiles, ['tsc-laws.lock']);
    assert.equal(rootLock.code, 1);
  });

  it('flags a changed github section of a project, and of a base the project extends', async () => {
    const head = { ...baseFiles, 'packages/b/tslaws.json': JSON.stringify({ github: { bot: 'evil[bot]' } }) };
    const direct = await verify(head, ['packages/b/tslaws.json']);
    assert.equal(direct.code, 1);
    assert.match(direct.out, /"github" section of packages\/b\/tslaws\.json/);

    const extending = {
      ...baseFiles,
      'base.json': JSON.stringify({ github: { bot: 'tslaws[bot]' } }),
      'packages/a/tslaws.json': JSON.stringify({ extends: '../../base.json' }),
    };
    const headBase = { ...extending, 'base.json': JSON.stringify({ github: { bot: 'evil[bot]' } }) };
    const viaBase = await verify(headBase, ['base.json'], extending);
    assert.equal(viaBase.code, 1);
    assert.match(viaBase.out, /"github" section of packages\/a\/tslaws\.json/);
  });

  it('flags flipping standalone, which decides whether root runs cover a package', async () => {
    const head = {
      ...baseFiles,
      'packages/a/tslaws.json': JSON.stringify({ github: { bot: 'tslaws[bot]' }, standalone: true }),
    };
    const { code, out } = await verify(head, ['packages/a/tslaws.json']);
    assert.equal(code, 1);
    assert.match(out, /"standalone" in packages\/a\/tslaws\.json/);
  });

  it('still checks the lock of a package that runs its own flow, and of a standalone one', async () => {
    const own = {
      ...baseFiles,
      'packages/b/tslaws.json': JSON.stringify({ github: { bot: 'tslaws[bot]', flow: 'own' }, standalone: true }),
    };
    const { code, out } = await verify(own, ['packages/b/tsc-laws.lock'], own);
    assert.equal(code, 1);
    assert.match(out, /changes packages\/b\/tsc-laws\.lock/);
  });
});

describe('a package that stands alone', () => {
  const alone = () =>
    repo({
      ...rootProjects,
      ...pkg('a', { bot: 'tslaws[bot]' }),
      ...pkg('s', { bot: 'tslaws[bot]' }, { standalone: true }),
    });

  it('is left out of a root run unless --project names it, and every project still lists it', () => {
    const root = alone();
    assert.deepEqual(
      discoverProjects(root).map((p) => p.path),
      ['packages/a'],
    );
    assert.deepEqual(
      discoverProjects(root, { only: ['packages/s'] }).map((p) => p.path),
      ['packages/s'],
    );
    assert.deepEqual(
      discoverProjects(root, { standalone: true }).map((p) => `${p.path}:${p.standalone}`),
      ['packages/a:false', 'packages/s:true'],
    );
    const listed = (args: string[]) => {
      const result = spawnSync('node', [bin, 'list', '--json', ...args], { cwd: root, encoding: 'utf8' });
      return Object.keys(JSON.parse(result.stdout) as object);
    };
    assert.deepEqual(listed([]), ['packages/a']);
    assert.deepEqual(listed(['--project', 'packages/s']), ['packages/s']);
  });

  it('is not inherited through extends', () => {
    const root = repo({
      'base.json': { standalone: true, github: { bot: 'tslaws[bot]' } },
      'p/tslaws.json': { extends: '../base.json' },
    });
    assert.equal((readConfig(join(root, 'p')) as { standalone?: unknown }).standalone, undefined);
    const rooted = repo({
      'tslaws.json': { projects: ['p'] },
      'base.json': { standalone: true },
      'p/tslaws.json': { extends: '../base.json' },
    });
    assert.deepEqual(
      discoverProjects(rooted).map((p) => p.path),
      ['p'],
    );
  });

  it('refuses a standalone that is not a boolean', () => {
    const root = repo({ 'tslaws.json': { standalone: 'yes' } });
    assert.throws(() => readConfig(root), /"standalone" must be true or false/);
  });

  it('says so when every project is standalone', () => {
    const root = repo({ 'tslaws.json': { projects: ['p'] }, 'p/tslaws.json': { standalone: true } });
    const result = spawnSync('node', [bin, 'list'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /every project here is standalone/);
  });

  it('is skipped by github at the root, and runs on its own with --project', needsCompiler, () => {
    const root = alone();
    const env = { ...process.env, TSC_LAWS_BIN: compiler!, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: '' };
    const all = spawnSync('node', [bin, 'github', 'report'], { cwd: root, encoding: 'utf8', env });
    assert.equal(all.status, 0, all.stdout + all.stderr);
    // the git prefix of the scratch directory comes first: the repository here is not the project's own
    assert.match(all.stdout, /file=[^,]*packages\/a\/src\/f\.laws\.ts/);
    assert.doesNotMatch(all.stdout, /packages\/s\//);
    const named = spawnSync(
      'node',
      [bin, 'github', 'report', '--project', 'packages/s', '--project-path', 'packages/s'],
      { cwd: root, encoding: 'utf8', env },
    );
    assert.equal(named.status, 0, named.stdout + named.stderr);
    assert.match(named.stdout, /file=packages\/s\/src\/f\.laws\.ts/);
    assert.doesNotMatch(named.stdout, /packages\/a\//);
  });
});

describe('discovery from a file list', () => {
  it('finds what discoverProjects finds on disk', () => {
    const files = ['tslaws.json', 'packages/a/tslaws.json', 'packages/b/tslaws.json', 'node_modules/x/tslaws.json'];
    const inputs = { tslaws: JSON.stringify({ projects: ['packages/*'] }) };
    assert.deepEqual(discoverFromFiles(files, inputs), ['packages/a', 'packages/b']);
    assert.deepEqual(discoverFromFiles(files, { ...inputs, tslaws: JSON.stringify({ projects: ['packages/a'] }) }), [
      'packages/a',
    ]);
    assert.deepEqual(
      discoverFromFiles(files, { tslaws: '{}', packageJson: JSON.stringify({ workspaces: ['packages/*'] }) }),
      ['', 'packages/a', 'packages/b'],
    );
  });
  it('counts the root when it has laws of its own', () => {
    const files = ['tslaws.json', 'src/r.laws.ts', 'packages/a/tslaws.json'];
    assert.deepEqual(discoverFromFiles(files, { tslaws: JSON.stringify({ projects: ['packages/*'] }) }), [
      '',
      'packages/a',
    ]);
  });
  it('joins repository paths', () => {
    assert.equal(joinRepo('', 'a/b'), 'a/b');
    assert.equal(joinRepo('p', ''), 'p');
    assert.equal(joinRepo('p', '/a'), 'p/a');
  });
});
