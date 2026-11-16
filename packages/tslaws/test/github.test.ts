// Accepting laws on GitHub: the policy (github.ts), the partial lock write (lock.ts) and the approver check. No compiler.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { acceptCommand } from '../dist/cli.js';
const cfg = (extra: object = {}) => ({ ...githubDefaults, bot: 'tslaws[bot]', ...extra }) as never;
import {
  acceptedFingerprints,
  approvalMarker,
  inert,
  recordComment,
  decide,
  githubDefaults,
  parseCommands,
  parseGithubConfig,
  proposalsOf,
  pullRequestVerdict,
  readApprovals,
  renderSticky,
  stickyMarkerFor,
  resolveNames,
} from '../dist/github.js';
import { githubCommand, refusal } from '../dist/githubCli.js';
import { acceptChanges, lawHash, lockChanges } from '../dist/lock.js';
import type { CheckReport } from '../dist/check.js';
import type { ManifestLaw } from '../dist/types.js';

const law = (file: string, name: string, text: string): ManifestLaw => ({
  file,
  name,
  exported: true,
  proved: false,
  line: 3,
  params: [],
  body: '',
  text,
  problems: [],
});

const a = law('src/a.laws.ts', 'keeps', 'keeps() { return true; }');
const b = law('src/a.laws.ts', 'grows', 'grows() { return 1 < 2; }');
const bEdited = law('src/a.laws.ts', 'grows', 'grows() { return 1 <= 2; }');
const c = law('src/c.laws.ts', 'keeps', 'keeps() { return !false; }');
const lock = { laws: { 'src/a.laws.ts::keeps': lawHash(a), 'src/old.laws.ts::gone': 'x' }, exempt: ['src/x.ts::f'] };

const report = (results: CheckReport['results']): CheckReport => ({
  results,
  compileDiagnostics: '',
  compileOk: true,
  lockMissing: false,
  notices: [],
  ok: false,
});

describe('lock changes', () => {
  it('lists added, removed and exemption changes with fingerprints', () => {
    const changes = lockChanges(lock, [a, b], ['src/y.ts::g']);
    assert.deepEqual(
      changes.map((ch) => [ch.key, ch.kind, ch.reason]),
      [
        ['src/a.laws.ts::grows', 'law', 'added'],
        ['src/old.laws.ts::gone', 'law', 'removed'],
        ['src/y.ts::g', 'exempt', 'added'],
        ['src/x.ts::f', 'exempt', 'removed'],
      ],
    );
  });

  it('gives an edited law a new fingerprint', () => {
    const [before] = lockChanges(lock, [a, b], ['src/x.ts::f']);
    const [after] = lockChanges(lock, [a, bEdited], ['src/x.ts::f']);
    assert.notEqual(before!.fingerprint, after!.fingerprint);
  });

  it('accepts only the chosen changes and keeps the rest as locked', () => {
    const changes = lockChanges(lock, [a, b], ['src/y.ts::g']);
    const grows = changes.find((ch) => ch.key === 'src/a.laws.ts::grows')!;
    const next = acceptChanges(lock, [a, b], ['src/y.ts::g'], undefined, new Set([grows.fingerprint]));
    assert.deepEqual(next.laws, { ...lock.laws, 'src/a.laws.ts::grows': lawHash(b) });
    assert.deepEqual(next.exempt, ['src/x.ts::f']);
    assert.equal(lockChanges(next, [a, b], ['src/y.ts::g']).length, 3);
  });

  it('accepting everything leaves nothing to accept', () => {
    const changes = lockChanges(lock, [a, b, c], ['src/y.ts::g']);
    const next = acceptChanges(
      lock,
      [a, b, c],
      ['src/y.ts::g'],
      undefined,
      new Set(changes.map((ch) => ch.fingerprint)),
    );
    assert.deepEqual(lockChanges(next, [a, b, c], ['src/y.ts::g']), []);
  });
});

