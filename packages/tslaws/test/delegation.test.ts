// `tslaws delegate` and delegated `accept`. Needs `npm run build`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acceptGate,
  delegationFile,
  findGrant,
  grantFor,
  parseDuration,
  personOnly,
  realRoot,
  revokeFor,
} from '../dist/delegation.js';
import { acceptCommand, runDelegateCommand } from '../dist/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(here, '..', '.tmp-delegation-'));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

const bin = join(here, '..', 'bin', 'tslaws.js');
let counter = 0;
const fresh = (name: string): string => {
  const dir = join(scratch, `${name}-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  return realRoot(dir)!;
};
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.CI;
  delete env.TSLAWS_AGENT;
  return env;
};
const writeGrantFile = (home: string, content: unknown): string => {
  mkdirSync(join(home, '.tslaws'), { recursive: true });
  const file = join(home, '.tslaws', 'delegation.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
};
const now = new Date('2030-01-01T00:00:00Z');
const hours = (n: number): string => new Date(now.getTime() + n * 3_600_000).toISOString();

describe('acceptGate', () => {
  it('refuses with no grant and tells the person how to grant', () => {
    const gate = acceptGate({ isTTY: false, env: {}, home: fresh('home'), root: fresh('proj'), now });
    assert.ok(!gate.ok && /tslaws delegate grant/.test(gate.message));
  });

  it('lets a person at a terminal through without a grant', () => {
    const gate = acceptGate({ isTTY: true, env: {}, home: fresh('home'), root: fresh('proj'), now });
    assert.deepEqual(gate, { ok: true, delegated: false });
  });

  it('accepts a live grant without a terminal', () => {
    const home = fresh('home');
    const root = fresh('proj');
    writeGrantFile(home, { grants: [{ root, expires: hours(2) }] });
    const gate = acceptGate({ isTTY: false, env: {}, home, root, now });
    assert.ok(gate.ok && gate.delegated);
  });

  it('refuses an expired grant', () => {
    const home = fresh('home');
    const root = fresh('proj');
    writeGrantFile(home, { grants: [{ root, expires: hours(-1) }] });
    const gate = acceptGate({ isTTY: false, env: {}, home, root, now });
    assert.ok(!gate.ok && /expired/.test(gate.message));
  });

  it('refuses a grant for another root', () => {
    const home = fresh('home');
    writeGrantFile(home, { grants: [{ root: fresh('other'), expires: hours(2) }] });
    const gate = acceptGate({ isTTY: false, env: {}, home, root: fresh('proj'), now });
    assert.equal(gate.ok, false);
  });

  it('always refuses under CI, grant or not, terminal or not', () => {
    const home = fresh('home');
    const root = fresh('proj');
    writeGrantFile(home, { grants: [{ root, expires: hours(2) }] });
    for (const isTTY of [true, false]) {
      const gate = acceptGate({ isTTY, env: { CI: '1' }, home, root, now });
      assert.ok(!gate.ok && /CI/.test(gate.message));
    }
  });

  it('treats TSLAWS_AGENT like no terminal: only a live grant helps', () => {
    const home = fresh('home');
    const root = fresh('proj');
    const env = { TSLAWS_AGENT: '1' };
    assert.equal(acceptGate({ isTTY: true, env, home, root, now }).ok, false);
    writeGrantFile(home, { grants: [{ root, expires: hours(1) }] });
    const gate = acceptGate({ isTTY: true, env, home, root, now });
    assert.ok(gate.ok && gate.delegated);
  });

  it('refuses a malformed grants file', () => {
    const root = fresh('proj');
    const bad = [
      'not json',
      '{"grants":"x"}',
      '{"grants":[{"root":"a"}]}',
      `{"grants":[{"root":${JSON.stringify(root)},"expires":"never"}]}`,
    ];
    for (const content of bad) {
      const home = fresh('home');
      writeGrantFile(home, content);
      assert.equal(acceptGate({ isTTY: false, env: {}, home, root, now }).ok, false, content);
    }
  });

  it('never reads a grant from the project directory', () => {
    const home = fresh('home');
    const root = fresh('proj');
    writeGrantFile(root, { grants: [{ root, expires: hours(2) }] });
    assert.equal(acceptGate({ isTTY: false, env: {}, home, root, now }).ok, false);
  });

  it('refuses a grants file that others can write', { skip: process.platform === 'win32' }, () => {
    const home = fresh('home');
    const root = fresh('proj');
    const file = writeGrantFile(home, { grants: [{ root, expires: hours(2) }] });
    chmodSync(file, 0o666);
    assert.equal(acceptGate({ isTTY: false, env: {}, home, root, now }).ok, false);
  });

  it('matches by real path and ignores a grant that names a symlink', () => {
    const home = fresh('home');
    const root = fresh('proj');
    const link = join(fresh('links'), 'link');
    try {
      symlinkSync(root, link, 'junction');
    } catch {
      return;
    }
    writeGrantFile(home, { grants: [{ root: link, expires: hours(2) }] });
    assert.equal(findGrant(root, now, home).ok, false);
    assert.equal(findGrant(link, now, home).ok, false);
    assert.match(String(grantFor(link, 3_600_000, now, home)), /symlink/);
  });
});

describe('grants directory', () => {
  it('is refused when .tslaws resolves outside the home directory', () => {
    const home = fresh('home');
    const elsewhere = fresh('elsewhere');
    const root = fresh('proj');
    writeFileSync(join(elsewhere, 'delegation.json'), JSON.stringify({ grants: [{ root, expires: hours(2) }] }));
    try {
      symlinkSync(elsewhere, join(home, '.tslaws'), 'junction');
    } catch {
      return;
    }
    assert.equal(acceptGate({ isTTY: false, env: {}, home, root, now }).ok, false);
    assert.match(String(grantFor(root, 3_600_000, now, home)), /outside the home directory/);
  });
});

describe('grants', () => {
  it('writes, finds and revokes a grant', () => {
    const home = fresh('home');
    const root = fresh('proj');
    assert.equal(typeof grantFor(root, parseDuration('1h')!, now, home), 'object');
    assert.ok(findGrant(root, now, home).ok);
    assert.ok(existsSync(delegationFile(home)));
    assert.equal(revokeFor(root, home), 1);
    assert.equal(findGrant(root, now, home).ok, false);
  });

  it('allows only 1h, 8h, 1d and 7d', () => {
    assert.equal(parseDuration('7d'), 7 * 24 * 3_600_000);
    assert.equal(parseDuration('8d'), undefined);
    assert.equal(parseDuration('__proto__'), undefined);
  });

  it('personOnly needs a terminal and neither marker', () => {
    assert.ok(personOnly({ isTTY: true, env: {} }));
    assert.ok(!personOnly({ isTTY: false, env: {} }));
    assert.ok(!personOnly({ isTTY: true, env: { CI: '1' } }));
    assert.ok(!personOnly({ isTTY: true, env: { TSLAWS_AGENT: '1' } }));
  });
});

describe('home directory', () => {
  it('comes from the user database, not from HOME or USERPROFILE', () => {
    const probe = `import { userHome } from ${JSON.stringify(new URL('../dist/delegation.js', import.meta.url).href)};
process.stdout.write(userHome());`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      env: { ...cleanEnv(), HOME: scratch, USERPROFILE: scratch },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, userInfo().homedir);
    assert.notEqual(result.stdout, scratch);
  });

  it('is refused when unknown', () => {
    const root = fresh('proj');
    assert.equal(findGrant(root, now, '').ok, false);
    assert.match(String(grantFor(root, 3_600_000, now, '')), /unknown/);
    assert.equal(acceptGate({ isTTY: false, env: {}, home: '', root, now }).ok, false);
  });

  it('is refused when it is the project root or inside it', () => {
    const root = fresh('proj');
    const inner = join(root, 'home');
    mkdirSync(inner);
    for (const home of [root, inner]) {
      assert.match(String(grantFor(root, 3_600_000, now, home)), /inside the project root/);
      writeGrantFile(home, { grants: [{ root, expires: hours(2) }] });
      assert.equal(acceptGate({ isTTY: false, env: {}, home, root, now }).ok, false);
    }
  });

  it('may contain the project, as a real home contains its projects', () => {
    const home = fresh('home');
    const root = join(home, 'work');
    mkdirSync(root);
    assert.equal(typeof grantFor(realRoot(root)!, 3_600_000, now, home), 'object');
  });
});

describe('delegate and accept commands', () => {
  const person = (home: string) => ({ isTTY: true, env: {}, home, now });
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) } };
  };
  const project = (): string => {
    const root = fresh('proj');
    writeFileSync(join(root, 'a.laws.ts'), 'export law same(n: number) => n === n;\n');
    return root;
  };

  it('grant, status and revoke work for a person at a terminal', () => {
    const home = fresh('home');
    const root = fresh('proj');
    const c = capture();
    const ctx = { ...person(home), ...c.io };
    assert.equal(runDelegateCommand(['grant', '--for', '1h'], root, ctx), 0);
    assert.match(c.out.join(''), /accept is lent to agents/);
    assert.equal(runDelegateCommand(['status'], root, ctx), 0);
    assert.match(c.out.join(''), /live/);
    assert.equal(runDelegateCommand(['grant', '--for', '9d'], root, ctx), 1);
    assert.equal(runDelegateCommand(['revoke'], root, ctx), 0);
    assert.match(c.out.join(''), /1 delegation revoked/);
  });

  it('grant and revoke refuse without a terminal, under CI and under TSLAWS_AGENT', () => {
    const home = fresh('home');
    const root = fresh('proj');
    const refused = [
      { isTTY: false, env: {} },
      { isTTY: true, env: { CI: '1' } },
      { isTTY: true, env: { TSLAWS_AGENT: '1' } },
    ];
    for (const who of refused)
      for (const action of ['grant', 'revoke']) {
        const c = capture();
        assert.equal(runDelegateCommand([action], root, { ...who, home, now, ...c.io }), 1);
        assert.match(c.err.join(''), /needs a terminal/);
      }
    assert.ok(!existsSync(delegationFile(home)));
  });

  it('status is read-only and works without a terminal', () => {
    const home = fresh('home');
    const root = fresh('proj');
    const c = capture();
    const ctx = { isTTY: false, env: { CI: '1' }, home, now, ...c.io };
    assert.equal(runDelegateCommand(['status'], root, ctx), 0);
    assert.match(c.out.join(''), /no delegations/);
    writeGrantFile(home, { grants: [{ root, expires: '2001-01-01T00:00:00.000Z' }] });
    runDelegateCommand(['status'], root, ctx);
    assert.match(c.out.join(''), /expired/);
  });

  it('accept refuses with no grant, with the grant hint', async () => {
    const c = capture();
    const code = await acceptCommand(project(), new Map(), [], { isTTY: false, env: {}, home: fresh('home'), ...c.io });
    assert.equal(code, 1);
    assert.match(c.err.join(''), /tslaws delegate grant/);
  });

  it('accept under CI refuses even with a live grant', async () => {
    const home = fresh('home');
    const root = project();
    writeGrantFile(home, { grants: [{ root, expires: new Date(Date.now() + 3_600_000).toISOString() }] });
    const c = capture();
    const code = await acceptCommand(root, new Map(), [], { isTTY: false, env: { CI: '1' }, home, ...c.io });
    assert.equal(code, 1);
    assert.ok(!existsSync(join(root, 'tsc-laws.lock')));
  });

  it('a live grant lets accept write the lock and the audit line', async () => {
    const home = fresh('home');
    const root = project();
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    writeGrantFile(home, { grants: [{ root, expires }] });
    const c = capture();
    const code = await acceptCommand(root, new Map(), [], {
      isTTY: false,
      env: { TSLAWS_AGENT: '1' },
      home,
      ...c.io,
    });
    assert.equal(code, 0, c.err.join(''));
    assert.match(c.out.join(''), /DELEGATED ACCEPT/);
    assert.ok(existsSync(join(root, 'tsc-laws.lock')));
    const log = readFileSync(join(root, '.tslaws', 'accept.log'), 'utf8')
      .trim()
      .split('\n');
    assert.equal(log.length, 1);
    assert.match(log[0]!, /^\d{4}-\d\d-\d\dT[\d:.]+Z delegated expires=\S+ lock-before=none lock-after=[0-9a-f]{64}$/);
    assert.ok(log[0]!.includes(expires));
  });
});

describe('tslaws binary', () => {
  it('refuses grant without a terminal and accept under CI, before any grant file is read', () => {
    const root = fresh('proj');
    writeFileSync(join(root, 'a.laws.ts'), 'export law same(n: number) => n === n;\n');
    const run = (args: string[], env: Record<string, string>) =>
      spawnSync(process.execPath, [bin, ...args], {
        cwd: root,
        encoding: 'utf8',
        input: '',
        env: { ...cleanEnv(), ...env },
      });
    const grant = run(['delegate', 'grant'], {});
    assert.equal(grant.status, 1);
    assert.match(grant.stderr, /needs a terminal/);
    const accept = run(['accept'], { CI: '1' });
    assert.equal(accept.status, 1);
    assert.match(accept.stderr, /CI/);
    assert.ok(!existsSync(join(root, 'tsc-laws.lock')));
  });
});
