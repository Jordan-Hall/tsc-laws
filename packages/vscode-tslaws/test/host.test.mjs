// The whole extension under a fake `vscode` and a scripted `tslaws`: a file is saved, the right laws run, results stream
// in, and the diagnostics, lenses, hover, quick fixes, decorations, status bar and test results come out. The `tslaws`
// output is canned; test/real-cli.test.mjs feeds the same code the real CLI's output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeFake, makeSpawn, settle, until } from './fake-vscode.mjs';

const require = createRequire(import.meta.url);
const { activateExtension } = require('../src/host.js');

const HELP = 'tslaws check [files...] [--reporter text|json|junit|github|ndjson] [--law NAME[,NAME]] [--json]';
const OLD_HELP = 'tslaws check [files...] [--reporter text|json|junit|github] [--json]';

const CART = [
  '// the price',
  'export function total(price: number, coupon: number): number {',
  '  return price - coupon;',
  '}',
  '',
].join('\n');
const LAWS = [
  "import { total } from './cart';",
  '',
  'export law totalNeverNegative(price: number, coupon: number) {',
  '  return total(price, coupon) >= 0;',
  '}',
  'export law couponNeverRaisesTheTotal(price: number, coupon: number) => total(price, coupon) <= price;',
  '',
].join('\n');

const span = (file, line, column, name) => ({ file, line, column, endLine: line, endColumn: column + name.length });
const exercises = [
  {
    name: 'total',
    declaration: span('src/cart.ts', 2, 17, 'total'),
    call: span('src/cart.laws.ts', 4, 10, 'total'),
  },
];
const failedResult = {
  file: 'src/cart.laws.ts',
  name: 'totalNeverNegative',
  line: 3,
  status: 'failed',
  method: 'property',
  runs: 12,
  seed: 99,
  counterexample: '[0,1]',
  message: 'returned false',
  exercises,
};
const provedResult = (name, line) => ({
  file: 'src/cart.laws.ts',
  name,
  line,
  status: 'proved',
  method: 'smt',
  exercises,
});
const otherResult = provedResult('couponNeverRaisesTheTotal', 6);

const line = (o) => `${JSON.stringify(o)}\n`;
const stream = (results) => {
  const plan = results.map((r) => ({ file: r.file, name: r.name, line: r.line }));
  return (
    line({ type: 'plan', laws: plan }) +
    results
      .map((r) => line({ type: 'start', file: r.file, name: r.name }) + line({ type: 'result', result: r }))
      .join('') +
    line({
      type: 'report',
      results,
      compileDiagnostics: '',
      compileOk: true,
      lockMissing: false,
      ok: results.every((r) => r.status === 'proved'),
    })
  );
};

/** A project on disk, the extension under the fake, and a `tslaws` that answers `check` with `answer(call)`. */
function scenario({
  settings = {},
  help = HELP,
  answer,
  trusted = true,
  before,
  cpus,
  extraLawFiles = [],
  listing,
  found,
} = {}) {
  const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), 'tslaws-host-')));
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  put('src/cart.ts', CART);
  put('src/cart.laws.ts', LAWS);
  put('node_modules/tslaws/bin/tslaws.js', '');
  put('tsc-laws.lock', '{}');
  before?.(put, root);
  const fake = makeFake({
    root,
    settings: { debounceMs: 100, ...settings },
    trusted,
    lawFiles: [...(found ?? ['src/cart.laws.ts']), ...extraLawFiles].map((f) => path.join(root, f)),
  });
  const checks = [];
  const lists = [];
  const { spawn, calls } = makeSpawn((call) => {
    if (call.args.includes('--help')) {
      call.child.stdout.emit('data', help);
      return call.child.emit('close', 0);
    }
    if (call.args.includes('list')) {
      lists.push(call);
      // `listing: null` is a tslaws too old to know `list`: it prints usage text.
      call.child.stdout.emit(
        'data',
        listing === null
          ? 'unknown command'
          : JSON.stringify({
              files:
                listing ??
                [...(found ?? ['src/cart.laws.ts']), ...extraLawFiles].map((file) => ({
                  file,
                  kind: 'node',
                  status: 'accepted',
                  notices: [],
                })),
            }),
      );
      return call.child.emit('close', 0);
    }
    checks.push(call);
    answer?.(call, checks.length);
  });
  const context = { subscriptions: [] };
  const api = activateExtension(fake.vscode, context, { spawn, fs, cpus });
  const abs = (rel) => path.join(root, rel);
  return {
    root,
    fake,
    api,
    calls,
    checks,
    lists,
    abs,
    put,
    context,
    diag: (rel) => fake.collections[0].store.get(abs(rel)),
    save: (rel) => fake.events.save.fire(fake.makeDoc(abs(rel))),
    finish: () => {
      context.subscriptions.forEach((s) => s.dispose?.());
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const emitAll =
  (results, code = 1) =>
  (call) => {
    call.child.stdout.emit('data', stream(results));
    call.child.emit('close', code);
  };

test('saving a covered file runs its laws, then marks the failure on the law and on the function', async () => {
  const s = scenario({ answer: emitAll([failedResult, otherResult]) });
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'diagnostics');

    // Only the laws file beside the changed file ran, streamed.
    assert.equal(s.checks.length, 1);
    assert.ok(s.checks[0].args.includes('ndjson') && s.checks[0].args.includes('src/cart.laws.ts'));
    assert.equal(s.checks[0].opts.cwd, s.root);
    assert.equal(s.checks[0].opts.shell, false);

    const [onLaw] = s.diag('src/cart.laws.ts');
    const [onSource] = s.diag('src/cart.ts');
    assert.equal(onLaw.code, 'tslaws/totalNeverNegative');
    assert.equal(onSource.code, 'tslaws/totalNeverNegative');
    assert.equal(onLaw.source, 'tslaws');
    assert.equal(onLaw.severity, 0);
    assert.equal(onLaw.range.start.line, 2);
    assert.equal(onSource.range.start.line, 1);
    assert.equal(onSource.range.start.character, 16);
    assert.equal(onSource.range.end.character, 21, 'covers the name total, not the line');
    assert.match(onLaw.message, /Shrunk counterexample: price = 0, coupon = 1/);

    // Each links to the other.
    assert.equal(onLaw.relatedInformation[0].location.uri.fsPath, s.abs('src/cart.ts'));
    assert.equal(onLaw.relatedInformation[0].location.range.start.line, 1);
    assert.equal(onSource.relatedInformation[0].location.uri.fsPath, s.abs('src/cart.laws.ts'));
    assert.equal(onSource.relatedInformation[0].location.range.start.line, 2);

    // The passing law is not marked.
    assert.equal(s.diag('src/cart.laws.ts').length, 1);
  } finally {
    s.finish();
  }
});