describe('commands', () => {
  it('parses accept all, names, keys and quoted names, and skips quotes', () => {
    assert.deepEqual(parseCommands('/tslaws accept all'), [{ verb: 'accept', all: true, names: [] }]);
    assert.deepEqual(parseCommands('/tslaws accept'), [{ verb: 'accept', all: true, names: [] }]);
    assert.deepEqual(parseCommands('LGTM\n/tslaws accept grows, `a law with spaces` src/c.laws.ts::keeps'), [
      { verb: 'accept', all: false, names: ['grows', 'a law with spaces', 'src/c.laws.ts::keeps'] },
    ]);
    assert.deepEqual(parseCommands('> /tslaws accept all\n/TSLAWS reject grows'), [
      { verb: 'reject', all: false, names: ['grows'] },
    ]);
    assert.deepEqual(parseCommands('please /tslaws accept all'), []);
  });

  it('marks a --project with no directory, and still reads a --project with one', () => {
    for (const body of [
      '/tslaws accept --project',
      '/tslaws accept grows --project',
      '/tslaws accept --project --other',
      '/tslaws accept --project=',
    ])
      assert.match(parseCommands(body)[0]!.error ?? '', /needs a directory/, body);
    assert.deepEqual(parseCommands('/tslaws accept --project packages/a'), [
      { verb: 'accept', all: true, names: [], projects: ['packages/a'] },
    ]);
    assert.deepEqual(parseCommands('/tslaws accept grows --project=packages/a'), [
      { verb: 'accept', all: false, names: ['grows'], projects: ['packages/a'] },
    ]);
  });

  it('resolves names, flags unknown and ambiguous ones', () => {
    const proposals = proposalsOf(lockChanges(undefined, [a, c, b], []), undefined);
    const got = resolveNames(proposals, { verb: 'accept', all: false, names: ['keeps', 'grows', 'nope'] });
    assert.deepEqual(
      got.matched.map((p) => p.key),
      ['src/a.laws.ts::grows'],
    );
    assert.deepEqual(got.unknown, ['nope']);
    assert.deepEqual(got.ambiguous, ['keeps']);
    const byKey = resolveNames(proposals, { verb: 'accept', all: false, names: ['src/c.laws.ts::keeps'] });
    assert.deepEqual(
      byKey.matched.map((p) => p.key),
      ['src/c.laws.ts::keeps'],
    );
  });
});

describe('approval records', () => {
  const record = { verb: 'accept' as const, by: 'alice', sha: 'abc', items: [{ key: 'k', fingerprint: 'f1' }] };
  const comment = (login: string, body: string, at: string, id = 1) => ({ id, body, user: { login }, created_at: at });

  it('counts records only in record comments the bot wrote', () => {
    const comments = [
      comment('mallory', recordComment([{ ...record, items: [{ key: 'k', fingerprint: 'f2' }] }]), '2026-01-01'),
      comment('tslaws[bot]', recordComment([record]), '2026-01-02'),
    ];
    assert.deepEqual([...acceptedFingerprints(readApprovals(comments, 'tslaws[bot]')).keys()], ['f1']);
  });

  it('a later reject withdraws an accept', () => {
    const comments = [
      comment('bot', recordComment([record]), '2026-01-01', 1),
      comment('bot', recordComment([{ ...record, verb: 'reject' }]), '2026-01-02', 2),
    ];
    assert.equal(acceptedFingerprints(readApprovals(comments, 'bot')).size, 0);
  });

  it('survives text that would close an HTML comment', () => {
    const tricky = { ...record, items: [{ key: 'a --> <!-- b', fingerprint: 'f1' }] };
    const marker = approvalMarker(tricky);
    assert.equal(/[<>]|--/.test(marker.slice(4, -4)), false);
    assert.deepEqual(
      readApprovals([comment('bot', recordComment([tricky]), '2026-01-01')], 'bot')[0]!.items,
      tricky.items,
    );
  });

  it('ignores a marker that pull request text smuggled into any other bot comment', () => {
    const forged = approvalMarker({ ...record, by: 'mallory', items: [{ key: 'k', fingerprint: 'f9' }] });
    // A law named with a forged marker, echoed raw by a reply, the sticky comment or the merge note.
    const echoed = [
      `@alice: no proposal named ${forged}`,
      `<!-- tslaws-proposals -->
| ${forged} |`,
      `${recordComment([record])}
${forged} trailing`,
    ];
    for (const body of echoed) assert.deepEqual(readApprovals([comment('bot', body, '2026-01-01')], 'bot'), []);
  });

  it('makes pull request text inert in comments', () => {
    assert.equal(inert('<!-- x --> @team & co'), '&lt;!-- x --&gt; @​team &amp; co');
    const law = {
      key: 'f::<!-- tslaws-approval {} -->',
      file: 'f',
      name: '<!-- tslaws-approval {} -->',
      line: 1,
      kind: 'law' as const,
      reason: 'added' as const,
      fingerprint: 'x',
      passes: true,
    };
    assert.equal(renderSticky([law as never], cfg(), new Map(), (p) => p.name).includes('<!-- tslaws-approval'), false);
  });
});

