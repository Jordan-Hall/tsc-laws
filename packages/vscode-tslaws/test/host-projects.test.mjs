// The extension in a monorepo: each file belongs to the nearest tslaws.json above it, runs go there, what is shown follows
// the open file, and "Check all projects" runs once from the root and sorts the tagged results into their projects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeFake, makeSpawn, until } from './fake-vscode.mjs';

import { activateExtension } from '../src/host.js';

const HELP = 'tslaws check [files...] [--reporter text|json|junit|github|ndjson] [--law NAME[,NAME]] [--json]';
const OLD_HELP = 'tslaws check [files...] [--reporter text|json|junit|github] [--json]';
const line = (o) => `${JSON.stringify(o)}\n`;
const law = (name, status = 'proved') => ({
  file: 'src/cart.laws.ts',
  name,
  line: 3,
  status,
  method: 'smt',
  exercises: [],
});

/** A run's output for one project: plan, results and its report, every line tagged when `tag` is given. */
const projectStream = (results, tag) => {
  const t = (o) => line(tag === undefined ? o : { project: tag, ...o });
  return (
    t({ type: 'plan', laws: results.map((r) => ({ file: r.file, name: r.name, line: r.line })) }) +
    results.map((r) => t({ type: 'result', result: r })).join('') +
    t({ type: 'report', results, compileDiagnostics: '', compileOk: true, lockMissing: false, ok: true })
  );
};

const passing = (call) => {
  call.child.stdout.emit('data', projectStream([law('x')]));
  call.child.emit('close', 0);
};

/**
 * `projects` are directories (relative to the top) that each get a tslaws.json, a laws file and a source. A tslaws is
 * installed in each workspace folder (at the top, for a monorepo). `roots` are the workspace folders (relative to the top).
 */
function monorepo({
  projects = ['packages/a', 'packages/b'],
  roots = ['.'],
  rootConfig = true,
  help = HELP,
  answer,
} = {}) {
  const top = fs.realpathSync(mkdtempSync(path.join(tmpdir(), 'tslaws-mono-')));
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(top, rel)), { recursive: true });
    writeFileSync(path.join(top, rel), text);
  };
  for (const r of roots) put(path.join(r, 'node_modules/tslaws/bin/tslaws.js'), '');
  if (rootConfig) put('tslaws.json', JSON.stringify({ projects: ['packages/*'] }));
  for (const p of projects) {
    put(`${p}/tslaws.json`, '{}');
    put(`${p}/src/cart.ts`, 'export const total = 1;\n');
    put(`${p}/src/cart.laws.ts`, 'export law x(a: number) { return true; }\n');
  }
  const abs = (rel) => path.join(top, rel);
  const fake = makeFake({ roots: roots.map(abs), settings: { debounceMs: 50 } });
  const checks = [];
  const { spawn, calls } = makeSpawn((call) => {
    if (call.args.includes('--help')) {
      call.child.stdout.emit('data', help);
      return call.child.emit('close', 0);
    }
    if (call.args.includes('list')) {
      call.child.stdout.emit(
        'data',
        JSON.stringify({ files: [{ file: 'src/cart.laws.ts', kind: 'node', status: 'accepted', notices: [] }] }),
      );
      return call.child.emit('close', 0);
    }
    checks.push(call);
    answer?.(call, checks.length);
  });
  const context = { subscriptions: [] };
  const api = activateExtension(fake.vscode, context, { spawn, fs });
  return {
    top,
    abs,
    fake,
    api,
    calls,
    checks,
    /** The text of the project status bar item (the second one made). */
    project: () => fake.statuses[1]?.text,
    save: (rel) => fake.events.save.fire(fake.makeDoc(abs(rel))),
    finish: () => {
      context.subscriptions.forEach((s) => s.dispose?.());
      rmSync(top, { recursive: true, force: true });
    },
  };
}

test('a save runs in the nearest tslaws.json, with the install found at the workspace root', async () => {
  const s = monorepo({ answer: passing });
  try {
    s.save('packages/b/src/cart.laws.ts');
    await until(() => s.checks.length === 1, 'the run');
    assert.equal(s.checks[0].opts.cwd, s.abs('packages/b'));
    assert.equal(path.resolve(s.checks[0].args[0]), s.abs('node_modules/tslaws/bin/tslaws.js'));
    assert.ok(s.checks[0].args.includes('src/cart.laws.ts'), 'the file is named relative to the project');
    assert.equal(s.project(), '$(folder) tslaws: packages/b');
    await until(() => s.fake.statuses[0].text === 'laws: 1 proved', 'the result');
  } finally {
    s.finish();
  }
});