test('a rerun that passes clears both ends', async () => {
  let n = 0;
  const s = scenario({
    answer: (call) =>
      emitAll(
        n++ === 0 ? [failedResult, otherResult] : [provedResult('totalNeverNegative', 3), otherResult],
        n === 1 ? 1 : 0,
      )(call),
  });
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts')?.length === 1, 'the failure');
    s.save('src/cart.ts');
    await until(
      () => (s.diag('src/cart.ts') ?? []).length === 0 && (s.diag('src/cart.laws.ts') ?? []).length === 0,
      'the clear',
    );
    assert.match(s.fake.statuses[0].text, /^laws: 2 proved$/);
  } finally {
    s.finish();
  }
});

test('a newer save stops the run that is going, and only the newer run counts', async () => {
  let n = 0;
  const s = scenario({
    answer: (call) => {
      n++;
      if (n === 1) return; // the first run hangs until it is cancelled
      emitAll([provedResult('totalNeverNegative', 3), otherResult], 0)(call);
    },
  });
  try {
    s.save('src/cart.ts');
    await until(() => s.checks.length === 1, 'the first run');
    s.save('src/cart.ts');
    await until(() => s.checks.length === 2, 'the second run');
    assert.equal(s.checks[0].child.killed, true, 'the stale run was killed');
    await until(() => s.fake.statuses[0].text === 'laws: 2 proved', 'the second result');
    assert.equal(s.diag('src/cart.ts')?.length ?? 0, 0);
  } finally {
    s.finish();
  }
});

test('status text counts the results as they arrive', async () => {
  const s = scenario();
  try {
    s.save('src/cart.ts');
    await until(() => s.checks.length === 1, 'the run');
    const child = s.checks[0].child;
    child.stdout.emit(
      'data',
      line({
        type: 'plan',
        laws: [
          { file: 'src/cart.laws.ts', name: 'a', line: 1 },
          { file: 'src/cart.laws.ts', name: 'b', line: 2 },
        ],
      }),
    );
    child.stdout.emit('data', line({ type: 'result', result: failedResult }));
    await until(() => /running 1\/2 - 1 failed/.test(s.fake.statuses[0].text), 'progress in the status bar');
    assert.match(s.fake.statuses[0].text, /^\$\(sync~spin\) laws: running 1\/2/);
    child.emit('close', 1);
  } finally {
    s.finish();
  }
});

test('lenses: state and counts above the law, the covering laws above the function', async () => {
  const s = scenario({ answer: emitAll([failedResult, otherResult]) });
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'diagnostics');
    const [lens] = s.fake.providers.lens;

    const lawLenses = lens.provideCodeLenses(s.fake.makeDoc(s.abs('src/cart.laws.ts')));
    const titles = lawLenses.map((l) => l.command.title);
    assert.ok(titles.includes('$(error) 1 proved, 1 failed'), titles.join(' | '));
    const status = lawLenses.find((l) => /failed · property, 12 runs, seed 99 · \d\d:\d\d:\d\d/.test(l.command.title));
    assert.ok(status, 'failed with counts and the time');
    assert.equal(status.range.start.line, 2);
    assert.deepEqual(
      [status.command.command, status.command.arguments],
      ['tslaws.runLaw', ['src/cart.laws.ts', 'totalNeverNegative']],
    );
    assert.ok(titles.some((t) => /Fails in total/.test(t)));
    assert.ok(titles.some((t) => t.startsWith('$(check) proved · smt')));

    const sourceLenses = lens.provideCodeLenses(s.fake.makeDoc(s.abs('src/cart.ts')));
    assert.equal(sourceLenses.length, 1);
    assert.equal(sourceLenses[0].command.title, '$(error) covered by 2 laws, 1 failing');
    assert.equal(sourceLenses[0].range.start.line, 1);
    assert.equal(sourceLenses[0].command.command, 'tslaws.goToLaws');

    // Before any run a laws file says so.
    assert.deepEqual(lens.provideCodeLenses(s.fake.makeDoc(s.abs('src/other.ts'), 'export const x = 1;')), []);
  } finally {
    s.finish();
  }
});

