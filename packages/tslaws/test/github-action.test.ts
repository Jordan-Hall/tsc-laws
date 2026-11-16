// The composite action's package-manager logic (github/package-manager.mjs) and the shape of github/action.yml.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: a plain .mjs helper next to the action, with no declaration file
import { detect, installCommand, isYarnBerry, resolveBin } from '../github/package-manager.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, '..', 'github', 'package-manager.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'tslaws-action-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function dirWith(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(scratch, 'd-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('package manager detection', () => {
  it('reads the lockfile', () => {
    assert.equal(detect(dirWith({ 'bun.lock': '' })), 'bun');
    assert.equal(detect(dirWith({ 'bun.lockb': '' })), 'bun');
    assert.equal(detect(dirWith({ 'pnpm-lock.yaml': '' })), 'pnpm');
    assert.equal(detect(dirWith({ 'yarn.lock': '' })), 'yarn');
    assert.equal(detect(dirWith({ 'package-lock.json': '{}' })), 'npm');
    assert.equal(detect(dirWith({ 'npm-shrinkwrap.json': '{}' })), 'npm');
  });
  it('goes with the first lockfile when a migration left two', () => {
    assert.equal(detect(dirWith({ 'package-lock.json': '{}', 'bun.lock': '' })), 'bun');
    assert.equal(detect(dirWith({ 'package-lock.json': '{}', 'pnpm-lock.yaml': '' })), 'pnpm');
  });
  it('falls back to the packageManager field, then to npm', () => {
    assert.equal(detect(dirWith({ 'package.json': { packageManager: 'pnpm@9.1.0' } })), 'pnpm');
    assert.equal(detect(dirWith({ 'package.json': { packageManager: 'bun@1.2.0' } })), 'bun');
    assert.equal(detect(dirWith({ 'package.json': { packageManager: 'unknown@1' } })), 'npm');
    assert.equal(detect(dirWith({ 'package.json': '{ not json' })), 'npm');
    assert.equal(detect(dirWith({})), 'npm');
  });
  it('lets an explicit choice beat the lockfile, and refuses a name it does not know', () => {
    const dir = dirWith({ 'bun.lock': '' });
    assert.equal(detect(dir, 'pnpm'), 'pnpm');
    assert.equal(detect(dir, 'auto'), 'bun');
    assert.equal(detect(dir, ''), 'bun');
    assert.equal(detect(dir, 'NPM'), 'npm');
    assert.throws(() => detect(dir, 'deno'), /package-manager must be auto, npm, pnpm, yarn, bun/);
  });
});

describe('frozen installs', () => {
  it("uses each manager's frozen form", () => {
    assert.deepEqual(installCommand('npm'), { command: 'npm', args: ['ci'] });
    assert.deepEqual(installCommand('pnpm'), { command: 'pnpm', args: ['install', '--frozen-lockfile'] });
    assert.deepEqual(installCommand('bun'), { command: 'bun', args: ['install', '--frozen-lockfile'] });
    assert.throws(() => installCommand('deno'), /unknown package manager/);
  });
  it('tells yarn classic from yarn berry', () => {
    const classic = dirWith({ 'yarn.lock': '', 'package.json': { packageManager: 'yarn@1.22.22' } });
    const berry = dirWith({ 'yarn.lock': '', '.yarnrc.yml': '' });
    const field = dirWith({ 'yarn.lock': '', 'package.json': { packageManager: 'yarn@4.1.0' } });
    assert.equal(isYarnBerry(classic), false);
    assert.equal(isYarnBerry(berry), true);
    assert.equal(isYarnBerry(field), true);
    assert.deepEqual(installCommand('yarn', classic).args, ['install', '--frozen-lockfile']);
    assert.deepEqual(installCommand('yarn', berry).args, ['install', '--immutable']);
    assert.deepEqual(installCommand('yarn', dirWith({ 'yarn.lock': '' })).args, ['install', '--frozen-lockfile']);
  });
});

