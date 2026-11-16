// Accepting laws on GitHub and by hand: `verify` and `merge` let a maintainer change the lock while "local" is true, and
// `merge` also runs on demand (workflow_dispatch). Each case runs the real command against a fake GitHub API.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acceptCommand, runDelegateCommand } from '../dist/cli.js';
import { githubCommand, maintains } from '../dist/githubCli.js';
import { realRoot } from '../dist/delegation.js';
import { promoteFiles } from '../dist/promote.js';

const here = dirname(fileURLToPath(import.meta.url));
// Inside the repo so a law file's `tslaws` import resolves through its node_modules.
const root = mkdtempSync(join(here, '..', '.tmp-ghl-'));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const lockFile = 'tsc-laws.lock';
const b64 = (text: string) => Buffer.from(text).toString('base64');
const hex = (c: string) => c.repeat(40);

interface Call {
  method: string;
  path: string;
  body?: any;
}

interface Scenario {
  event: object;
  env?: Record<string, string>;
  github?: object;
  /** The `github` section the base branch holds (verify reads it from there), when it differs from `github`. */
  base?: object;
  /** Login -> permission. A login that is not listed is not a collaborator. */
  permissions?: Record<string, string>;
  /** What the API says for a path; undefined means an empty list. */
  routes?: (path: string) => unknown;
  laws?: boolean;
  /** The commit the API says the branch is at, when it is not the one the run checked out. */
  head?: string;
}

let counter = 0;