test('hover shows the shrunk input and the command, and quick fixes re-run, open and copy', async () => {
  const s = scenario({ answer: emitAll([failedResult, otherResult]) });
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'diagnostics');

    const sourceDoc = s.fake.makeDoc(s.abs('src/cart.ts'));
    const hover = s.fake.providers.hover[0].provideHover(sourceDoc, { line: 1, character: 18 });
    assert.match(hover.contents.value, /Shrunk counterexample: price = 0, coupon = 1/);
    assert.match(hover.contents.value, /npx tslaws check src\/cart\.laws\.ts --law totalNeverNegative --seed 99/);
    assert.match(hover.contents.value, /\[Open the failing law\]\(command:tslaws\.openLaw\?/);
    assert.match(hover.contents.value, /\[Copy the reproduce command\]\(command:tslaws\.copyReproduce\?/);
    assert.deepEqual(hover.contents.isTrusted.enabledCommands.includes('tslaws.runLaw'), true);
    assert.equal(s.fake.providers.hover[0].provideHover(sourceDoc, { line: 0, character: 2 }), undefined);

    const [diag] = s.diag('src/cart.ts');
    const actions = s.fake.providers.actions[0].provideCodeActions(sourceDoc, diag.range, { diagnostics: [diag] });
    assert.deepEqual(
      actions.map((a) => [a.title, a.command.command, a.command.arguments]),
      [
        ['tslaws: Re-run this law', 'tslaws.runLaw', ['src/cart.laws.ts', 'totalNeverNegative']],
        ['tslaws: Open the failing law', 'tslaws.openLaw', ['src/cart.laws.ts', 'totalNeverNegative']],
        ['tslaws: Copy the reproduce command', 'tslaws.copyReproduce', ['src/cart.laws.ts', 'totalNeverNegative']],
      ],
    );
    assert.equal(actions[0].kind, 'quickfix');

    // The commands behind them.
    await s.fake.commands.get('tslaws.copyReproduce')('src/cart.laws.ts', 'totalNeverNegative');
    assert.deepEqual(s.fake.clipboard, ['npx tslaws check src/cart.laws.ts --law totalNeverNegative --seed 99']);
    await s.fake.commands.get('tslaws.openLaw')('src/cart.laws.ts', 'totalNeverNegative');
    assert.equal(s.fake.opened.at(-1).selection.start.line, 2);
    await s.fake.commands.get('tslaws.openSource')('src/cart.laws.ts', 'totalNeverNegative');
    assert.equal(s.fake.opened.at(-1).document.uri.fsPath, s.abs('src/cart.ts'));
    assert.equal(s.fake.opened.at(-1).selection.start.line, 1);

    // Re-running the law asks tslaws for just that law.
    void s.fake.commands.get('tslaws.runLaw')('src/cart.laws.ts', 'totalNeverNegative');
    await until(() => s.checks.length === 2, 'the rerun');
    assert.ok(s.checks[1].args.join(' ').includes('--law totalNeverNegative'));
    s.checks[1].child.emit('close', 0);
  } finally {
    s.finish();
  }
});

test('the counterexample is shown after the failing line on both ends, and the call is marked', async () => {
  const s = scenario({ answer: emitAll([failedResult, otherResult]) });
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'diagnostics');
    const law = s.fake.makeDoc(s.abs('src/cart.laws.ts'));
    const src = s.fake.makeDoc(s.abs('src/cart.ts'));
    s.fake.show(law);
    s.fake.events.editors.fire([s.fake.show(law)]);
    s.fake.events.editors.fire([s.fake.show(src)]);

    // decoration types: 0 error, 1 warning, 2 call (created in the order error, call, error..) - find by content
    const errorIndex = s.fake.decorationTypes.findIndex((t) =>
      t.o.light?.gutterIconPath?.fsPath.endsWith('failed-light.svg'),
    );
    // the failing function's status is the always-visible one (status-decor), not this decoration
    assert.equal(s.fake.decorationsOn(s.abs('src/cart.ts'), errorIndex).length, 0);
    const statusErrorIndex = s.fake.decorationTypes.findIndex(
      (t) =>
        t.o.after?.color.id === 'editorError.foreground' &&
        t.o.light?.gutterIconPath?.fsPath.endsWith('failed-light.svg') &&
        t !== s.fake.decorationTypes[errorIndex],
    );
    const onSource = s.fake.decorationsOn(s.abs('src/cart.ts'), statusErrorIndex);
    assert.equal(onSource.length, 1);
    assert.equal(onSource[0].range.start.line, 1);
    assert.equal(onSource[0].renderOptions.after.contentText, '  failing: counterexample (price=0, coupon=1)');
    s.fake.events.editors.fire([s.fake.show(law)]);
    const onLaw = s.fake.decorationsOn(s.abs('src/cart.laws.ts'), errorIndex);
    assert.equal(onLaw[0].renderOptions.after.contentText, '  failed: counterexample price = 0, coupon = 1');
    const callIndex = s.fake.decorationTypes.findIndex((t) => t.o.borderStyle !== undefined);
    assert.equal(s.fake.decorationsOn(s.abs('src/cart.laws.ts'), callIndex).length, 1);
    assert.ok(s.fake.decorationTypes[errorIndex].o.after.color.id === 'editorError.foreground', 'theme-aware colours');
  } finally {
    s.finish();
  }
});

test('tslaws.run and the old tslaws.runOnSave decide whether a save runs anything', async () => {
  for (const [settings, runs] of [
    [{ run: 'manual' }, false],
    [{ runOnSave: false }, false],
    [{ run: 'onSave', runOnSave: false }, true],
    [{ runOnSave: true }, true],
  ]) {
    const s = scenario({ settings, answer: emitAll([otherResult], 0) });
    try {
      s.save('src/cart.ts');
      await settle(350);
      assert.equal(s.checks.length, runs ? 1 : 0, JSON.stringify(settings));
    } finally {
      s.finish();
    }
  }
});

test('typing runs only in onType mode, on a copy that holds the unsaved text', async () => {
  const s = scenario({ settings: { run: 'onType' }, answer: emitAll([otherResult], 0) });
  try {
    const unsaved = CART.replace('price - coupon', 'price - coupon - 1');
    const doc = s.fake.open(s.abs('src/cart.ts'), unsaved, true);
    s.fake.events.change.fire({ document: doc, contentChanges: [{ text: '-' }] });
    await until(() => s.checks.length === 1, 'a run after typing');
    const cwd = s.checks[0].opts.cwd;
    assert.equal(cwd, path.join(s.root, '.tslaws', 'shadow'));
    assert.equal(fs.readFileSync(path.join(cwd, 'src/cart.ts'), 'utf8'), unsaved);
    assert.equal(fs.readFileSync(s.abs('src/cart.ts'), 'utf8'), CART, 'the real file is untouched');
    assert.ok(
      s.checks[0].args[0].endsWith(path.join('node_modules', 'tslaws', 'bin', 'tslaws.js')) ||
        s.checks[0].args[0].includes('tslaws.js'),
    );
    assert.ok(s.checks[0].args[0].startsWith(s.root), 'the real tslaws runs, on the copy');
  } finally {
    s.finish();
  }

  // In the default mode typing does nothing.
  const quiet = scenario({ answer: emitAll([otherResult], 0) });
  try {
    const doc = quiet.fake.open(quiet.abs('src/cart.ts'), CART + '// x', true);
    quiet.fake.events.change.fire({ document: doc, contentChanges: [{ text: 'x' }] });
    await settle(350);
    assert.equal(quiet.checks.length, 0);
  } finally {
    quiet.finish();
  }
});

