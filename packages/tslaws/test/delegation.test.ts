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
// os.homedir() honours HOME and USERPROFILE, so a child process gets a temp home through them.
const homeEnv = (home: string): Record<string, string> => ({ HOME: home, USERPROFILE: home });
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

describe('tslaws CLI', () => {
  const run = (cwd: string, args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', input: '', env: { ...cleanEnv(), ...env } });
  const project = (): string => {
    const root = fresh('proj');
    writeFileSync(join(root, 'a.laws.ts'), 'export law same(n: number) => n === n;\n');
    return root;
  };
  const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString();

  it('refuses grant and revoke without a terminal, under CI and under TSLAWS_AGENT', () => {
    const home = fresh('home');
    const root = fresh('proj');
    for (const extra of [{}, { CI: '1' }, { TSLAWS_AGENT: '1' }])
      for (const action of ['grant', 'revoke']) {
        const result = run(root, ['delegate', action], { ...homeEnv(home), ...extra });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /needs a terminal/);
      }
    assert.ok(!existsSync(delegationFile(home)));
  });

  it('status is read-only and works without a terminal', () => {
    const home = fresh('home');
    const root = fresh('proj');
    assert.match(run(root, ['delegate', 'status'], { ...homeEnv(home), CI: '1' }).stdout, /no delegations/);
    writeGrantFile(home, { grants: [{ root, expires: '2001-01-01T00:00:00.000Z' }] });
    assert.match(run(root, ['delegate', 'status'], { ...homeEnv(home) }).stdout, /expired/);
  });

  it('accept refuses with no grant, with the grant hint', () => {
    const result = run(project(), ['accept'], { ...homeEnv(fresh('home')) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tslaws delegate grant/);
  });

  it('accept under CI refuses even with a live grant', () => {
    const home = fresh('home');
    const root = project();
    writeGrantFile(home, { grants: [{ root, expires: inAnHour() }] });
    const result = run(root, ['accept'], { ...homeEnv(home), CI: '1' });
    assert.equal(result.status, 1);
    assert.ok(!existsSync(join(root, 'tsc-laws.lock')));
  });

  it('a live grant lets accept write the lock and the audit line', () => {
    const home = fresh('home');
    const root = project();
    const expires = inAnHour();
    writeGrantFile(home, { grants: [{ root, expires }] });
    const result = run(root, ['accept'], { ...homeEnv(home), TSLAWS_AGENT: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DELEGATED ACCEPT/);
    assert.ok(existsSync(join(root, 'tsc-laws.lock')));
    const log = readFileSync(join(root, '.tslaws', 'accept.log'), 'utf8')
      .trim()
      .split('\n');
    assert.equal(log.length, 1);
    assert.match(log[0]!, /^\d{4}-\d\d-\d\dT[\d:.]+Z delegated expires=\S+ lock-before=none lock-after=[0-9a-f]{64}$/);
    assert.ok(log[0]!.includes(expires));
  });
});