describe('finding the tslaws bin', () => {
  const installed = (layout: string) =>
    dirWith({
      [`${layout}/package.json`]: { name: 'tslaws', version: '1.0.0', bin: { tslaws: 'bin/tslaws.js' } },
      [`${layout}/bin/tslaws.js`]: '',
    });
  it("resolves it by Node's rules, hoisted or in a parent of the directory", () => {
    const hoisted = installed('node_modules/tslaws');
    assert.equal(resolveBin(hoisted), join(hoisted, 'node_modules', 'tslaws', 'bin', 'tslaws.js'));
    mkdirSync(join(hoisted, 'packages', 'a'), { recursive: true });
    assert.equal(
      resolveBin(join(hoisted, 'packages', 'a')),
      join(hoisted, 'node_modules', 'tslaws', 'bin', 'tslaws.js'),
    );
  });
  it('takes a string bin, and fails when tslaws is not installed', () => {
    const dir = dirWith({
      'node_modules/tslaws/package.json': { name: 'tslaws', bin: 'cli.js' },
      'node_modules/tslaws/cli.js': '',
    });
    assert.equal(resolveBin(dir), join(dir, 'node_modules', 'tslaws', 'cli.js'));
    assert.throws(() => resolveBin(dirWith({})), /Cannot find module/);
  });
});

describe('the helper as the action runs it', () => {
  const run = (...args: string[]) => spawnSync('node', [helper, ...args], { encoding: 'utf8' });
  it('prints the manager, and the bin path', () => {
    assert.equal(run('detect', dirWith({ 'pnpm-lock.yaml': '' })).stdout, 'pnpm\n');
    assert.equal(run('detect', dirWith({ 'pnpm-lock.yaml': '' }), 'bun').stdout, 'bun\n');
    const dir = dirWith({ 'node_modules/tslaws/package.json': { bin: { tslaws: 'b.js' } } });
    assert.equal(run('bin', dir).stdout.trim(), join(dir, 'node_modules', 'tslaws', 'b.js'));
  });
  it('fails with an annotation on a name it does not know or a missing install', () => {
    const bad = run('detect', dirWith({}), 'deno');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^::error::package-manager must be auto/);
    const missing = run('bin', dirWith({}));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^::error::/);
  });
});

describe('action.yml', () => {
  const text = readFileSync(join(here, '..', 'github', 'action.yml'), 'utf8');
  it('pins every third-party action to a commit', () => {
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    assert.deepEqual(
      uses.map((u) => u.split('@')[0]),
      ['oven-sh/setup-bun', 'pnpm/action-setup'],
    );
    for (const use of uses) assert.match(use, /@[0-9a-f]{40}$/);
  });
  it('keeps the old inputs and adds package-manager and install', () => {
    for (const input of ['mode', 'token', 'working-directory', 'args', 'tslaws-root', 'package-manager', 'install'])
      assert.match(text, new RegExp(`^  ${input}:`, 'm'), input);
    assert.match(text, /package-manager:[\s\S]*?default: auto/);
    assert.match(text, /install:[\s\S]*?default: 'true'/);
  });
  it('sets up bun and pnpm only when they are the manager, and only when it installs', () => {
    assert.match(text, /if: steps\.detect\.outputs\.manager == 'bun' && inputs\.install == 'true'/);
    assert.match(text, /if: steps\.detect\.outputs\.manager == 'pnpm' && inputs\.install == 'true'/);
  });
  it('gives the token to the tslaws step only, not to the install', () => {
    const install = text.slice(text.indexOf('run: node "$HELPER" install'));
    const before = text.slice(0, text.indexOf('run: node "$HELPER" install'));
    assert.doesNotMatch(before.slice(before.lastIndexOf('- if: inputs.install')), /GITHUB_TOKEN/);
    assert.match(install, /GITHUB_TOKEN: \$\{\{ inputs\.token \}\}/);
  });
});