async function run(mode: string, s: Scenario) {
  const dir = join(root, `p${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  const github = s.github ?? { bot: 'tslaws[bot]' };
  writeFileSync(join(dir, 'tslaws.json'), JSON.stringify({ github }));
  // GitHub reports how many files a pull request changes; say so, as many as the fake lists.
  const pr = (s.event as { pull_request?: { number: number; changed_files?: number } }).pull_request;
  const listed = s.routes?.(`/repos/o/r/pulls/${pr?.number}/files`);
  const event =
    pr !== undefined && pr.changed_files === undefined && Array.isArray(listed)
      ? { ...s.event, pull_request: { ...pr, changed_files: listed.length } }
      : s.event;
  writeFileSync(join(dir, 'event.json'), JSON.stringify(event));
  if (s.laws === true) writeFileSync(join(dir, 'a.laws.ts'), "import { law } from 'tslaws';\nlaw('ok', () => true);\n");
  const summaryFile = join(dir, 'summary.md');
  const calls: Call[] = [];
  let out = '';
  const code = await githubCommand(mode, {
    cwd: dir,
    options: {
      cwd: dir,
      files: s.laws === true ? ['a.laws.ts'] : [],
      compiler: 'builtin',
      lockFile: join(dir, lockFile),
      runs: 5,
      noProve: true,
      bound: 8,
      proofTimeoutMs: 1000,
      noRegressions: true,
    },
    env: {
      GITHUB_EVENT_PATH: join(dir, 'event.json'),
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_STEP_SUMMARY: summaryFile,
      ...s.env,
    },
    flags: new Map(),
    out: (t) => void (out += t),
    err: (t) => void (out += t),
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      const clean = path.replace(/[?&]per_page=100&page=\d+$/, '');
      const who = /\/collaborators\/([^/]+)\/permission$/.exec(clean)?.[1];
      if (who !== undefined) {
        const permission = s.permissions?.[decodeURIComponent(who)];
        if (permission === undefined) throw new Error('GitHub GET: 404 not a collaborator');
        return { permission, role_name: permission };
      }
      if (method !== 'GET') return {};
      if (/\/git\/ref\/heads\/[^/]+$/.test(clean) && s.routes?.(clean) === undefined)
        return { object: { sha: s.head ?? s.env?.GITHUB_SHA ?? hex('c') } };
      // verify reads the settings through the API at the base and at the head, never from the checkout. The head's are
      // the base's unless a route says the pull request changed them.
      const baseConfig = { content: b64(JSON.stringify({ github: s.base ?? github })) };
      if (clean.endsWith('/contents/tslaws.json?ref=b')) return baseConfig;
      const value = s.routes?.(clean);
      if (value instanceof Error) throw value;
      if (value === undefined && clean.endsWith('/contents/tslaws.json?ref=h')) return baseConfig;
      return value === undefined ? [] : value;
    },
  });
  const summary = (() => {
    try {
      return readFileSync(summaryFile, 'utf8');
    } catch {
      return '';
    }
  })();
  return { code, out, calls, summary };
}

const wrote = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');
const pull = (login: string, extra: object = {}) => ({
  number: 5,
  user: { login, type: 'User' },
  head: { sha: 'h' },
  base: { ref: 'master', sha: 'b' },
  ...extra,
});

describe('maintains', () => {
  const api = (permission: string | Error) => async () => {
    if (permission instanceof Error) throw permission;
    return { permission, role_name: permission };
  };
  it('is true for admin and maintain only', async () => {
    assert.equal(await maintains(api('admin'), 'o/r', 'a'), true);
    assert.equal(await maintains(api('maintain'), 'o/r', 'a'), true);
    assert.equal(await maintains(api('write'), 'o/r', 'a'), false);
    assert.equal(await maintains(api('triage'), 'o/r', 'a'), false);
  });
  it('is false for a bot, and when the permission cannot be read', async () => {
    assert.equal(await maintains(api('admin'), 'o/r', 'dependabot[bot]'), false);
    assert.equal(await maintains(api('admin'), 'o/r', 'app', 'Bot'), false);
    assert.equal(await maintains(api(new Error('404')), 'o/r', 'a'), false);
  });
});

describe('verify with "local" on', () => {
  const verify = (author: string, extra: Partial<Scenario> = {}) =>
    run('verify', {
      event: { pull_request: pull(author, { base: { ref: 'master', sha: 'b' } }) },
      routes: (path) => (path.endsWith('/files') ? [{ filename: 'src/a.ts' }, { filename: lockFile }] : undefined),
      ...extra,
    });

  it('passes a pull request that changes the lock when its author is an admin', async () => {
    const { code, out } = await verify('owner', { permissions: { owner: 'admin' } });
    assert.equal(code, 0, out);
  });
  it('passes when its author maintains the repository', async () => {
    const { code, out } = await verify('maint', { permissions: { maint: 'maintain' } });
    assert.equal(code, 0, out);
  });
  it('fails when a commit that changes the lock was written by someone without maintain access', async () => {
    const commits = (author: string) => (path: string) => {
      if (path.endsWith('/files')) return [{ filename: 'src/a.ts' }, { filename: lockFile }];
      if (path.endsWith('/pulls/5/commits')) return [{ sha: 'c1' }, { sha: 'c2' }];
      if (path.endsWith('/commits/c1')) return { author: { login: 'owner' }, files: [{ filename: 'src/a.ts' }] };
      if (path.endsWith('/commits/c2')) return { author: { login: author }, files: [{ filename: lockFile }] };
      return undefined;
    };
    const smuggled = await verify('owner', { permissions: { owner: 'admin', dev: 'write' }, routes: commits('dev') });
    assert.equal(smuggled.code, 1);
    assert.match(smuggled.out, /commit c2 in the pull request changes tsc-laws\.lock, but @dev does not have admin/);
    const own = await verify('owner', { permissions: { owner: 'admin', dev: 'write' }, routes: commits('owner') });
    assert.equal(own.code, 0, own.out);
  });
  it('fails when the lock is touched in a commit whose file list is cut short', async () => {
    const { code, out } = await verify('owner', {
      permissions: { owner: 'admin' },
      routes: (path) => {
        if (path.endsWith('/files')) return [{ filename: lockFile }];
        if (path.endsWith('/pulls/5/commits')) return [{ sha: 'c1' }];
        if (path.endsWith('/commits/c1'))
          return { author: null, files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` })) };
        return undefined;
      },
    });
    assert.equal(code, 1);
    assert.match(out, /its author does not have admin or maintain access/);
  });
  it('fails when the pull request has more commits than GitHub lists', async () => {
    const { code, out } = await verify('owner', {
      permissions: { owner: 'admin' },
      routes: (path) => {
        if (path.endsWith('/files')) return [{ filename: lockFile }];
        if (path.endsWith('/pulls/5/commits')) return Array.from({ length: 250 }, (_, i) => ({ sha: `c${i}` }));
        if (path.includes('/commits/c')) return { author: { login: 'owner' }, files: [{ filename: 'src/a.ts' }] };
        return undefined;
      },
    });
    assert.equal(code, 1);
    assert.match(out, /250 or more commits, more than GitHub lists/);
  });
  it('fails when its author only has write access, and says who may change the lock', async () => {
    const { code, out } = await verify('dev', { permissions: { dev: 'write' } });
    assert.equal(code, 1);
    assert.match(out, /changes tsc-laws\.lock/);
    assert.match(out, /admin or maintain access/);
    assert.match(out, /tslaws\[bot\]/);
  });
  it('fails when its author is not a collaborator', async () => {
    const { code, out } = await verify('stranger');
    assert.equal(code, 1);
    assert.match(out, /admin or maintain access/);
  });
  it('fails when its author is a bot, whatever the bot can do', async () => {
    const { code } = await verify('helper[bot]', { permissions: { 'helper[bot]': 'admin' } });
    assert.equal(code, 1);
  });
  it('reads "local" from the base branch, not from the checkout', async () => {
    const { code, out } = await verify('owner', {
      permissions: { owner: 'admin' },
      github: { bot: 'tslaws[bot]', local: true },
      base: { bot: 'tslaws[bot]', local: false },
    });
    assert.equal(code, 1);
    assert.match(out, /only tslaws\[bot\] writes the lock/);
  });
  it('keeps the rule for the github section, whoever the author is', async () => {
    const { code, out } = await run('verify', {
      event: { pull_request: pull('owner') },
      permissions: { owner: 'admin' },
      routes: (path) => {
        if (path.endsWith('/files')) return [{ filename: 'tslaws.json' }];
        if (path.includes('/contents/tslaws.json?ref=h'))
          return { content: b64(JSON.stringify({ github: { bot: 'evil[bot]' } })) };
        return undefined;
      },
    });
    assert.equal(code, 1);
    assert.match(out, /"github" section/);
  });
  it('keeps the rule for protected paths, whoever the author is', async () => {
    const dir = join(root, 'protect');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tslaws.json'), JSON.stringify({ github: { bot: 'tslaws[bot]' } }));
    writeFileSync(
      join(dir, 'event.json'),
      JSON.stringify({ event: 0, pull_request: pull('owner', { changed_files: 1 }) }),
    );
    let out = '';
    const code = await githubCommand('verify', {
      cwd: dir,
      options: { cwd: dir, files: [], compiler: 'builtin', lockFile: join(dir, lockFile) } as never,
      env: { GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_REPOSITORY: 'o/r' },
      flags: new Map([['protect', '.github/workflows/tslaws-merge.yml']]),
      out: (t) => void (out += t),
      err: (t) => void (out += t),
      api: async (_method, path) => {
        if (path.includes('/permission')) return { permission: 'admin' };
        if (path.includes('/contents/')) return { content: b64(JSON.stringify({ github: { bot: 'tslaws[bot]' } })) };
        if (path.includes('/files')) return [{ filename: '.github/workflows/tslaws-merge.yml' }];
        return [];
      },
    });
    assert.equal(code, 1);
    assert.match(out, /is protected/);
  });
});