test('a tslaws without streaming is run with --json and still marks both ends', async () => {
  const s = scenario({
    help: OLD_HELP,
    answer: (call) => {
      call.child.stdout.emit('data', JSON.stringify({ results: [failedResult, otherResult], ok: false }));
      call.child.emit('close', 1);
    },
  });
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'diagnostics');
    assert.ok(s.checks[0].args.includes('--json'));
    assert.ok(!s.checks[0].args.includes('ndjson'));
  } finally {
    s.finish();
  }
});

test('an untrusted workspace runs nothing on save, and a command says why', async () => {
  const s = scenario({ trusted: false, answer: emitAll([otherResult], 0) });
  try {
    s.save('src/cart.ts');
    await settle(350);
    assert.equal(s.checks.length, 0);
    assert.equal(s.fake.messages.warning.length, 0, 'no nagging on every save');
    await s.fake.commands.get('tslaws.check')();
    assert.match(s.fake.messages.warning[0], /trust this workspace/);
    assert.equal(s.checks.length, 0);
  } finally {
    s.finish();
  }
});

test('a change to a file no law is near runs every law, and a file that is not code runs none', async () => {
  const s = scenario({ answer: emitAll([otherResult], 0) });
  try {
    s.put('lib/util.ts', 'export const x = 1;\n');
    s.save('lib/util.ts');
    await until(() => s.checks.length === 1, 'a run');
    assert.ok(!s.checks[0].args.some((a) => a.endsWith('.laws.ts')), 'no files named: every laws file runs');
    s.save('README.md');
    await settle(350);
    assert.equal(s.checks.length, 1);
  } finally {
    s.finish();
  }
});

test('accept only types the command, and the command list is the old one plus the new', async () => {
  const s = scenario();
  try {
    s.fake.commands.get('tslaws.accept')();
    assert.deepEqual(s.fake.terminals[0].sent, [['npx tslaws accept', false]]);
    assert.deepEqual([...s.fake.commands.keys()].sort(), [
      'tslaws.accept',
      'tslaws.cancel',
      'tslaws.check',
      'tslaws.copyReproduce',
      'tslaws.goToFunction',
      'tslaws.goToLaw',
      'tslaws.goToLaws',
      'tslaws.openDashboard',
      'tslaws.openFunction',
      'tslaws.openLaw',
      'tslaws.openSource',
      'tslaws.pauseLive',
      'tslaws.peekLaws',
      'tslaws.runFile',
      'tslaws.runLaw',
      'tslaws.showLaws',
      'tslaws.writeLaw',
    ]);
    assert.ok(!s.calls.some((c) => c.args.includes('accept')), 'accept was never started as a process');
  } finally {
    s.finish();
  }
});

test('Test Explorer: laws are tests, a run reports each at the law and at the code, and failed ones can be rerun alone', async () => {
  let n = 0;
  const s = scenario({
    answer: (call) => {
      n++;
      emitAll(n === 1 ? [failedResult, otherResult] : [provedResult('totalNeverNegative', 3)], n === 1 ? 1 : 0)(call);
    },
  });
  try {
    const controller = s.fake.controllers[0];
    await controller.resolveHandler(undefined);
    const file = controller.items.get('src/cart.laws.ts');
    assert.ok(file, 'the laws file is a test item');
    assert.deepEqual(
      [...file.children].map((i) => i.label),
      ['totalNeverNegative', 'couponNeverRaisesTheTotal'],
    );
    assert.equal(file.children.get('src/cart.laws.ts::totalNeverNegative').range.start.line, 2);
    assert.deepEqual(
      controller.profiles.map((p) => [p.label, p.isDefault]),
      [
        ['Run', true],
        ['Rerun failed', false],
        ['Run without the prover', false],
      ],
    );

    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    await controller.profiles[0].handler({ include: undefined, exclude: [] }, token);
    const run = controller.runs[0];
    const states = Object.fromEntries(
      run.log.filter((l) => l.state !== 'enqueued' && l.state !== 'started').map((l) => [l.id, l.state]),
    );
    assert.deepEqual(states, {
      'src/cart.laws.ts::totalNeverNegative': 'failed',
      'src/cart.laws.ts::couponNeverRaisesTheTotal': 'passed',
    });
    const failed = run.log.find((l) => l.state === 'failed');
    assert.equal(failed.extra.length, 2, 'one message at the law, one at the function');
    assert.equal(failed.extra[0].location.uri.fsPath, s.abs('src/cart.laws.ts'));
    assert.equal(failed.extra[1].location.uri.fsPath, s.abs('src/cart.ts'));
    assert.equal(failed.extra[1].location.range.start.line, 1);
    assert.match(failed.extra[0].message, /Shrunk counterexample/);
    assert.ok(run.ended);
    assert.ok(!s.checks[0].args.includes('--law'), 'running everything names no laws');

    // The Testing view's run also feeds the diagnostics.
    assert.equal(s.diag('src/cart.ts').length, 1);

    // Rerun failed: only the failed law is asked for.
    await controller.profiles[1].handler({ include: undefined, exclude: [] }, token);
    const second = s.checks[1].args.join(' ');
    assert.match(second, /--law totalNeverNegative src\/cart\.laws\.ts$/);
    assert.ok(!second.includes('couponNeverRaisesTheTotal'));
    assert.equal(controller.runs[1].log.find((l) => l.state === 'passed').id, 'src/cart.laws.ts::totalNeverNegative');
    assert.equal((s.diag('src/cart.ts') ?? []).length, 0, 'now passing, so cleared');

    // No prover.
    await controller.profiles[2].handler({ include: undefined, exclude: [] }, token);
    assert.ok(s.checks[2].args.includes('--no-prove'));
  } finally {
    s.finish();
  }
});

