import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { makeFake } from './fake-vscode.mjs';

// extension.js is the only file that requires `vscode`. Load it against the fake and check what activation registers.
test('activate registers the commands, providers, test controller and status bar; accept only types the command', () => {
  const fake = makeFake({ root: '/w' });
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? fake.vscode : origLoad.call(this, request, ...rest);
  };
  try {
    const ext = createRequire(import.meta.url)('../src/extension.js');
    const context = { subscriptions: [] };
    ext.activate(context);
    assert.deepEqual([...fake.commands.keys()].sort(), [
      'tslaws.accept',
      'tslaws.cancel',
      'tslaws.check',
      'tslaws.copyReproduce',
      'tslaws.openDashboard',
      'tslaws.openLaw',
      'tslaws.openSource',
      'tslaws.runFile',
      'tslaws.runLaw',
      'tslaws.showLaws',
    ]);
    assert.equal(fake.providers.lens.length, 1);
    assert.equal(fake.providers.hover.length, 1);
    assert.equal(fake.providers.actions.length, 1);
    assert.equal(fake.controllers.length, 1);
    assert.equal(fake.statuses[0].text, 'laws: not run');
    assert.equal(fake.statuses[0].command, 'tslaws.openDashboard');

    fake.commands.get('tslaws.accept')();
    assert.deepEqual(fake.terminals[0].sent, [['npx tslaws accept', false]]);

    // Before any run a laws file says so.
    const doc = fake.makeDoc('/w/a.laws.ts', 'export law a(x: number) { return true; }');
    const titles = fake.providers.lens[0].provideCodeLenses(doc).map((l) => l.command.title);
    assert.ok(titles.includes('$(circle-outline) not run'), titles.join(' | '));
    context.subscriptions.at(-1).dispose();
    ext.deactivate();
  } finally {
    Module._load = origLoad;
  }
});

test('every command and setting the manifest declares is real, and the old ones are still there', () => {
  const pkg = createRequire(import.meta.url)('../package.json');
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