describe('merge after a hand-made change to the lock', () => {
  const push = (commits: object[]) => ({
    ref: 'refs/heads/master',
    before: hex('a'),
    after: hex('c'),
    commits,
  });
  const lockCommit = { id: hex('d'), modified: [lockFile], author: { username: 'someone' } };
  /**
   * The pull requests a commit belongs to, who made the commit as GitHub sees it, and who merged the pull request
   * (the list leaves that out, so it comes from the pull request itself).
   */
  const via =
    (prs: object[], extra?: (path: string) => unknown, who: { author?: string; mergedBy?: string } = {}) =>
    (path: string) => {
      const found = extra?.(path);
      if (found !== undefined) return found;
      if (path.endsWith('/pulls')) return prs;
      if (/\/pulls\/\d+$/.test(path)) return { merged_by: { login: who.mergedBy ?? 'maint', type: 'User' } };
      if (path.includes('/commits/'))
        return {
          author: { login: who.author ?? 'maint', type: 'User' },
          commit: { verification: { verified: true } },
        };
      if (path.includes('/contents/tsc-laws.lock')) return new Error('GitHub GET: 404 not found');
      return undefined;
    };
  const merged = pull('maint', { merged_at: '2026-11-16T10:00:00Z' });

  it('accepts what passes, building on the lock a maintainer merged', async () => {
    const { code, out, calls } = await run('merge', {
      event: push([lockCommit]),
      permissions: { maint: 'maintain' },
      routes: via([merged]),
      laws: true,
    });
    assert.equal(code, 0, out);
    assert.equal(wrote(calls).length, 1);
    assert.match(wrote(calls)[0]!.body.message, /accept 1 law change/);
  });
  it('refuses when the pull request author only has write access', async () => {
    const { code, out, calls } = await run('merge', {
      event: push([lockCommit]),
      permissions: { maint: 'write' },
      routes: via([merged]),
      laws: true,
    });
    assert.equal(code, 1);
    assert.match(
      out,
      /not made by tslaws\[bot\] with a verified signature, nor merged through a pull request from someone with admin or maintain access/,
    );
    assert.equal(wrote(calls).length, 0);
  });
  it("refuses when a non-maintainer made the commit in a maintainer's pull request", async () => {
    const { code, out, calls } = await run('merge', {
      event: push([lockCommit]),
      permissions: { maint: 'admin', dev: 'write' },
      routes: via([merged], undefined, { author: 'dev' }),
      laws: true,
    });
    assert.equal(code, 1);
    assert.match(out, /not made by tslaws\[bot\] with a verified signature, nor merged through a pull request/);
    assert.equal(wrote(calls).length, 0);
  });
  it('refuses when a non-maintainer merged the pull request', async () => {
    const { code, calls } = await run('merge', {
      event: push([lockCommit]),
      permissions: { maint: 'admin', dev: 'write' },
      routes: via([merged], undefined, { mergedBy: 'dev' }),
      laws: true,
    });
    assert.equal(code, 1);
    assert.equal(wrote(calls).length, 0);
  });
  it('refuses a pull request whose merger cannot be read', async () => {
    const { code, calls } = await run('merge', {
      event: push([lockCommit]),
      permissions: { maint: 'admin' },
      routes: via([merged], (path) => (/\/pulls\/\d+$/.test(path) ? new Error('GitHub GET: 404') : undefined)),
      laws: true,
    });
    assert.equal(code, 1);
    assert.equal(wrote(calls).length, 0);
  });
  it('refuses when "local" is false, even for a maintainer', async () => {
    const { code, out, calls } = await run('merge', {
      event: push([lockCommit]),
      github: { bot: 'tslaws[bot]', local: false },
      permissions: { maint: 'admin' },
      routes: via([merged]),
      laws: true,
    });
    assert.equal(code, 1);
    assert.match(out, /not made by tslaws\[bot\] with a verified signature; nothing accepted/);
    assert.equal(wrote(calls).length, 0);
  });
  it('refuses a pull request that is not merged, or merged into another branch', async () => {
    const open = await run('merge', {
      event: push([lockCommit]),
      permissions: { maint: 'admin' },
      routes: via([pull('maint', { merged_at: null })]),
      laws: true,
    });
    assert.equal(open.code, 1);
    const elsewhere = await run('merge', {
      event: push([lockCommit]),
      permissions: { maint: 'admin' },
      routes: via([pull('maint', { merged_at: 'x', base: { ref: 'release', sha: 'b' } })]),
      laws: true,
    });
    assert.equal(elsewhere.code, 1);
    assert.equal(wrote(open.calls).length + wrote(elsewhere.calls).length, 0);
  });
  it('trusts a lock change the push payload does not list, when a maintainer merged it', async () => {
    const hidden = { id: hex('e'), modified: ['src/a.ts'], author: { username: 'someone' } };
    const routes = (author: string) =>
      via([merged], (path) => {
        if (path.includes('/contents/tsc-laws.lock?ref=' + hex('a'))) return { sha: 'old' };
        if (path.includes('/contents/tsc-laws.lock?ref=' + hex('c'))) return { sha: 'new' };
        if (path.includes('/compare/')) return { status: 'ahead', ahead_by: 1, commits: [{ sha: hex('9') }] };
        if (path.includes('path=tsc-laws.lock')) return [{ sha: hex('9') }];
        if (path.includes(`/commits/${hex('9')}/pulls`)) return [pull(author, { merged_at: 'x' })];
        return undefined;
      });
    const trusted = await run('merge', {
      event: push([hidden]),
      permissions: { maint: 'admin' },
      routes: routes('maint'),
      laws: true,
    });
    assert.equal(trusted.code, 0, trusted.out);
    assert.equal(wrote(trusted.calls).length, 1);
    const refused = await run('merge', {
      event: push([hidden]),
      permissions: { maint: 'admin' },
      routes: routes('stranger'),
      laws: true,
    });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /this push changed tsc-laws\.lock/);
    assert.equal(wrote(refused.calls).length, 0);
  });
});