test('Test Explorer: excluding a law from a selected file runs only the others, and excluding all runs nothing', async () => {
  const s = scenario({ answer: emitAll([otherResult], 0) });
  try {
    const controller = s.fake.controllers[0];
    await controller.resolveHandler(undefined);
    const file = controller.items.get('src/cart.laws.ts');
    const excluded = file.children.get('src/cart.laws.ts::totalNeverNegative');
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

    await controller.profiles[0].handler({ include: [file], exclude: [excluded] }, token);
    assert.equal(s.checks.length, 1);
    assert.match(s.checks[0].args.join(' '), /--law couponNeverRaisesTheTotal src\/cart\.laws\.ts$/);
    assert.ok(!s.checks[0].args.join(' ').includes('totalNeverNegative'));

    // Selecting the whole file with nothing excluded still runs the file as a whole.
    await controller.profiles[0].handler({ include: [file], exclude: [] }, token);
    assert.ok(!s.checks[1].args.includes('--law'));

    // Every law excluded: nothing is asked of tslaws.
    await controller.profiles[0].handler({ include: [file], exclude: [...file.children].map((i) => i) }, token);
    assert.equal(s.checks.length, 2);
  } finally {
    s.finish();
  }
});

// ---- live results, the Laws view, writing a law, and navigation ----

const hang = () => {};
const edit = (s, rel, text = CART) => {
  const doc = s.fake.open(s.abs(rel), text, true);
  s.fake.events.change.fire({ document: doc, contentChanges: [{ text: ' ' }] });
  return doc;
};
/** Every always-visible text decoration set on a file, whatever its colour. */
const shownOn = (s, rel) => {
  const out = [];
  s.fake.decorationTypes.forEach((_, i) => {
    for (const d of s.fake.decorationsOn(s.abs(rel), i)) out.push(d.renderOptions.after.contentText.trim());
  });
  return out;
};
const show = (s, rel) => s.fake.events.editors.fire([s.fake.show(s.fake.makeDoc(s.abs(rel)))]);
const statusLine = (s) => s.fake.statuses[0].text;

test('live results: typing in a function runs its laws in the background and its status follows', async () => {
  const s = scenario({ settings: { liveBackground: 'on' }, answer: emitAll([failedResult, otherResult]) });
  try {
    edit(s, 'src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'the background run to finish');
    assert.equal(s.checks.length, 1);
    show(s, 'src/cart.ts');
    assert.deepEqual(
      shownOn(s, 'src/cart.ts').filter((t) => t.startsWith('failing')),
      ['failing: counterexample (price=0, coupon=1)'],
    );
    assert.match(s.fake.treeViews[0].description, /1 failing/);
  } finally {
    s.finish();
  }
});

test('the status after a function says tested with its runs, bounded, and stale after an edit', async () => {
  const tested = { ...provedResult('totalNeverNegative', 3), status: 'tested', runs: 24 };
  const s = scenario({
    settings: { liveBackground: 'off' },
    answer: emitAll([tested, { ...otherResult, status: 'tested', runs: 6 }], 0),
  });
  try {
    s.save('src/cart.ts');
    await until(() => s.fake.statuses[0].text.includes('tested'), 'results');
    await settle(150);
    show(s, 'src/cart.ts');
    assert.deepEqual(shownOn(s, 'src/cart.ts'), ['tested 30 runs']);
    edit(s, 'src/cart.ts');
    await settle(200);
    show(s, 'src/cart.ts');
    assert.deepEqual(shownOn(s, 'src/cart.ts'), ['stale · ran just now']);
  } finally {
    s.finish();
  }
  const bounded = scenario({
    settings: { liveBackground: 'off' },
    answer: emitAll([provedResult('totalNeverNegative', 3), { ...otherResult, status: 'bounded' }], 0),
  });
  try {
    bounded.save('src/cart.ts');
    await until(() => bounded.fake.statuses[0].text.includes('bounded'), 'results');
    await settle(150);
    show(bounded, 'src/cart.ts');
    assert.deepEqual(shownOn(bounded, 'src/cart.ts'), ['bounded']);
  } finally {
    bounded.finish();
  }
});

test('an exported function no law reaches is a hint with a one-click law, written only to a proposed file', async () => {
  const uncovered = {
    file: 'src/cart.ts',
    name: 'total',
    line: 2,
    status: 'uncovered',
    method: 'coverage',
    message: 'no law',
    exercises: [],
  };
  const s = scenario({ answer: emitAll([uncovered], 1) });
  try {
    void s.fake.commands.get('tslaws.check')();
    await until(() => s.diag('src/cart.ts') !== undefined, 'the hint');
    const [d] = s.diag('src/cart.ts');
    assert.equal(d.severity, 3, 'a hint, not an error or a warning');
    show(s, 'src/cart.ts');
    assert.deepEqual(shownOn(s, 'src/cart.ts'), ['uncovered: no law reaches this function']);
    const [actions] = s.fake.providers.actions;
    const fixes = actions.provideCodeActions(s.fake.makeDoc(s.abs('src/cart.ts')), d.range, { diagnostics: [d] });
    assert.deepEqual(
      fixes.map((f) => [f.title, f.command.command, f.command.arguments]),
      [['tslaws: Write a law for this function', 'tslaws.writeLaw', ['src/cart.ts', 'total']]],
    );

    const acceptedBefore = fs.readFileSync(s.abs('src/cart.laws.ts'), 'utf8');
    await s.fake.commands.get('tslaws.writeLaw')('src/cart.ts', 'total');
    const proposed = fs.readFileSync(s.abs('src/cart.proposed.laws.ts'), 'utf8');
    assert.match(proposed, /import \{ total \} from '\.\/cart';/);
    assert.match(proposed, /export law totalHolds\(price: number, coupon: number\) \{/);
    assert.equal(
      fs.readFileSync(s.abs('src/cart.laws.ts'), 'utf8'),
      acceptedBefore,
      'an accepted laws file is never written',
    );
    assert.equal(fs.readFileSync(s.abs('tsc-laws.lock'), 'utf8'), '{}', 'the lock is never written');
    assert.ok(s.fake.opened.length > 0, 'the new law is shown');
    await s.fake.commands.get('tslaws.writeLaw')('src/cart.ts', 'total');
    assert.equal(fs.readFileSync(s.abs('src/cart.proposed.laws.ts'), 'utf8'), proposed, 'nothing is added twice');
    await s.fake.commands.get('tslaws.writeLaw')('src/cart.laws.ts', 'totalNeverNegative');
    assert.ok(!fs.existsSync(s.abs('src/cart.laws.proposed.laws.ts')));
    assert.match(s.fake.messages.warning.join('\n'), /TypeScript source file/);
  } finally {
    s.finish();
  }
});

test('the last report survives a reload, and a file edited since is stale', async () => {
  const s = scenario({ settings: { liveBackground: 'off' }, answer: emitAll([failedResult, otherResult]) });
  try {
    s.save('src/cart.ts');
    await until(() => fs.existsSync(path.join(s.root, '.tslaws', 'last-report.json')), 'the cache to be written', 4000);
    s.context.subscriptions.forEach((x) => x.dispose?.());
    const open = () =>
      makeFake({ root: s.root, settings: { liveBackground: 'off' }, lawFiles: [s.abs('src/cart.laws.ts')] });
    const { spawn } = makeSpawn(() => {});
    const reopened = open();
    activateExtension(reopened.vscode, { subscriptions: [] }, { spawn, fs });
    assert.equal(
      reopened.collections[0].store.get(s.abs('src/cart.ts')).length,
      1,
      'the failure is marked without a run',
    );
    assert.match(reopened.statuses[0].text, /1 failed/);
    assert.equal(reopened.treeViews.length, 1);

    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(s.abs('src/cart.ts'), later, later);
    const third = open();
    activateExtension(third.vscode, { subscriptions: [] }, { spawn, fs });
    third.events.editors.fire([third.show(third.makeDoc(s.abs('src/cart.ts')))]);
    const texts = [];
    third.decorationTypes.forEach((_, i) =>
      third.decorationsOn(s.abs('src/cart.ts'), i).forEach((d) => texts.push(d.renderOptions.after.contentText.trim())),
    );
    assert.equal(texts.length, 1, texts.join('|'));
    assert.ok(texts[0].startsWith('stale'), texts[0]);
  } finally {
    s.finish();
  }
});

test('the Laws view groups by status with the failing first, and a click reveals the law', async () => {
  const s = scenario({ answer: emitAll([failedResult, otherResult]) });
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'results');
    const provider = s.fake.treeViews[0].options.treeDataProvider;
    const groups = provider.getChildren(undefined);
    assert.deepEqual(
      groups.map((g) => g.label),
      ['Failing (1)', 'Proved (1)'],
    );
    const [law] = provider.getChildren(groups[0]);
    const item = provider.getTreeItem(law);
    assert.equal(item.label, 'totalNeverNegative');
    assert.match(item.description, /^src\/cart\.laws\.ts · /);
    assert.match(item.tooltip, /counterexample price = 0, coupon = 1/);
    assert.deepEqual(
      [item.command.command, item.command.arguments],
      ['tslaws.openLaw', ['src/cart.laws.ts', 'totalNeverNegative']],
    );
    assert.equal(s.fake.statuses[0].command, 'tslawsLaws.focus');
  } finally {
    s.finish();
  }
});

