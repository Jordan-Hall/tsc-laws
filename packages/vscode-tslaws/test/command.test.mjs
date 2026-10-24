import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { resolveCommand, acceptCommandText } = createRequire(import.meta.url)('../src/command.js');

test('prefers the local node_modules/.bin/tslaws', () => {
  const c = resolveCommand({ root: '/w', platform: 'linux', exists: () => true }, ['check', '--json']);
  assert.match(c.command.replaceAll('\\', '/'), /\/w\/node_modules\/\.bin\/tslaws$/);
  assert.deepEqual(c.args, ['check', '--json']);
  assert.equal(c.shell, false);
});

test('falls back to npx tslaws', () => {
  const c = resolveCommand({ root: '/w', platform: 'linux', exists: () => false }, ['check', '--json']);
  assert.equal(c.command, 'npx');
  assert.deepEqual(c.args, ['tslaws', 'check', '--json']);
});

test('executable setting wins and args are appended', () => {
  const c = resolveCommand({ root: '/w', executable: '/x/tslaws', args: ['--no-prove'], platform: 'linux' }, ['check']);
  assert.equal(c.command, '/x/tslaws');
  assert.deepEqual(c.args, ['check', '--no-prove']);
});

test('Windows .cmd shims and npx use a shell', () => {
  assert.equal(resolveCommand({ root: 'C:/w', platform: 'win32', exists: () => false }, ['ui']).shell, true);
  const c = resolveCommand({ root: 'C:/my w', platform: 'win32', exists: () => true }, ['ui']);
  assert.equal(c.shell, true);
  assert.match(c.command, /^".*tslaws\.cmd"$/);
});

test('accept text is a command line, never executed here', () => {
  assert.equal(acceptCommandText(), 'npx tslaws accept');
});