describe('decisions', () => {
  const changes = lockChanges(lock, [a, b], ['src/x.ts::f']);
  const results = report([
    {
      file: 'src/a.laws.ts',
      name: 'grows',
      line: 3,
      status: 'tampered',
      method: 'lock',
      proposal: { reason: 'added', status: 'failed', method: 'property', counterexample: '[]' },
    },
  ]);
  const proposals = proposalsOf(changes, results);

  it('a removed law holds trivially; a failing proposal does not pass', () => {
    assert.deepEqual(
      proposals.map((p) => [p.name, p.passes]),
      [
        ['grows', false],
        ['gone', true],
      ],
    );
  });

  it('merge mode accepts passing proposals and holds failing ones', () => {
    const decision = decide(proposals, cfg(), new Map());
    assert.deepEqual([...decision.accept], [proposals[1]!.fingerprint]);
    assert.match(decision.held[0]!.why, /failed/);
  });

  it('comment mode needs an accept for the exact fingerprint', () => {
    const config = cfg({ accept: 'comment' });
    assert.equal(decide(proposals, config, new Map()).accept.size, 0);
    const approvals = new Map([[proposals[1]!.fingerprint, 'alice']]);
    assert.deepEqual([...decide(proposals, config, approvals).accept], [proposals[1]!.fingerprint]);
  });

  it('the pull request fails on a failing proposal, and in comment mode on a waiting one', () => {
    const verdict = pullRequestVerdict(results, proposals, cfg(), new Map());
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join('\n'), /proposal grows .* failed/);
    const passing = proposalsOf(changes.slice(1), report([]));
    assert.equal(pullRequestVerdict(report([]), passing, cfg(), new Map()).ok, true);
    const comment = cfg({ accept: 'comment' });
    assert.equal(pullRequestVerdict(report([]), passing, comment, new Map()).ok, false);
  });

  it('renders one row per proposal', () => {
    const text = renderSticky(proposals, cfg(), new Map(), (p) => p.name);
    assert.match(text, /\| grows \| law added \| ❌ failed — counterexample `\[\]` \| 🚫/);
    assert.match(text, /\| gone \| law removed \| ✅ proved \| ⏳ accepted on merge \|/);
  });
});

describe('config', () => {
  it('defaults to accepting on merge into master', () => {
    assert.deepEqual(parseGithubConfig({ bot: 'tslaws[bot]' }), cfg());
    assert.equal(parseGithubConfig({}).bot, 'github-actions[bot]');
    assert.equal(parseGithubConfig({ bot: 'github-actions[bot]', accept: 'merge' }).accept, 'merge');
    assert.throws(() => parseGithubConfig({ accept: 'comment' }), /dedicated GitHub App/);
    assert.throws(() => parseGithubConfig({ bot: 'GitHub-Actions[bot]', accept: 'comment' }), /dedicated GitHub App/);
    assert.equal(githubDefaults.branch, 'master');
    assert.equal(parseGithubConfig({ bot: 'tslaws[bot]', branch: 'main', accept: 'comment' }).branch, 'main');
  });
  it('refuses unknown options and bad values', () => {
    assert.throws(() => parseGithubConfig({ acept: 'merge' }), /unknown option "acept"/);
    assert.throws(() => parseGithubConfig({ accept: 'always' }), /"accept"/);
    assert.throws(() => parseGithubConfig({ approvers: ['anyone'] }), /"approvers"/);
  });
});