test('pausing live results stops background runs until they are resumed', async () => {
  const s = scenario({ settings: { liveBackground: 'on' }, answer: emitAll([otherResult], 0) });
  try {
    await s.fake.commands.get('tslaws.pauseLive')();
    assert.ok(statusLine(s).startsWith('$(debug-pause)'), statusLine(s));
    edit(s, 'src/cart.ts');
    await settle(400);
    assert.equal(s.checks.length, 0, 'no run while paused');
    await s.fake.commands.get('tslaws.pauseLive')();
    edit(s, 'src/cart.ts');
    await until(() => s.checks.length === 1, 'a run after resuming');
  } finally {
    s.finish();
  }
});

test('live results wait while the machine is busy', async () => {
  let t = 0;
  const busy = () => [{ times: { user: (t += 1000), nice: 0, sys: 0, idle: t / 1000, irq: 0 } }];
  const s = scenario({ settings: { liveBackground: 'on' }, cpus: busy, answer: emitAll([otherResult], 0) });
  try {
    edit(s, 'src/cart.ts');
    await settle(400);
    assert.equal(s.checks.length, 0, 'the machine is busy, so nothing started');
  } finally {
    s.finish();
  }
});

test('live results stop by themselves when a run is slower than the limit', async () => {
  const s = scenario({
    settings: { liveBackground: 'on', liveMaxSeconds: 1 },
    answer: (call) => setTimeout(() => emitAll([otherResult], 0)(call), 1100),
  });
  try {
    edit(s, 'src/cart.ts');
    await until(() => s.checks.length === 1, 'the run');
    await until(() => statusLine(s).startsWith('$(debug-pause)'), 'live results to stop', 4000);
    assert.match(s.fake.output.join('\n'), /live results stopped: the last run took \d+s/);
    edit(s, 'src/cart.ts');
    await settle(400);
    assert.equal(s.checks.length, 1, 'no second run');
    await s.fake.commands.get('tslaws.pauseLive')();
    edit(s, 'src/cart.ts');
    await until(() => s.checks.length === 2, 'a run after resuming', 4000);
  } finally {
    s.finish();
  }
});

test('a newer edit cancels the background run that is going: one check at a time', async () => {
  const s = scenario({
    settings: { liveBackground: 'on' },
    answer: (call, n) => (n === 1 ? hang() : emitAll([otherResult], 0)(call)),
  });
  try {
    edit(s, 'src/cart.ts');
    await until(() => s.checks.length === 1, 'the first run');
    edit(s, 'src/cart.ts', `${CART}\n`);
    await until(() => s.checks.length === 2, 'the second run');
    assert.equal(s.checks[0].child.killed, true, 'the first was stopped before the second began');
  } finally {
    s.finish();
  }
});

