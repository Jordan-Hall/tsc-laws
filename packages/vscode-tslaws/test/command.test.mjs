import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { resolveCommand, acceptCommandText } = createRequire(import.meta.url)('../src/command.js');

test('runs the workspace tslaws entry with node, never through a shell', () => {
  const c = resolveCommand({ root: '/w', exists: () => true }, ['check', '--json']);
  assert.equal(c.command, 'node');
  assert.match(c.args[0].replaceAll('\\', '/'), /\/w\/node_modules\/tslaws\/bin\/tslaws\.js$/);
  assert.deepEqual(c.args.slice(1), ['check', '--json']);
  assert.equal(c.shell, false);
});

test('reports a missing install instead of falling back to npx', () => {
  const c = resolveCommand({ root: '/w', exists: () => false }, ['check']);
  assert.match(c.error, /npm i -D tslaws/);
});

test('a .js executable runs under node; a native one runs as is; shims are refused', () => {
  assert.deepEqual(resolveCommand({ root: '/w', executable: '/x/tslaws.js', args: ['--no-prove'] }, ['check']), {
    command: 'node',
    args: ['/x/tslaws.js', 'check', '--no-prove'],
    shell: false,
  });
  assert.deepEqual(resolveCommand({ root: '/w', executable: '/x/tslaws' }, ['check']), {
    command: '/x/tslaws',
    args: ['check'],
    shell: false,
  });
  assert.match(resolveCommand({ root: '/w', executable: 'C:\\x\\tslaws.cmd' }, ['check']).error, /\.cmd/);
});

test('file names with shell metacharacters stay single arguments', () => {
  const c = resolveCommand({ root: '/w', exists: () => true }, ['check', '--json', 'a & calc.exe.laws.ts']);
  assert.equal(c.args.at(-1), 'a & calc.exe.laws.ts');
  assert.equal(c.shell, false);
});

test('accept text is a command line, never executed here', () => {
  assert.equal(acceptCommandText(), 'npx tslaws accept');
});