test('what is shown follows the open file, and each project keeps its own results', async () => {
  const s = monorepo({
    answer: (call) => {
      const failing = call.opts.cwd.endsWith('b');
      call.child.stdout.emit('data', projectStream([law('x', failing ? 'failed' : 'proved')]));
      call.child.emit('close', failing ? 1 : 0);
    },
  });
  try {
    s.save('packages/a/src/cart.laws.ts');
    await until(() => s.fake.statuses[0].text === 'laws: 1 proved', 'a passes');
    s.save('packages/b/src/cart.laws.ts');
    await until(() => /failed/.test(s.fake.statuses[0].text), 'b fails');
    assert.equal(s.project(), '$(folder) tslaws: packages/b');

    // Back in a: its own result is shown, not b's.
    s.fake.activate(s.fake.makeDoc(s.abs('packages/a/src/cart.ts')));
    assert.equal(s.project(), '$(folder) tslaws: packages/a');
    assert.equal(s.fake.statuses[0].text, 'laws: 1 proved');
    const { states } = s.api.state();
    assert.equal(states.get(s.abs('packages/a')).records.length, 1);
    assert.equal(states.get(s.abs('packages/b')).records[0].status, 'failed');
  } finally {
    s.finish();
  }
});

test('a project that was never run says so while another one has results', async () => {
  const s = monorepo({ answer: passing });
  try {
    s.save('packages/a/src/cart.laws.ts');
    await until(() => s.fake.statuses[0].text === 'laws: 1 proved', 'a runs');
    s.fake.activate(s.fake.makeDoc(s.abs('packages/b/src/cart.ts')));
    assert.equal(s.fake.statuses[0].text, 'laws: not run');
    assert.equal(s.project(), '$(folder) tslaws: packages/b');
  } finally {
    s.finish();
  }
});

test('with several workspace folders, each is its own project and the label names the folder', async () => {
  const s = monorepo({ projects: ['one', 'two'], roots: ['one', 'two'], rootConfig: false, answer: passing });
  try {
    s.save('two/src/cart.laws.ts');
    await until(() => s.checks.length === 1, 'the run');
    assert.equal(s.checks[0].opts.cwd, s.abs('two'));
    assert.equal(s.project(), '$(folder) tslaws: two');
    s.fake.activate(s.fake.makeDoc(s.abs('one/src/cart.ts')));
    assert.equal(s.project(), '$(folder) tslaws: one');
  } finally {
    s.finish();
  }
});

test('Check all projects runs once from the root and files each tagged result under its project', async () => {
  const s = monorepo({
    answer: (call) => {
      call.child.stdout.emit(
        'data',
        projectStream([law('x')], 'packages/a') + projectStream([law('x', 'failed'), law('y')], 'packages/b'),
      );
      call.child.emit('close', 1);
    },
  });
  try {
    await s.fake.commands.get('tslaws.checkAll')();
    assert.equal(s.checks.length, 1, 'one run, not one per project');
    assert.equal(s.checks[0].opts.cwd, s.top);
    assert.ok(s.checks[0].args.includes('ndjson'));
    const { states } = s.api.state();
    assert.equal(states.get(s.abs('packages/a')).records.length, 1);
    const b = states
      .get(s.abs('packages/b'))
      .records.map((r) => [r.name, r.status])
      .sort();
    assert.deepEqual(b, [
      ['x', 'failed'],
      ['y', 'proved'],
    ]);
  } finally {
    s.finish();
  }
});

test('Check all projects needs a tslaws that streams, and says so', async () => {
  const s = monorepo({ help: OLD_HELP });
  try {
    await s.fake.commands.get('tslaws.checkAll')();
    assert.ok(
      s.fake.messages.warning.some((m) => /newer tslaws/.test(m)),
      s.fake.messages.warning.join('|'),
    );
    assert.equal(s.checks.length, 0, 'no run was started');
  } finally {
    s.finish();
  }
});

test('Show the current project says where tslaws runs', async () => {
  const s = monorepo();
  try {
    s.fake.activate(s.fake.makeDoc(s.abs('packages/a/src/cart.ts')));
    s.fake.commands.get('tslaws.showProject')();
    await until(() => s.fake.messages.info.length === 1, 'the message');
    assert.match(s.fake.messages.info[0], /tslaws project: packages\/a/);
    assert.match(s.fake.messages.info[0], /runs in .*packages.a/);
  } finally {
    s.finish();
  }
});