describe('merge on demand', () => {
  const dispatch = (actor: string | undefined, ref = 'refs/heads/master') => ({
    event: { ref },
    env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: hex('c'), ...(actor ? { GITHUB_ACTOR: actor } : {}) },
    routes: (path: string) => (path.includes('/contents/tsc-laws.lock') ? new Error('GitHub GET: 404') : undefined),
    laws: true,
  });

  it('accepts nothing when the branch moved past the commit the run checked out', async () => {
    const { code, out, calls } = await run('merge', {
      ...dispatch('maint'),
      permissions: { maint: 'maintain' },
      head: hex('d'),
    });
    assert.equal(code, 1);
    assert.match(out, /master is at ddddddd but this run checked out ccccccc; nothing accepted/);
    assert.equal(wrote(calls).length, 0);
  });
  it('accepts nothing when the head of the branch cannot be read', async () => {
    const base = dispatch('maint');
    const { code, out, calls } = await run('merge', {
      ...base,
      permissions: { maint: 'maintain' },
      routes: (path) => (path.includes('/git/ref/heads/') ? new Error('GitHub GET: 404') : base.routes(path)),
    });
    assert.equal(code, 1);
    assert.match(out, /the head of master could not be read; nothing accepted/);
    assert.equal(wrote(calls).length, 0);
  });
  it('accepts nothing when the run has no checked-out commit', async () => {
    const base = dispatch('maint');
    const { code, out, calls } = await run('merge', {
      ...base,
      env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTOR: 'maint' },
      permissions: { maint: 'maintain' },
    });
    assert.equal(code, 1);
    assert.match(out, /this run checked out no commit; nothing accepted/);
    assert.equal(wrote(calls).length, 0);
  });

  it('lets a maintainer accept every passing proposal, with no pull request involved', async () => {
    const { code, out, calls, summary } = await run('merge', {
      ...dispatch('maint'),
      permissions: { maint: 'maintain' },
    });
    assert.equal(code, 0, out);
    const put = wrote(calls);
    assert.equal(put.length, 1);
    assert.equal(put[0]!.path, `/repos/o/r/contents/${lockFile}`);
    assert.equal(put[0]!.body.branch, 'master');
    assert.match(put[0]!.body.message, /on request of @maint/);
    assert.match(put[0]!.body.message, /accepted by @maint/);
    assert.match(Buffer.from(put[0]!.body.content, 'base64').toString('utf8'), /a\.laws\.ts::ok/);
    assert.equal(calls.filter((c) => c.path.endsWith('/pulls')).length, 0);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'there is no pull request to comment on');
    assert.match(summary, /accepted/);
    assert.match(out, /tslaws on `master`/);
  });
  it('needs no approval records in comment mode: the maintainer who started the run accepts', async () => {
    const { code, out, calls } = await run('merge', {
      ...dispatch('owner'),
      github: { bot: 'tslaws[bot]', accept: 'comment' },
      permissions: { owner: 'admin' },
    });
    assert.equal(code, 0, out);
    assert.equal(wrote(calls).length, 1);
  });
  it('holds a maintainer to approvers that name only admin, and lets an admin through', async () => {
    const github = { bot: 'tslaws[bot]', approvers: ['admin'] };
    const maint = await run('merge', { ...dispatch('maint'), github, permissions: { maint: 'maintain' } });
    assert.equal(maint.code, 1);
    assert.match(maint.out, /@maint needs admin access to accept in this project on demand/);
    assert.equal(wrote(maint.calls).length, 0);
    const owner = await run('merge', { ...dispatch('owner'), github, permissions: { owner: 'admin' } });
    assert.equal(owner.code, 0, owner.out);
    assert.equal(wrote(owner.calls).length, 1);
  });
  it('refuses someone with only write access', async () => {
    const { code, out, calls } = await run('merge', { ...dispatch('dev'), permissions: { dev: 'write' } });
    assert.equal(code, 1);
    assert.match(out, /@dev needs admin or maintain access/);
    assert.equal(wrote(calls).length, 0);
  });
  it('refuses a stranger, and a run with no actor', async () => {
    const stranger = await run('merge', dispatch('stranger'));
    assert.equal(stranger.code, 1);
    assert.match(stranger.out, /needs admin or maintain access/);
    const nobody = await run('merge', dispatch(undefined));
    assert.equal(nobody.code, 1);
    assert.match(nobody.out, /nobody needs admin or maintain access/);
    assert.equal(wrote(stranger.calls).length + wrote(nobody.calls).length, 0);
  });
  it('refuses a bot, even one with admin access', async () => {
    const { code, calls } = await run('merge', { ...dispatch('helper[bot]'), permissions: { 'helper[bot]': 'admin' } });
    assert.equal(code, 1);
    assert.equal(wrote(calls).length, 0);
  });
  it('refuses a re-run started by someone who is not a maintainer, whoever first started the workflow', async () => {
    const rerun = (actor: string, triggering: string) => ({
      ...dispatch(actor),
      env: {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_SHA: hex('c'),
        GITHUB_ACTOR: actor,
        GITHUB_TRIGGERING_ACTOR: triggering,
      },
      permissions: { maint: 'admin', dev: 'write' },
    });
    const byDev = await run('merge', rerun('maint', 'dev'));
    assert.equal(byDev.code, 1);
    assert.match(byDev.out, /@dev needs admin or maintain access/);
    const ofDev = await run('merge', rerun('dev', 'maint'));
    assert.equal(ofDev.code, 1);
    assert.match(ofDev.out, /@dev needs admin or maintain access/);
    assert.equal(wrote(byDev.calls).length + wrote(ofDev.calls).length, 0);
    const both = await run('merge', {
      ...rerun('maint', 'maint'),
      permissions: { maint: 'admin' },
    });
    assert.equal(both.code, 0, both.out);
  });
  it('names the person who re-ran it in the commit', async () => {
    const { code, out, calls } = await run('merge', {
      ...dispatch('first'),
      env: {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_SHA: hex('c'),
        GITHUB_ACTOR: 'first',
        GITHUB_TRIGGERING_ACTOR: 'second',
      },
      permissions: { first: 'admin', second: 'maintain' },
    });
    assert.equal(code, 0, out);
    assert.match(wrote(calls)[0]!.body.message, /on request of @second/);
  });
  describe('building on the lock the branch holds', () => {
    const history = (author: string, mergedBy = 'maint') => ({
      ...dispatch('maint'),
      permissions: { maint: 'admin', dev: 'write' },
      routes: (path: string) => {
        if (path.includes('/contents/tsc-laws.lock')) return new Error('GitHub GET: 404');
        if (path.includes('/commits?sha=master&path=tsc-laws.lock')) return [{ sha: hex('9') }];
        if (path.endsWith(`/commits/${hex('9')}/pulls`)) return [pull(author, { merged_at: 'x' })];
        if (/\/pulls\/\d+$/.test(path)) return { merged_by: { login: mergedBy, type: 'User' } };
        if (path.endsWith(`/commits/${hex('9')}`))
          return { author: { login: author, type: 'User' }, commit: { verification: { verified: false } } };
        return undefined;
      },
    });

    it("refuses when the latest commit that changed the lock is neither the bot's nor a maintainer's", async () => {
      const { code, out, calls } = await run('merge', history('dev'));
      assert.equal(code, 1);
      assert.match(out, /the latest commit that changed tsc-laws\.lock on master \(9999999\) was not made by/);
      assert.match(out, /nothing accepted/);
      assert.equal(wrote(calls).length, 0);
    });
    it('refuses when that commit was merged by someone who is not a maintainer', async () => {
      const { code, calls } = await run('merge', history('maint', 'dev'));
      assert.equal(code, 1);
      assert.equal(wrote(calls).length, 0);
    });
    it('refuses, accepting nothing, when the history of the lock cannot be read', async () => {
      const { code, out, calls } = await run('merge', {
        ...history('maint'),
        routes: (path: string) =>
          path.includes('/commits?sha=master&path=') ? new Error('GitHub GET: 500') : history('maint').routes(path),
      });
      assert.equal(code, 1);
      assert.match(out, /could not be read/);
      assert.equal(wrote(calls).length, 0);
    });
    it('goes ahead when a maintainer merged it', async () => {
      const { code, out, calls } = await run('merge', history('maint'));
      assert.equal(code, 0, out);
      assert.equal(wrote(calls).length, 1);
    });
    it('goes ahead when the bot wrote it, with a verified signature', async () => {
      const { code, out, calls } = await run('merge', {
        ...history('dev'),
        routes: (path: string) =>
          path.endsWith(`/commits/${hex('9')}`)
            ? { author: { login: 'tslaws[bot]' }, commit: { verification: { verified: true } } }
            : history('dev').routes(path),
      });
      assert.equal(code, 0, out);
      assert.equal(wrote(calls).length, 1);
    });
    it('refuses when "local" is false and a maintainer made it', async () => {
      const { code, calls } = await run('merge', {
        ...history('maint'),
        github: { bot: 'tslaws[bot]', local: false },
      });
      assert.equal(code, 1);
      assert.equal(wrote(calls).length, 0);
    });
  });
  it('refuses to run on another branch than the configured one', async () => {
    const { code, out, calls } = await run('merge', {
      ...dispatch('maint', 'refs/heads/feature'),
      permissions: { maint: 'admin' },
    });
    assert.equal(code, 1);
    assert.match(out, /is not refs\/heads\/master/);
    assert.equal(wrote(calls).length, 0);
  });
  it('refuses an event that is neither a push nor a dispatch', async () => {
    const { code, out } = await run('merge', {
      ...dispatch('maint'),
      env: { GITHUB_EVENT_NAME: 'schedule', GITHUB_ACTOR: 'maint' },
      permissions: { maint: 'admin' },
    });
    assert.equal(code, 1);
    assert.match(out, /push and workflow_dispatch only/);
  });
  it('still runs on demand when "local" is false: the actor check is the gate', async () => {
    const { code, out, calls } = await run('merge', {
      ...dispatch('maint'),
      github: { bot: 'tslaws[bot]', local: false },
      permissions: { maint: 'admin' },
    });
    assert.equal(code, 0, out);
    assert.equal(wrote(calls).length, 1);
  });
});

