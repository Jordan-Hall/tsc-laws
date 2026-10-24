import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { hintFor } from '../dist/hints.js';
import { agentsBegin, hookCommand, init } from '../dist/init.js';
import type { LawResult, LawStatus } from '../dist/types.js';

const root = mkdtempSync(join(tmpdir(), 'tslaws-init-'));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function dir(files: Record<string, string> = {}): string {
  const d = join(root, `p${(counter += 1)}`);
  mkdirSync(d, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, file)), { recursive: true });
    writeFileSync(join(d, file), text);
  }
  return d;
}
const read = (d: string, file: string): string => readFileSync(join(d, file), 'utf8');
const scaffold = ['.gitignore', 'AGENTS.md', '.claude/settings.json', 'src/example.laws.ts'];

describe('init', () => {
  it('scaffolds a fresh directory', () => {
    const d = dir();
    const lines = init({ cwd: d });
    assert.deepEqual(JSON.parse(read(d, 'tslaws.json')), { cover: ['src/**/*.ts', '!src/**/*.laws.ts'] });
    assert.match(read(d, '.gitignore'), /^\.tslaws$/m);
    assert.ok(read(d, 'AGENTS.md').includes(agentsBegin));
    assert.match(read(d, 'AGENTS.md'), /npx tslaws check/);
    const settings = JSON.parse(read(d, '.claude/settings.json'));
    assert.equal(hookCommand, 'node node_modules/tslaws/hooks/claude-hook.mjs');
    assert.equal(settings.hooks.Stop[0].hooks[0].command, hookCommand);
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash');
    assert.match(read(d, 'src/example.laws.ts'), /law additionCommutes/);
    assert.equal(existsSync(join(d, 'tsc-laws.lock')), false);
    assert.equal(lines.length, 5);
  });

  it('is idempotent and never overwrites without --force', () => {
    const d = dir();
    init({ cwd: d });
    writeFileSync(join(d, 'tslaws.json'), '{"cover":["lib/**/*.ts"]}\n');
    const before = scaffold.map((f) => read(d, f));
    const lines = init({ cwd: d });
    assert.deepEqual(
      scaffold.map((f) => read(d, f)),
      before,
    );
    assert.equal(read(d, 'tslaws.json'), '{"cover":["lib/**/*.ts"]}\n');
    assert.ok(
      lines.every((l) => l.startsWith('kept')),
      lines.join('\n'),
    );
    init({ cwd: d, force: true });
    assert.deepEqual(JSON.parse(read(d, 'tslaws.json')).cover, ['src/**/*.ts', '!src/**/*.laws.ts']);
    assert.equal(read(d, 'AGENTS.md').split(agentsBegin).length, 2);
  });

  it('appends to existing .gitignore and AGENTS.md', () => {
    const d = dir({ '.gitignore': 'node_modules', 'AGENTS.md': '# Mine\nKeep this.\n' });
    init({ cwd: d });
    assert.equal(read(d, '.gitignore'), 'node_modules\n.tslaws\n');
    assert.match(read(d, 'AGENTS.md'), /^# Mine\nKeep this\.\n\n<!-- tslaws:begin -->/);
  });

  it('merges hooks into an existing settings file without clobbering keys', () => {
    const existing = {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo edited' }] }],
      },
    };
    const d = dir({ '.claude/settings.json': JSON.stringify(existing) });
    init({ cwd: d });
    const settings = JSON.parse(read(d, '.claude/settings.json'));
    assert.deepEqual(settings.permissions, existing.permissions);
    assert.deepEqual(settings.hooks.PostToolUse, existing.hooks.PostToolUse);
    assert.equal(settings.hooks.Stop.length, 2);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo done');
    assert.equal(settings.hooks.Stop[1].hooks[0].command, hookCommand);
    assert.equal(settings.hooks.PreToolUse.length, 1);
    init({ cwd: d });
    assert.equal(JSON.parse(read(d, '.claude/settings.json')).hooks.Stop.length, 2);
  });

  it('leaves an invalid settings file alone', () => {
    const d = dir({ '.claude/settings.json': '{ nope' });
    const lines = init({ cwd: d });
    assert.equal(read(d, '.claude/settings.json'), '{ nope');
    assert.ok(lines.some((l) => l.startsWith('skipped')));
  });

  it('adds no starter law when a laws file exists', () => {
    const d = dir({ 'lib/math.laws.ts': 'export {};\n' });
    init({ cwd: d });
    assert.equal(existsSync(join(d, 'src', 'example.laws.ts')), false);
    const e = dir({ 'a.proposed.laws.ts': 'export {};\n' });
    init({ cwd: e });
    assert.equal(existsSync(join(e, 'src', 'example.laws.ts')), false);
  });
});

describe('hintFor', () => {
  const base = { file: 'src/a.laws.ts', name: 'law1', line: 3, method: 'smt' };
  const hint = (status: LawStatus, extra: Partial<LawResult> = {}): string | undefined =>
    hintFor({ ...base, status, ...extra });

  it('says nothing for proved', () => assert.equal(hint('proved'), undefined));

  it('tells how to reproduce a failure', () => {
    const h = hint('failed', { counterexample: '[[3,3]]', seed: 42 })!;
    assert.match(h, /Fix the code/);
    assert.match(h, /\[\[3,3\]\]/);
    assert.match(h, /--seed 42/);
  });

  it('explains open laws and who may drop proved', () => {
    const h = hint('open', { message: 'unsupported: while loop' })!;
    assert.match(h, /unsupported: while loop/);
    assert.match(h, /int or bigint/);
    assert.match(h, /person to drop `proved`/);
  });

  it('names the bound and the flag to raise it', () => {
    const h = hint('bounded', { message: 'arrays hold at most 4 elements' })!;
    assert.match(h, /--bound N/);
    assert.match(h, /at most 4 elements/);
  });

  it('says what did not lower for tested', () => {
    const h = hint('tested', { method: 'property', runs: 200 })!;
    assert.match(h, /not proved/);
    assert.match(h, /200 runs/);
  });

  it('asks for a law or a proposal for uncovered code and forbids editing laws', () => {
    const h = hint('uncovered')!;
    assert.match(h, /\.proposed\.laws\.ts/);
    assert.match(h, /Never edit a `\*\.laws\.ts`/);
  });

  it('tells agents to leave tampered laws and the lock alone', () => {
    const h = hint('tampered')!;
    assert.match(h, /Never edit laws or the lock/);
    assert.match(h, /tell the person/);
  });

  it('carries the message of an error', () => {
    assert.match(hint('error', { message: 'law is not exported' })!, /law is not exported/);
  });
});