describe('approvers', () => {
  const pr = {
    number: 7,
    user: { login: 'author', type: 'User' },
    head: { sha: 'h' },
    base: { ref: 'master', sha: 'b' },
  };
  const api =
    (permission: string, reviews: string[] = []) =>
    async (_method: string, path: string) =>
      path.includes('/permission')
        ? { permission }
        : path.includes('/reviews')
          ? reviews.map((login) => ({ user: { login } }))
          : [];

  it('lets the author or a reviewer with write access accept', async () => {
    assert.equal(await refusal(api('write'), 'o/r', pr, 'author', 'User', cfg()), undefined);
    assert.equal(await refusal(api('write', ['rev']), 'o/r', pr, 'rev', 'User', cfg()), undefined);
  });
  it('refuses bots, readers and bystanders', async () => {
    assert.match((await refusal(api('admin'), 'o/r', pr, 'helper[bot]', 'Bot', cfg()))!, /bots/);
    assert.match((await refusal(api('read'), 'o/r', pr, 'author', 'User', cfg()))!, /write access/);
    assert.match((await refusal(api('write'), 'o/r', pr, 'someone', 'User', cfg()))!, /not one of the approvers/);
  });
  it('a bot-authored pull request cannot be accepted by its author', async () => {
    const botPr = { ...pr, user: { login: 'agent', type: 'Bot' } };
    assert.match((await refusal(api('write'), 'o/r', botPr, 'agent', 'User', cfg()))!, /not one of/);
  });
});