test('live results are on by default for a project with tslaws.json, unless the person chose when to run', async () => {
  const withConfig = scenario({ before: (put) => put('tslaws.json', '{}'), answer: emitAll([otherResult], 0) });
  try {
    edit(withConfig, 'src/cart.ts');
    await until(() => withConfig.checks.length === 1, 'a background run with no setting at all');
  } finally {
    withConfig.finish();
  }
  const chosen = scenario({
    before: (put) => put('tslaws.json', '{}'),
    settings: { run: 'onSave' },
    answer: emitAll([otherResult], 0),
  });
  try {
    edit(chosen, 'src/cart.ts');
    await settle(400);
    assert.equal(chosen.checks.length, 0, 'tslaws.run was chosen, so typing runs nothing');
  } finally {
    chosen.finish();
  }
  const without = scenario({ answer: emitAll([otherResult], 0) });
  try {
    edit(without, 'src/cart.ts');
    await settle(400);
    assert.equal(without.checks.length, 0, 'no tslaws.json, so on save only');
  } finally {
    without.finish();
  }
});

function navigation(extra = {}) {
  return scenario({
    extraLawFiles: ['src/cart.proposed.laws.ts', 'src/cart.browser.laws.ts', 'src/cart.e2e.laws.ts'],
    before: (put) => {
      for (const variant of ['proposed', 'browser', 'e2e'])
        put(
          `src/cart.${variant}.laws.ts`,
          `import { total } from './cart';\nexport law ${variant}Law(a: number) { return total(a, 0) >= 0; }\n`,
        );
    },
    answer: emitAll([failedResult, otherResult]),
    ...extra,
  });
}
const lawLines = (locations) => locations.map((l) => `${path.basename(l.uri.fsPath)}:${l.range.start.line}`).sort();

test('go to implementation and find all references on a function list its laws, before any run (imports) and after one', async () => {
  const s = navigation();
  try {
    await settle(50);
    const doc = s.fake.makeDoc(s.abs('src/cart.ts'));
    const at = new s.fake.vscode.Position(1, 18);
    const [impl] = s.fake.providers.implementation;
    const [refs] = s.fake.providers.reference;
    const expected = [
      'cart.browser.laws.ts:1',
      'cart.e2e.laws.ts:1',
      'cart.laws.ts:2',
      'cart.laws.ts:5',
      'cart.proposed.laws.ts:1',
    ];
    assert.deepEqual(lawLines(impl.provideImplementation(doc, at)), expected);
    assert.deepEqual(lawLines(refs.provideReferences(doc, at, {})), expected);
    const lawDoc = s.fake.makeDoc(s.abs('src/cart.laws.ts'));
    assert.equal(impl.provideImplementation(lawDoc, new s.fake.vscode.Position(3, 10)).length, 5);
    assert.deepEqual(impl.provideImplementation(doc, new s.fake.vscode.Position(2, 4)), []);

    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'a run');
    assert.deepEqual(
      lawLines(impl.provideImplementation(doc, at)),
      expected,
      'the report adds nothing and loses nothing',
    );
  } finally {
    s.finish();
  }
});

test('definition on a law name is the function it exercises', async () => {
  const s = navigation();
  try {
    await settle(50);
    const [def] = s.fake.providers.definition;
    const lawDoc = s.fake.makeDoc(s.abs('src/cart.laws.ts'));
    const onName = def.provideDefinition(lawDoc, new s.fake.vscode.Position(2, 15));
    assert.equal(onName.length, 1);
    assert.equal(path.basename(onName[0].uri.fsPath), 'cart.ts');
    assert.equal(onName[0].range.start.line, 1);
    assert.deepEqual(def.provideDefinition(lawDoc, new s.fake.vscode.Position(3, 4)), [], 'left to TypeScript');
  } finally {
    s.finish();
  }
});

test('the outline and Ctrl+T list every law with its status, in every laws file variant', async () => {
  const s = navigation();
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'a run');
    const [symbols] = s.fake.providers.documentSymbol;
    const found = symbols.provideDocumentSymbols(s.fake.makeDoc(s.abs('src/cart.laws.ts')));
    assert.deepEqual(
      found.map((x) => [x.name, x.detail]),
      [
        ['totalNeverNegative', 'failed: price = 0, coupon = 1'],
        ['couponNeverRaisesTheTotal', 'proved'],
      ],
    );
    assert.equal(found[0].selectionRange.start.line, 2);
    assert.equal(found[0].range.end.line, 4);
    const [workspace] = s.fake.providers.workspaceSymbol;
    const names = (q) => workspace.provideWorkspaceSymbols(q).map((x) => x.name);
    assert.deepEqual(names('law:').sort(), [
      'law:browserLaw',
      'law:couponNeverRaisesTheTotal',
      'law:e2eLaw',
      'law:proposedLaw',
      'law:totalNeverNegative',
    ]);
    assert.deepEqual(names('law:neg'), ['law:totalNeverNegative']);
    assert.deepEqual(names('tnn'), ['law:totalNeverNegative'], 'fuzzy');
    assert.deepEqual(names('zzzz'), []);
    const [first] = workspace.provideWorkspaceSymbols('law:');
    assert.equal(first.containerName, 'failed: price = 0, coupon = 1 · src/cart.laws.ts');
    assert.equal(first.location.range.start.line, 2);
  } finally {
    s.finish();
  }
});

test('go to laws: several ask with status icons, none says so', async () => {
  const s = navigation();
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'a run');
    const go = s.fake.commands.get('tslaws.goToLaws');
    await go('src/cart.ts', 'total');
    const pick = s.fake.quickPicks.at(-1);
    assert.deepEqual(
      pick.list.map((i) => `${i.label} | ${i.description}`),
      [
        '$(error) totalNeverNegative | failed',
        '$(circle-outline) browserLaw | not run',
        '$(circle-outline) e2eLaw | not run',
        '$(circle-outline) proposedLaw | not run',
        '$(check) couponNeverRaisesTheTotal | proved',
      ],
    );
    assert.match(pick.list[0].detail, /counterexample price = 0, coupon = 1/);
    assert.equal(s.fake.opened.at(-1).document.uri.fsPath, s.abs('src/cart.laws.ts'));
    const before = s.fake.quickPicks.length;
    await go('src/cart.proposed.laws.ts', 'proposedLaw');
    assert.equal(s.fake.quickPicks.length, before);
    assert.match(s.fake.messages.info.at(-1), /no law exercises proposedLaw yet/);
  } finally {
    s.finish();
  }
});