describe('approving locally in a project that accepts on GitHub', () => {
  it('promotes a proposal, lends accept for a while and writes the lock, ready to push', async () => {
    mkdirSync(join(root, 'flow'), { recursive: true });
    const dir = realRoot(join(root, 'flow'))!;
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'tslaws.json'), JSON.stringify({ github: { bot: 'tslaws[bot]' } }));
    writeFileSync(
      join(dir, 'src', 'a.proposed.laws.ts'),
      "import { law } from 'tslaws';\nlaw('same', (n: number) => n === n);\n",
    );
    let output = '';
    const promoted = await promoteFiles(
      {
        cwd: dir,
        checkFile: async () => new Map([['same', 'tested']]),
        ask: async () => 'y',
        out: (t) => (output += t),
      },
      ['src/a.proposed.laws.ts'],
    );
    assert.equal(promoted, 1, output);
    assert.ok(existsSync(join(dir, 'src', 'a.laws.ts')));

    mkdirSync(join(root, 'home'), { recursive: true });
    const home = realRoot(join(root, 'home'))!;
    const io = { out: () => {}, err: (t: string) => void (output += t) };
    assert.equal(runDelegateCommand(['grant', '--for', '1h'], dir, { isTTY: true, env: {}, home, ...io }), 0, output);
    const code = await acceptCommand(dir, new Map(), ['src/a.laws.ts'], {
      isTTY: false,
      env: { TSLAWS_AGENT: '1' },
      home,
      ...io,
    });
    assert.equal(code, 0, output);
    assert.match(readFileSync(join(dir, 'tsc-laws.lock'), 'utf8'), /a\.laws\.ts::same/);
  });
});
