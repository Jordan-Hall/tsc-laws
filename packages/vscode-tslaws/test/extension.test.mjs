import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { makeFake } from './fake-vscode.mjs';

// extension.js is the only file that imports `vscode`. Load it against the fake, by answering that one specifier with a
// module whose exports are the fake's, and check what activation registers.
test('activate registers the commands, providers, test controller and status bar; accept only types the command', async () => {
  const fake = makeFake({ root: '/w' });
  globalThis.__tslawsFakeVscode = fake.vscode;
  const stub = 'vscode-stub:vscode';
  const hooks = registerHooks({
    resolve: (specifier, context, next) =>
      specifier === 'vscode' ? { url: stub, shortCircuit: true } : next(specifier, context),
    load: (url, context, next) => {
      if (url !== stub) return next(url, context);
      const exports = Object.keys(fake.vscode).map((name) => `export const ${name} = api.${name};`);
      const source = ['const api = globalThis.__tslawsFakeVscode;', ...exports, ''].join('\n');
      return { format: 'module', source, shortCircuit: true };
    },
  });
  try {
    const ext = await import('../src/extension.js');
    const context = { subscriptions: [] };
    ext.activate(context);
    assert.deepEqual([...fake.commands.keys()].sort(), [
      'tslaws.accept',
      'tslaws.cancel',
      'tslaws.check',
      'tslaws.checkAll',
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
      'tslaws.showProject',
      'tslaws.writeLaw',
    ]);
    assert.equal(fake.providers.lens.length, 1);
    assert.equal(fake.providers.hover.length, 1);
    assert.equal(fake.providers.actions.length, 1);
    assert.equal(fake.controllers.length, 1);
    assert.equal(fake.statuses[0].text, 'laws: not run');
    assert.equal(fake.statuses[0].command, 'tslawsLaws.focus');

    fake.commands.get('tslaws.accept')();
    assert.deepEqual(fake.terminals[0].sent, [['npx tslaws accept', false]]);

    // Before any run a laws file says so.
    const doc = fake.makeDoc('/w/a.laws.ts', 'export law a(x: number) { return true; }');
    const titles = fake.providers.lens[0].provideCodeLenses(doc).map((l) => l.command.title);
    assert.ok(titles.includes('$(circle-outline) not run'), titles.join(' | '));
    context.subscriptions.at(-1).dispose();
    ext.deactivate();
  } finally {
    hooks.deregister();
    delete globalThis.__tslawsFakeVscode;
  }
});

test('every command and setting the manifest declares is real, and the old ones are still there', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  for (const old of ['tslaws.check', 'tslaws.runFile', 'tslaws.openDashboard', 'tslaws.accept'])
    assert.ok(declared.includes(old), old);
  const props = pkg.contributes.configuration.properties;
  for (const old of ['tslaws.runOnSave', 'tslaws.executable', 'tslaws.args']) assert.ok(props[old], old);
  assert.equal(props['tslaws.run'].default, 'onSave');
  assert.deepEqual(props['tslaws.run'].enum, ['onSave', 'onType', 'manual']);
  assert.ok(props['tslaws.runOnSave'].deprecationMessage);
  // Commands that take arguments are not offered in the palette.
  const hidden = pkg.contributes.menus.commandPalette.map((m) => m.command);
  for (const c of ['tslaws.runLaw', 'tslaws.showLaws', 'tslaws.openLaw', 'tslaws.openSource', 'tslaws.copyReproduce'])
    assert.ok(hidden.includes(c), c);
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
});
