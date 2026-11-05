// A stand-in for the `vscode` API that is just big enough to run the whole extension: the editor-facing calls record what
// they are given, so tests can read the diagnostics, lenses, hovers, quick fixes, decorations, status bar and test results
// the extension produced. It proves the wiring and the data; it does not prove how VS Code draws them.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }
}
class Selection extends Range {}
class Uri {
  static file(p) {
    return Object.assign(new Uri(), { fsPath: path.resolve(p), scheme: 'file' });
  }
  static parse(s) {
    return Object.assign(new Uri(), { value: s, scheme: 'http', fsPath: s });
  }
}
class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}
class Diagnostic {
  constructor(range, message, severity) {
    Object.assign(this, { range, message, severity });
  }
}
class DiagnosticRelatedInformation {
  constructor(location, message) {
    Object.assign(this, { location, message });
  }
}
class CodeLens {
  constructor(range, command) {
    Object.assign(this, { range, command });
  }
}
class CodeAction {
  constructor(title, kind) {
    Object.assign(this, { title, kind });
  }
}
class MarkdownString {
  constructor() {
    this.value = '';
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
  appendCodeblock(s, lang = '') {
    this.value += `\n\`\`\`${lang}\n${s}\n\`\`\`\n`;
    return this;
  }
}
class Hover {
  constructor(contents, range) {
    Object.assign(this, { contents, range });
  }
}
class FileDecoration {
  constructor(badge, tooltip, color) {
    Object.assign(this, { badge, tooltip, color });
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class TreeItem {
  constructor(label, collapsibleState) {
    Object.assign(this, { label, collapsibleState });
  }
}
class ThemeIcon {
  constructor(id, color) {
    Object.assign(this, { id, color });
  }
}
class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    Object.assign(this, { name, detail, kind, range, selectionRange });
  }
}
class SymbolInformation {
  constructor(name, kind, containerName, location) {
    Object.assign(this, { name, kind, containerName, location });
  }
}
class TestMessage {
  constructor(message) {
    this.message = message;
  }
}
class VEventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => (this.listeners.push(fn), { dispose() {} });
  }
  fire(e) {
    this.listeners.forEach((l) => l(e));
  }
  dispose() {}
}

function event() {
  const listeners = [];
  return { listeners, on: (fn) => (listeners.push(fn), { dispose() {} }), fire: (e) => listeners.forEach((l) => l(e)) };
}

/** A test item collection with the parts of the real one the extension uses. */
function items() {
  const map = new Map();
  return {
    get size() {
      return map.size;
    },
    get: (id) => map.get(id),
    add: (item) => map.set(item.id, item),
    delete: (id) => map.delete(id),
    forEach: (fn) => [...map.values()].forEach(fn),
    [Symbol.iterator]: () => map.values(),
  };
}