test('go to the function a law exercises, peek the laws, and go to any law', async () => {
  const s = navigation();
  try {
    s.save('src/cart.ts');
    await until(() => s.diag('src/cart.ts') !== undefined, 'a run');
    await s.fake.commands.get('tslaws.goToFunction')('src/cart.laws.ts', 'totalNeverNegative');
    assert.equal(s.fake.opened.at(-1).document.uri.fsPath, s.abs('src/cart.ts'));
    assert.equal(s.fake.quickPicks.length, 0, 'one function: no question');

    const doc = s.fake.makeDoc(s.abs('src/cart.ts'));
    s.fake.state.activeTextEditor = { document: doc, selection: { active: new s.fake.vscode.Position(1, 18) } };
    await s.fake.commands.get('tslaws.peekLaws')();
    const [id, uri, position, locations, mode] = s.fake.executed.find(([c]) => c === 'editor.action.peekLocations');
    assert.equal(id, 'editor.action.peekLocations');
    assert.equal(uri.fsPath, s.abs('src/cart.ts'));
    assert.equal(position.line, 1);
    assert.equal(locations.length, 5);
    assert.equal(mode, 'peek');

    await s.fake.commands.get('tslaws.goToLaw')();
    const all = s.fake.quickPicks.at(-1);
    assert.equal(all.list.length, 5);
    assert.equal(all.list[0].label, '$(error) totalNeverNegative', 'failing laws first');
    assert.equal(all.options.matchOnDescription, true);
  } finally {
    s.finish();
  }
});

const entry = (file, kind, status = 'accepted') => ({ file, kind, status, notices: [] });

test('laws files come from tslaws list, whatever they are called, and each gets a badge for its level', async () => {
  const s = scenario({
    listing: [
      entry('src/cart.laws.ts', 'node'),
      entry('specs/page.ts', 'browser', 'unaccepted'),
      entry('src/shop.laws.ts', 'e2e'),
      entry('.tslaws/proposals/idea.ts', 'browser', 'proposed'),
    ],
    // The file search would find only the conventional name; the answer from the tool is what counts.
    found: ['src/cart.laws.ts'],
  });
  await settle(20);
  assert.equal(s.lists.length, 1);
  assert.deepEqual(s.lists[0].args.slice(-2), ['list', '--json']);
  assert.equal(s.fake.fileDecorators.length, 1);
  const decorate = (rel) => s.fake.fileDecorators[0].provideFileDecoration(s.fake.vscode.Uri.file(s.abs(rel)));
  assert.equal(decorate('src/cart.laws.ts').badge, 'N');
  assert.equal(decorate('specs/page.ts').badge, 'B');
  assert.match(decorate('specs/page.ts').tooltip, /browser laws.*not in tsc-laws\.lock/);
  assert.equal(decorate('src/shop.laws.ts').badge, 'E');
  assert.equal(decorate('.tslaws/proposals/idea.ts').badge, 'P');
  assert.match(decorate('.tslaws/proposals/idea.ts').tooltip, /^proposed browser laws/);
  assert.equal(decorate('src/cart.ts'), undefined);
  s.finish();
});

test('a laws file the tool names is run when it changes, and a proposal is never run as a law', async () => {
  const s = scenario({
    listing: [
      entry('src/cart.laws.ts', 'node'),
      entry('specs/page.ts', 'node'),
      entry('.tslaws/proposals/idea.ts', 'node', 'proposed'),
    ],
    answer: emitAll([provedResult('totalNeverNegative', 3)], 0),
  });
  await settle(20);
  s.put('specs/page.ts', 'export law pageOk(n: number) => n === n;\n');
  s.save('specs/page.ts');
  await until(() => s.checks.length >= 1, 'a check');
  assert.ok(s.checks[0].args.includes('specs/page.ts'), s.checks[0].args.join(' '));
  assert.ok(!s.checks[0].args.includes('src/cart.laws.ts'));
  s.put('.tslaws/proposals/idea.ts', 'export law idea(n: number) => n === n;\n');
  const before = s.checks.length;
  s.save('.tslaws/proposals/idea.ts');
  await settle(250);
  assert.equal(s.checks.length, before);
  s.finish();
});

test('saving a file that declares a law asks tslaws list again', async () => {
  const s = scenario({ answer: emitAll([provedResult('totalNeverNegative', 3)], 0) });
  await settle(20);
  assert.equal(s.lists.length, 1);
  s.put('specs/new.ts', 'export law fresh(n: number) => n === n;\n');
  s.save('specs/new.ts');
  await until(() => s.lists.length === 2, 'a second list');
  s.finish();
});

test('an older tslaws without list falls back to the file names, with the old suffix hints as badges', async () => {
  const s = scenario({
    listing: null,
    found: ['src/cart.laws.ts', 'src/ui.browser.laws.ts', 'src/shop.e2e.laws.ts'],
  });
  await settle(20);
  const decorate = (rel) => s.fake.fileDecorators[0].provideFileDecoration(s.fake.vscode.Uri.file(s.abs(rel)));
  assert.equal(decorate('src/cart.laws.ts').badge, 'N');
  assert.equal(decorate('src/ui.browser.laws.ts').badge, 'B');
  assert.equal(decorate('src/shop.e2e.laws.ts').badge, 'E');
  s.finish();
});

test('an untrusted workspace never runs tslaws list, and still finds the conventional names', async () => {
  const s = scenario({ trusted: false });
  await settle(20);
  assert.equal(s.lists.length, 0);
  const uri = s.fake.vscode.Uri.file(s.abs('src/cart.laws.ts'));
  assert.equal(s.fake.fileDecorators[0].provideFileDecoration(uri).badge, 'N');
  s.finish();
});
