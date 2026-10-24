import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

// A tiny fake `vscode` so activate() runs without VS Code. This proves registration and wiring only.
function makeFake() {
  const commands = new Map();
  const terminals = [];
  const providers = [];
  const listeners = [];
  const fake = {
    commands: {
      registerCommand: (id, fn) => (commands.set(id, fn), { dispose() {} }),
    },
    languages: {
      createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }),
      registerCodeLensProvider: (sel, p) => (providers.push({ sel, p }), { dispose() {} }),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, append() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createTerminal: (o) => {
        const t = { o, sent: [], show() {}, sendText: (text, nl) => t.sent.push([text, nl]) };
        terminals.push(t);
        return t;
      },
      showWarningMessage: async () => {},
      showErrorMessage: async () => {},
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/w' } }],
      textDocuments: [],
      getConfiguration: () => ({ get: (_k, d) => d }),
      onDidSaveTextDocument: (fn) => (listeners.push(fn), { dispose() {} }),
    },
    env: { openExternal: async () => true },
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class {},
    EventEmitter: class {
      event = () => {};
      fire() {}
      dispose() {}
    },
    Uri: class Uri {
      static file(p) {
        return Object.assign(new Uri(), { fsPath: p, scheme: 'file' });
      }
      static parse(s) {
        return Object.assign(new Uri(), { value: s });
      }
    },
    Range: class {},
    CodeLens: class {
      constructor(range, command) {
        this.range = range;
        this.command = command;
      }
    },
    Diagnostic: class {},
    DiagnosticSeverity: { Error: 0, Warning: 1 },
  };
  return { fake, commands, terminals, providers };
}

test('activate registers the commands, lens providers and save hook; accept only types the command', () => {
  const { fake, commands, terminals, providers } = makeFake();
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? fake : origLoad.call(this, request, ...rest);
  };
  try {
    const ext = createRequire(import.meta.url)('../src/extension.js');
    const context = { subscriptions: [] };
    ext.activate(context);
    assert.deepEqual([...commands.keys()].sort(), [
      'tslaws.accept',
      'tslaws.check',
      'tslaws.openDashboard',
      'tslaws.runFile',
    ]);
    assert.equal(providers.length, 2);
    commands.get('tslaws.accept')();
    assert.deepEqual(terminals[0].sent, [['npx tslaws accept', false]]);

    const doc = { uri: { scheme: 'file', fsPath: '/w/a.laws.ts' }, getText: () => 'law a(x: number) { return true; }' };
    const lenses = providers[0].p.provideCodeLenses(doc);
    assert.match(lenses[0].command.title, /not run/);
    assert.equal(providers[1].p.provideCodeLenses(doc)[0].command.command, 'tslaws.runFile');
    context.subscriptions.at(-1).dispose();
  } finally {
    Module._load = origLoad;
  }
});