export function makeFake({ root, settings = {}, trusted = true, lawFiles = [] } = {}) {
  const commands = new Map();
  const executed = [];
  const treeViews = [];
  const quickPicks = [];
  const collections = [];
  const providers = {
    lens: [],
    hover: [],
    actions: [],
    implementation: [],
    reference: [],
    definition: [],
    documentSymbol: [],
    workspaceSymbol: [],
  };
  const terminals = [];
  const statuses = [];
  const decorationTypes = [];
  const fileDecorators = [];
  const decorations = new Map();
  const messages = { warning: [], error: [], info: [] };
  const clipboard = [];
  const opened = [];
  const output = [];
  const docs = [];
  const watchers = { create: event(), delete: event() };
  const events = { change: event(), save: event(), config: event(), editors: event() };
  const controllers = [];
  const cfg = { ...settings };
  const state = { trusted, visibleTextEditors: [], activeTextEditor: undefined };

  const getConfiguration = () => ({
    get: (key, fallback) => (key in cfg ? cfg[key] : fallback),
    inspect: (key) => (key in cfg ? { globalValue: cfg[key] } : { defaultValue: undefined }),
  });

  const vscode = {
    Position,
    Range,
    Selection,
    Uri,
    Location,
    Diagnostic,
    DiagnosticRelatedInformation,
    CodeLens,
    CodeAction,
    MarkdownString,
    Hover,
    ThemeColor,
    FileDecoration,
    TestMessage,
    EventEmitter: VEventEmitter,
    DiagnosticSeverity: { Error: 0, Warning: 1, Hint: 3 },
    TreeItem,
    DocumentSymbol,
    SymbolInformation,
    SymbolKind: { Function: 11 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon,
    StatusBarAlignment: { Left: 1 },
    OverviewRulerLane: { Right: 4 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    CodeActionKind: { QuickFix: 'quickfix' },
    TestRunProfileKind: { Run: 1 },
    commands: {
      registerCommand: (id, fn) => (commands.set(id, fn), { dispose() {} }),
      executeCommand: async (id, ...args) => void executed.push([id, ...args]),
    },
    languages: {
      createDiagnosticCollection: () => {
        const store = new Map();
        const c = { store, clear: () => store.clear(), set: (uri, list) => store.set(uri.fsPath, list), dispose() {} };
        collections.push(c);
        return c;
      },
      registerCodeLensProvider: (sel, p) => (providers.lens.push(p), { dispose() {} }),
      registerHoverProvider: (sel, p) => (providers.hover.push(p), { dispose() {} }),
      registerCodeActionsProvider: (sel, p) => (providers.actions.push(p), { dispose() {} }),
      registerImplementationProvider: (sel, p) => (providers.implementation.push(p), { dispose() {} }),
      registerReferenceProvider: (sel, p) => (providers.reference.push(p), { dispose() {} }),
      registerDefinitionProvider: (sel, p) => (providers.definition.push(p), { dispose() {} }),
      registerDocumentSymbolProvider: (sel, p) => (providers.documentSymbol.push(p), { dispose() {} }),
      registerWorkspaceSymbolProvider: (p) => (providers.workspaceSymbol.push(p), { dispose() {} }),
    },
    window: {
      createTreeView: (id, options) => {
        const view = { id, options, description: undefined, dispose() {} };
        treeViews.push(view);
        return view;
      },
      createOutputChannel: () => ({ appendLine: (l) => output.push(l), append: (l) => output.push(l), dispose() {} }),
      createStatusBarItem: () => {
        const s = { show() {}, dispose() {} };
        statuses.push(s);
        return s;
      },
      createTerminal: (o) => {
        const t = { o, sent: [], show() {}, sendText: (text, nl) => t.sent.push([text, nl]) };
        terminals.push(t);
        return t;
      },
      createTextEditorDecorationType: (o) => {
        const t = { o };
        decorationTypes.push(t);
        return t;
      },
      registerFileDecorationProvider: (provider) => {
        fileDecorators.push(provider);
        return { dispose() {} };
      },
      showWarningMessage: async (m) => void messages.warning.push(m),
      showErrorMessage: async (m) => void messages.error.push(m),
      showInformationMessage: async (m) => void messages.info.push(m),
      showQuickPick: async (list, options) => {
        quickPicks.push({ list, options });
        return state.pick === undefined ? list[0] : state.pick(list);
      },
      showTextDocument: async (doc) => {
        const editor = { document: doc, selection: undefined, revealRange() {} };
        opened.push(editor);
        return editor;
      },
      onDidChangeVisibleTextEditors: events.editors.on,
      get visibleTextEditors() {
        return state.visibleTextEditors;
      },
      get activeTextEditor() {
        return state.activeTextEditor;
      },
    },
    workspace: {
      workspaceFolders: root === undefined ? undefined : [{ uri: Uri.file(root) }],
      get textDocuments() {
        return docs;
      },
      get isTrusted() {
        return state.trusted;
      },
      getConfiguration,
      findFiles: async () => lawFiles.map((f) => Uri.file(f)),
      createFileSystemWatcher: () => ({
        onDidCreate: watchers.create.on,
        onDidDelete: watchers.delete.on,
        onDidChange: () => ({ dispose() {} }),
        dispose() {},
      }),
      openTextDocument: async (uri) => makeDoc(uri.fsPath),
      onDidChangeTextDocument: events.change.on,
      onDidSaveTextDocument: events.save.on,
      onDidChangeConfiguration: events.config.on,
    },
    env: {
      clipboard: { writeText: async (t) => void clipboard.push(t) },
      openExternal: async () => true,
    },
    tests: {
      createTestController: (id, label) => {
        const controller = {
          id,
          label,
          items: items(),
          profiles: [],
          runs: [],
          createTestItem: (itemId, itemLabel, uri) => {
            const item = { id: itemId, label: itemLabel, uri, children: items(), parent: undefined, range: undefined };
            const add = item.children.add;
            item.children.add = (child) => ((child.parent = item), add(child));
            return item;
          },
          createRunProfile: (label, kind, handler, isDefault) => {
            const profile = { label, kind, handler, isDefault };
            controller.profiles.push(profile);
            return profile;
          },
          createTestRun: (request) => {
            const run = { request, log: [], ended: false };
            const note = (state) => (item, extra) => run.log.push({ state, id: item.id, extra });
            Object.assign(run, {
              enqueued: note('enqueued'),
              started: note('started'),
              passed: note('passed'),
              failed: note('failed'),
              errored: note('errored'),
              skipped: note('skipped'),
              appendOutput: (t) => run.log.push({ state: 'output', extra: t }),
              end: () => (run.ended = true),
            });
            controller.runs.push(run);
            return run;
          },
          dispose() {},
        };
        controllers.push(controller);
        return controller;
      },
    },
  };

  function makeDoc(fsPath, text, dirty = false) {
    const doc = {
      uri: Uri.file(fsPath),
      isDirty: dirty,
      text,
      getText: () => doc.text ?? readFileSync(fsPath, 'utf8'),
    };
    return doc;
  }

  return {
    vscode,
    commands,
    executed,
    treeViews,
    quickPicks,
    collections,
    providers,
    terminals,
    statuses,
    decorationTypes,
    fileDecorators,
    messages,
    clipboard,
    opened,
    output,
    docs,
    controllers,
    events,
    watchers,
    settings: cfg,
    state,
    makeDoc,
    /** Open a buffer, optionally with unsaved text. */
    open(fsPath, text, dirty = false) {
      const doc = makeDoc(fsPath, text, dirty);
      docs.push(doc);
      return doc;
    },
    /** Show an editor and record the decorations set on it. */
    show(doc) {
      const editor = {
        document: doc,
        setDecorations: (type, list) => decorations.set(`${doc.uri.fsPath}|${decorationTypes.indexOf(type)}`, list),
      };
      state.visibleTextEditors = [editor];
      return editor;
    },
    decorationsOn: (fsPath, typeIndex) => decorations.get(`${fsPath}|${typeIndex}`) ?? [],
  };
}

/** A `spawn` whose processes are driven by `script(call)`; `calls` lists what was started. */
export function makeSpawn(script) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
    };
    const call = { command, args, opts, child };
    calls.push(call);
    setImmediate(() => script(call));
    return child;
  };
  return { spawn, calls };
}

export const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn()` is truthy. */
export async function until(fn, what = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await settle(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}