describe('local accept', () => {
  it('refuses when the project accepts laws on GitHub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tslaws-gh-'));
    try {
      writeFileSync(join(dir, 'tslaws.json'), JSON.stringify({ github: { bot: 'tslaws[bot]', branch: 'master' } }));
      writeFileSync(join(dir, 'a.laws.ts'), 'export law ok() { return true; }\n');
      let err = '';
      const code = await acceptCommand(dir, new Map(), [], {
        isTTY: true,
        env: {},
        out: () => {},
        err: (t: string) => void (err += t),
      });
      assert.equal(code, 1);
      assert.match(err, /accepts laws on GitHub/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lock tampering', () => {
  const run = async (
    mode: string,
    payload: object,
    routes: (path: string) => unknown,
    env: Record<string, string> = {},
    projectPath = '',
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'tslaws-gh-'));
    try {
      // GitHub reports how many files a pull request changes; say so, as many as the fake lists.
      const pr = (payload as { pull_request?: { number: number; changed_files?: number } }).pull_request;
      const listed = routes(`/repos/o/r/pulls/${pr?.number}/files`);
      const event =
        pr !== undefined && pr.changed_files === undefined && Array.isArray(listed)
          ? { ...payload, pull_request: { ...pr, changed_files: listed.length } }
          : payload;
      writeFileSync(join(dir, 'event.json'), JSON.stringify(event));
      writeFileSync(join(dir, 'tslaws.json'), JSON.stringify({ github: { bot: 'tslaws[bot]' } }));
      let out = '';
      const code = await githubCommand(mode, {
        cwd: dir,
        projectPath,
        options: { cwd: dir, files: [], compiler: 'tsc-laws', lockFile: join(dir, 'tsc-laws.lock') } as never,
        env: { GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_REPOSITORY: 'o/r', ...env },
        flags: new Map(),
        out: (t) => void (out += t),
        err: (t) => void (out += t),
        api: async (_method, path) => {
          const value = routes(path.replace(/[?&]per_page=100&page=\d+$/, ''));
          if (value instanceof Error) throw value;
          return value;
        },
      });
      return { code, out };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const baseConfig = { content: Buffer.from(JSON.stringify({ github: { bot: 'tslaws[bot]' } })).toString('base64') };
  const pull = { number: 3, user: { login: 'a', type: 'User' }, head: { sha: 'h' }, base: { ref: 'master', sha: 'b' } };

  it('verify fails a pull request whose diff changes the lock, whatever its commits list', async () => {
    const { code, out } = await run('verify', { pull_request: pull }, (path) =>
      path.endsWith('/files')
        ? [{ filename: 'src/a.ts' }, { filename: 'tsc-laws.lock' }]
        : path.includes('/contents/')
          ? baseConfig
          : [],
    );
    assert.equal(code, 1);
    assert.match(out, /changes tsc-laws\.lock/);
  });

  it('verify passes a pull request that leaves the lock alone', async () => {
    const { code } = await run('verify', { pull_request: pull }, (path) =>
      path.endsWith('/files') ? [{ filename: 'src/a.ts' }] : path.includes('/contents/') ? baseConfig : [],
    );
    assert.equal(code, 0);
  });

  const push = (commits: object[]) => ({
    ref: 'refs/heads/master',
    before: 'a'.repeat(40),
    after: 'c'.repeat(40),
    commits,
  });
  const lockCommit = { id: 'd'.repeat(40), modified: ['tsc-laws.lock'], author: { username: 'tslaws' } };

  it('merge does not take a commit for the bot on its e-mail address alone', async () => {
    const { code, out } = await run('merge', push([lockCommit]), (path) =>
      path.includes('/commits/') ? { author: { login: 'mallory' }, commit: { verification: { verified: false } } } : [],
    );
    assert.equal(code, 1);
    assert.match(out, /not made by tslaws\[bot\]/);
  });

  it('merge skips a push that is only the bot writing the lock', async () => {
    const { code, out } = await run('merge', push([lockCommit]), (path) =>
      path.includes('/commits/')
        ? { author: { login: 'tslaws[bot]' }, commit: { verification: { verified: true } } }
        : [],
    );
    assert.equal(code, 0);
    assert.match(out, /bot writing the lock/);
  });

  it('merge refuses to build on a lock that moved on since the push, unless only the bot moved it', async () => {
    const plain = { id: 'f'.repeat(40), modified: ['src/a.ts'], author: { username: 'a' } };
    const { code, out } = await run('merge', push([plain]), (path) => {
      if (path.includes('/contents/tsc-laws.lock?ref=master')) return { sha: 'moved', content: '' };
      if (path.includes('/contents/tsc-laws.lock')) return { sha: 'same' };
      if (path.includes('/compare/')) return { status: 'ahead', ahead_by: 1, commits: [{ sha: '9'.repeat(40) }] };
      if (path.includes('path=tsc-laws.lock')) return [{ sha: '9'.repeat(40) }];
      if (path.includes('/commits/'))
        return { author: { login: 'mallory' }, commit: { verification: { verified: true } } };
      return [];
    });
    assert.equal(code, 1);
    assert.match(out, /has moved on since this push/);
  });

  it('merge refuses a push that changed the lock where the payload does not say so', async () => {
    const hidden = { id: 'e'.repeat(40), modified: ['src/a.ts'], author: { username: 'mallory' } };
    const { code, out } = await run('merge', push([hidden]), (path) =>
      path.includes('/contents/tsc-laws.lock') ? { sha: path.includes('a'.repeat(40)) ? 'old' : 'new' } : [],
    );
    assert.equal(code, 1);
    assert.match(out, /this push changed tsc-laws\.lock/);
  });
  describe('in a monorepo', () => {
    const lockPath = 'packages/ui/tsc-laws.lock';

    it("verify flags this project's lock and github section, by repo-relative path", async () => {
      const changedLock = await run(
        'verify',
        { pull_request: pull },
        (path) =>
          path.endsWith('/files')
            ? [{ filename: lockPath }]
            : path.includes('/contents/packages/ui/tslaws.json')
              ? baseConfig
              : [],
        {},
        'packages/ui',
      );
      assert.equal(changedLock.code, 1);
      assert.match(changedLock.out, /changes packages\/ui\/tsc-laws\.lock/);

      const headConfig = {
        content: Buffer.from(JSON.stringify({ github: { bot: 'evil[bot]' } })).toString('base64'),
      };
      const changedSection = await run(
        'verify',
        { pull_request: pull },
        (path) =>
          path.endsWith('/files')
            ? [{ filename: 'packages/ui/tslaws.json' }]
            : path.includes('/contents/packages/ui/tslaws.json')
              ? path.includes('ref=h')
                ? headConfig
                : baseConfig
              : [],
        {},
        'packages/ui',
      );
      assert.equal(changedSection.code, 1);
      assert.match(changedSection.out, /"github" section of packages\/ui\/tslaws\.json/);

      const otherProject = await run(
        'verify',
        { pull_request: pull },
        (path) =>
          path.endsWith('/files')
            ? [{ filename: 'packages/other/tsc-laws.lock' }]
            : path.includes('/contents/packages/ui/tslaws.json')
              ? baseConfig
              : [],
        {},
        'packages/ui',
      );
      assert.equal(otherProject.code, 0);
    });

    const push = (commits: object[]) => ({
      ref: 'refs/heads/master',
      before: 'a'.repeat(40),
      after: 'c'.repeat(40),
      commits,
    });

    it("merge reads the lock at the project path and ignores another project's bot commit", async () => {
      const seen: string[] = [];
      const botOnOther = { id: 'd'.repeat(40), modified: ['packages/other/tsc-laws.lock'], author: { username: 'x' } };
      const { out } = await run(
        'merge',
        push([botOnOther]),
        (path) => {
          seen.push(path);
          if (path.includes('/contents/packages/ui/tsc-laws.lock')) return { sha: 'same', content: '' };
          if (path.includes('/commits/') && !path.includes('/pulls')) throw new Error('byBot must not be asked');
          return [];
        },
        {},
        'packages/ui',
      );
      // It goes on to read the laws (the stand-in options have none), so the exit code is not the point: no check refused.
      assert.doesNotMatch(out, /moved on|not made by|this push changed|bot writing/);
      assert.ok(seen.some((p) => p.includes('/contents/packages/ui/tsc-laws.lock?ref=')));
      assert.ok(!seen.some((p) => p.includes('/contents/tsc-laws.lock')));
    });

    it("merge does not mistake a root lock commit for this project's", async () => {
      const rootLock = { id: 'd'.repeat(40), modified: ['tsc-laws.lock'], author: { username: 'x' } };
      const { code, out } = await run('merge', push([rootLock]), () => [], {}, 'packages/ui');
      assert.equal(code, 0);
      assert.doesNotMatch(out, /not made by/);
    });

    it("merge refuses a commit that changed this project's lock and was not the bot's", async () => {
      const mine = { id: 'd'.repeat(40), modified: [lockPath], author: { username: 'x' } };
      const { code, out } = await run(
        'merge',
        push([mine]),
        (path) =>
          path.includes('/commits/')
            ? { author: { login: 'mallory' }, commit: { verification: { verified: true } } }
            : [],
        {},
        'packages/ui',
      );
      assert.equal(code, 1);
      assert.match(out, /changed packages\/ui\/tsc-laws\.lock but was not made by/);
    });
  });
});

describe('sticky comments in a monorepo', () => {
  const link = (p: { name: string }) => p.name;
  it('keeps the root marker and gives each project its own', () => {
    const root = renderSticky([], cfg(), new Map(), link as never);
    const ui = renderSticky([], cfg(), new Map(), link as never, 'packages/ui');
    const auth = renderSticky([], cfg(), new Map(), link as never, 'apps/core/auth');
    assert.ok(root.startsWith('<!-- tslaws-proposals -->\n### tslaws proposals\n'));
    assert.ok(ui.startsWith(`${stickyMarkerFor('packages/ui')}\n### tslaws proposals for \`packages/ui\``));
    const markers = [root, ui, auth].map((body) => (body.match(/^<!-- tslaws-proposals[^>]*-->/) as string[])[0]);
    assert.equal(new Set(markers).size, 3);
    // upsertSticky finds a comment by startsWith(marker): no project's body matches another's marker.
    for (const [i, body] of [root, ui, auth].entries())
      for (const [j, marker] of markers.entries()) assert.equal(body.startsWith(marker), i === j);
  });
  it('keeps a hostile path from closing the comment', () => {
    assert.doesNotMatch(stickyMarkerFor('a--> <b'), /-->.+-->/);
    assert.notEqual(stickyMarkerFor('packages/a b'), stickyMarkerFor('packages/a_b'));
    assert.notEqual(stickyMarkerFor('packages/a-b'), stickyMarkerFor('packages/a%2Db'));
    assert.equal(stickyMarkerFor('packages/ui'), '<!-- tslaws-proposals packages/ui -->');
  });
});
