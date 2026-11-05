'use strict';

// The extension's behaviour: when to run laws, what a run updates, and the commands. `vscode` and the process and file
// APIs are passed in (extension.js is the only file that requires `vscode`), so the whole of it runs under a fake host in
// tests. The pure modules decide; this file only wires them to the editor.

const nodePath = require('node:path');
const { parseUiUrl, relativeTo } = require('./parse-report.js');
const { summaryText, allPass } = require('./summary.js');
const { resolveCommand, acceptCommandText } = require('./command.js');
const { merge, functionIndex, coverageMap, blamedFunctions } = require('./model.js');
const { buildDiagnostics } = require('./diagnostics.js');
const { lawRange, declarationRange } = require('./ranges.js');
const { reproduceCommand } = require('./format.js');
const { planRun, isRunnable } = require('./plan.js');
const { createScheduler } = require('./scheduler.js');
const { startCheck, liveSupport, checkArguments } = require('./runner.js');
const { createShadow } = require('./shadow.js');
const { resolveRunMode, explicitValue, clampInt } = require('./settings.js');
const { createEditor } = require('./editor.js');
const { createTesting } = require('./testing.js');
const { ensurePlugin } = require('./plugin.js');
const { compileDiagnostics } = require('./compile-diagnostics.js');

const key = (file, name) => `${file}::${name}`;

/**
 * @param {typeof import('vscode')} vscode
 * @param {{subscriptions: {dispose(): unknown}[]}} context
 * @param {{spawn: typeof import('node:child_process').spawn, fs: typeof import('node:fs'), now?: () => number}} io
 */
function activateExtension(vscode, context, io) {
  const { spawn, fs } = io;
  const now = io.now ?? Date.now;
  const output = vscode.window.createOutputChannel('tslaws');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'tslaws.openDashboard';

  /** @type {object[] | null} */
  let records = null;
  /** What the compiler printed in the last run: its law rules (TS9101 to TS9106) are shown as diagnostics. */
  let compilerText = '';
  /** @type {Map<string, number>} */
  const ranAt = new Map();
  let progress = null;
  let view = { records: null, ranAt, descs: new Map(), index: new Map(), coverage: new Map() };
  let lawFiles = [];
  let dashboard = null;
  let active = null;
  let complained = false;
  let ready = Promise.resolve();
  let rebuildTimer = null;
  const supportCache = new Map();
  const shadows = new Map();

  const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const config = () => vscode.workspace.getConfiguration('tslaws');
  const runMode = () =>
    resolveRunMode({
      explicitRun: explicitValue(config().inspect?.('run')),
      runOnSave: config().get('runOnSave', true),
    });
  const delayMs = () => clampInt(config().get('debounceMs', 600), 100, 10000, 600);
  const userCommand = (sub) =>
    resolveCommand({ root: root(), executable: config().get('executable'), args: config().get('args') }, sub);
  const samePath = (a, b) => nodePath.normalize(a).toLowerCase() === nodePath.normalize(b).toLowerCase();

  /** The text of a project file as the editor has it: the open buffer, else the file on disk. */
  const readText = (rel) => {
    const base = root();
    if (base === undefined) return undefined;
    const full = nodePath.join(base, rel);
    const open = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, full));
    if (open !== undefined) return open.getText();
    try {
      return fs.readFileSync(full, 'utf8');
    } catch {
      return undefined;
    }
  };

  const knownLawFiles = () => [
    ...new Set([...lawFiles, ...(records ?? []).map((r) => r.file).filter((f) => f.endsWith('.laws.ts'))]),
  ];

  // ---- views ----
  const editor = createEditor(vscode, {
    root,
    view: () => view,
    readText,
    inlineEnabled: () => config().get('inlineCounterexample', true),
  });

  const updateStatus = () => {
    const running = progress !== null;
    const text = summaryText(
      records,
      running ? { running, done: progress.done, total: progress.total, fresh: progress.fresh } : {},
    );
    status.text = `${running ? '$(sync~spin) ' : ''}${text}`;
    status.tooltip = running ? 'tslaws: a check is running. Click for the dashboard.' : 'tslaws: open the dashboard';
    status.accessibilityInformation = { label: text, role: 'button' };
    status.backgroundColor =
      records !== null && !running && !allPass(records)
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    status.show();
  };

  const withCompiler = (descs, read) => {
    if (compilerText === '' || root() === undefined) return descs;
    for (const [file, list] of compileDiagnostics(compilerText, read, (f) => relativeTo(f, root())))
      descs.set(file, [...(descs.get(file) ?? []), ...list]);
    return descs;
  };

  /** Rebuild everything shown from the records and the text as it is now. */
  const rebuild = () => {
    const memo = new Map();
    const read = (rel) => (memo.has(rel) ? memo.get(rel) : (memo.set(rel, readText(rel)), memo.get(rel)));
    view = {
      records,
      ranAt,
      descs: withCompiler(records === null ? new Map() : buildDiagnostics(records, read), read),
      index: records === null ? new Map() : functionIndex(records),
      coverage: records === null ? new Map() : coverageMap(records),
    };
    editor.refresh();
    updateStatus();
  };
  const rebuildSoon = () => {
    if (rebuildTimer !== null) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      rebuild();
    }, 120);
  };

  // ---- running ----
  const warn = (message, always) => {
    output.appendLine(`tslaws: ${message}`);
    if (always || !complained) void vscode.window.showWarningMessage(`tslaws: ${message}`);
    if (!always) complained = true;
  };

  const probe = (cmd) => {
    const id = [cmd.command, ...cmd.args].join('\0');
    if (!supportCache.has(id)) {
      supportCache.set(
        id,
        new Promise((resolve) => {
          let text = '';
          const child = spawn(cmd.command, cmd.args, { cwd: root(), shell: false });
          child.stdout.on('data', (d) => (text += d));
          child.on('error', () => resolve(liveSupport('')));
          child.on('close', () => resolve(liveSupport(text)));
        }),
      );
    }
    return supportCache.get(id);
  };

  /** Unsaved TypeScript buffers, keyed by project-relative path. */
  const overlays = () => {
    const out = new Map();
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty || doc.uri.scheme !== 'file' || root() === undefined) continue;
      const rel = relativeTo(doc.uri.fsPath, root());
      if (rel !== doc.uri.fsPath.replaceAll('\\', '/') && isRunnable(rel)) out.set(rel, doc.getText());
    }
    return out;
  };

  /**
   * Run `tslaws check` for a request and fold its results into what the editor shows. Only one run goes at a time: a
   * newer one stops the one before it. `listener` sees every event (the Test Explorer uses it).
   */
  const launch = (request, listener = () => {}) => {
    let child = null;
    let cancelled = false;
    const handle = {
      cancel() {
        cancelled = true;
        child?.cancel();
      },
      done: null,
    };
    const before = active;
    active = handle;
    handle.done = (async () => {
      if (before !== null) {
        before.cancel();
        await before.done.catch(() => {});
      }
      const base = root();
      if (cancelled) return { cancelled: true };
      if (base === undefined) {
        if (!request.auto) warn('open a folder first.', true);
        return { error: 'no folder is open' };
      }
      if (!vscode.workspace.isTrusted) {
        if (!request.auto) warn('trust this workspace to run its checks.', true);
        return { error: 'the workspace is not trusted' };
      }
      const probing = userCommand(['check', '--help']);
      if ('error' in probing) {
        warn(probing.error, !request.auto);
        return { error: probing.error };
      }
      const support = await probe(probing);
      if (cancelled) return { cancelled: true };
      let cwd = base;
      const buffers = request.auto && runMode() === 'onType' ? overlays() : new Map();
      if (buffers.size > 0) {
        if (!shadows.has(base)) shadows.set(base, createShadow({ root: base, fs }));
        const shadow = shadows.get(base);
        const synced = shadow.sync(buffers);
        if (synced.ok) cwd = shadow.dir;
        else output.appendLine(`tslaws: running on the saved files, not the open buffers (${synced.reason})`);
      }
      const cmd = userCommand(checkArguments(request, support));
      if ('error' in cmd) {
        warn(cmd.error, !request.auto);
        return { error: cmd.error };
      }
      const snapshot = records;
      progress = { done: 0, total: 0, fresh: [] };
      updateStatus();
      output.appendLine(`> ${cmd.command} ${cmd.args.join(' ')}${cwd === base ? '' : '   (on the open buffers)'}`);
      const run = startCheck({
        spawn,
        command: cmd.command,
        args: cmd.args,
        cwd,
        streaming: support.streaming,
        onLog: (text) => output.appendLine(text),
        onEvent: (event) => {
          if (event.type === 'plan')
            progress.total = request.laws !== undefined ? request.laws.length : event.laws.length;
          else if (event.type === 'result') {
            progress.done++;
            progress.fresh.push(event.record);
            records = [
              ...(records ?? []).filter((r) => key(r.file, r.name) !== key(event.record.file, event.record.name)),
              event.record,
            ];
            ranAt.set(key(event.record.file, event.record.name), now());
            rebuildSoon();
          } else if (event.type === 'report' && event.report.compileDiagnostics !== '') {
            output.appendLine(event.report.compileDiagnostics);
          }
          listener(event);
        },
      });
      child = run;
      if (cancelled) run.cancel();
      const outcome = await run.done;
      progress = null;
      if (outcome.report !== null && !outcome.cancelled) {
        compilerText = outcome.report.compileDiagnostics;
        records = merge(snapshot ?? [], outcome.report.records, { files: request.files, laws: request.laws ?? null });
        for (const r of outcome.report.records) ranAt.set(key(r.file, r.name), ranAt.get(key(r.file, r.name)) ?? now());
      } else if (outcome.error !== undefined) {
        output.appendLine(`tslaws: ${outcome.error}`);
        if (!request.auto) void vscode.window.showErrorMessage(`tslaws: ${outcome.error.split('\n')[0]}`);
      }
      if (rebuildTimer !== null) clearTimeout(rebuildTimer);
      rebuildTimer = null;
      rebuild();
      return outcome;
    })();
    void handle.done.then(
      () => {
        if (active === handle) active = null;
      },
      (e) => {
        output.appendLine(`tslaws: ${e.message}`);
        progress = null;
        if (active === handle) active = null;
        rebuild();
      },
    );
    return handle;
  };

  const scheduler = createScheduler({
    delayMs,
    start: (request) => launch({ ...request, auto: true }),
  });

  /** A file changed: choose the laws that cover it and ask for a run. */
  const changed = (doc) => {
    if (doc.uri.scheme !== 'file' || root() === undefined) return;
    const rel = relativeTo(doc.uri.fsPath, root());
    if (rel === doc.uri.fsPath.replaceAll('\\', '/')) return; // outside the workspace
    // The first search for laws files may still be going when the first edit arrives.
    void ready.then(() => {
      const plan = planRun({ file: rel, lawFiles: knownLawFiles(), coverage: view.coverage });
      if (plan.files !== null && plan.files.length === 0) return;
      scheduler.request({ files: plan.files, reason: plan.reason, args: [] });
    });
  };

  const runNow = (request) => {
    scheduler.cancel();
    return launch(request).done;
  };

  // ---- Test Explorer ----
  const testing = createTesting(vscode, {
    root,
    lawFiles: async () => knownLawFiles(),
    readText,
    record: (file, name) => records?.find((r) => r.file === file && r.name === name),
    launch: (request, listener) => {
      scheduler.cancel();
      return launch(request, listener);
    },
  });

  // ---- commands ----
  const recordOf = (file, name) => records?.find((r) => r.file === file && r.name === name);
  const open = async (file, range) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(nodePath.join(root(), file)));
    const shown = await vscode.window.showTextDocument(doc);
    if (range !== null && range !== undefined) {
      const r = new vscode.Range(range.line, range.start, range.line, range.end);
      shown.selection = new vscode.Selection(r.start, r.end);
      shown.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  };
  const openLaw = (file, name) => open(file, lawRange(readText(file) ?? '', name));
  const openSource = (file, name) => {
    const record = recordOf(file, name);
    const target = record === undefined ? undefined : blamedFunctions(record)[0]?.exercise;
    if (target === undefined) return openLaw(file, name);
    const text = readText(target.declaration.file);
    return open(
      target.declaration.file,
      text === undefined ? null : declarationRange(text, target.declaration, target.name),
    );
  };
  const copyReproduce = async (file, name) => {
    const record = recordOf(file, name);
    if (record === undefined) return;
    const text = reproduceCommand(record);
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(`tslaws: copied \`${text}\``);
  };
  const showLaws = async (file, fn) => {
    const entry = view.index.get(key(file, fn));
    if (entry === undefined) return;
    const picked = await vscode.window.showQuickPick(
      entry.laws.map((l) => ({
        label: `${l.failing ? '$(error)' : '$(check)'} ${l.name}`,
        description: `${l.status} - ${l.file}`,
        law: l,
      })),
      { title: `Laws that reach ${fn}` },
    );
    if (picked !== undefined) await openLaw(picked.law.file, picked.law.name);
  };
  const runFile = (uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (target === undefined || root() === undefined) return runNow({ files: null });
    return runNow({ files: [relativeTo(target.fsPath, root())] });
  };

  const openDashboard = () => {
    const cwd = root();
    if (cwd === undefined) return;
    if (dashboard !== null && dashboard.url !== null) return vscode.env.openExternal(vscode.Uri.parse(dashboard.url));
    if (dashboard !== null) return;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('tslaws: trust this workspace to open the dashboard.');
      return;
    }
    const cmd = userCommand(['ui', '--no-open', '--port', '0']);
    if ('error' in cmd) {
      void vscode.window.showWarningMessage(`tslaws: ${cmd.error}`);
      return;
    }
    const child = spawn(cmd.command, cmd.args, { cwd, shell: false });
    dashboard = { child, url: null };
    const onData = (d) => {
      output.append(String(d));
      if (dashboard === null || dashboard.url !== null) return;
      const url = parseUiUrl(String(d));
      if (url !== null) {
        dashboard.url = url;
        void vscode.env.openExternal(vscode.Uri.parse(url));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      void vscode.window.showErrorMessage(`tslaws ui failed to start: ${e.message}`);
      dashboard = null;
    });
    child.on('close', () => (dashboard = null));
  };

  // Never runs accept: a person presses Enter in the terminal.
  const accept = () => {
    const terminal = vscode.window.createTerminal({ name: 'tslaws accept', cwd: root() });
    terminal.show();
    terminal.sendText(acceptCommandText(), false);
  };

  const refreshLawFiles = async () => {
    const found = await vscode.workspace.findFiles('**/*.laws.ts', '**/{node_modules,.tslaws}/**');
    lawFiles = found.map((u) => relativeTo(u.fsPath, root() ?? ''));
    await testing.discover();
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.laws.ts');

  context.subscriptions.push(
    output,
    status,
    ...editor.disposables,
    ...testing.disposables,
    watcher,
    watcher.onDidCreate(() => void refreshLawFiles()),
    watcher.onDidDelete(() => void refreshLawFiles()),
    vscode.commands.registerCommand('tslaws.check', () => runNow({ files: null })),
    vscode.commands.registerCommand('tslaws.runFile', runFile),
    vscode.commands.registerCommand('tslaws.runLaw', (file, name) => runNow({ files: [file], laws: [name] })),
    vscode.commands.registerCommand('tslaws.cancel', () => {
      scheduler.cancel();
      active?.cancel();
    }),
    vscode.commands.registerCommand('tslaws.showLaws', showLaws),
    vscode.commands.registerCommand('tslaws.openLaw', openLaw),
    vscode.commands.registerCommand('tslaws.openSource', openSource),
    vscode.commands.registerCommand('tslaws.copyReproduce', copyReproduce),
    vscode.commands.registerCommand('tslaws.openDashboard', openDashboard),
    vscode.commands.registerCommand('tslaws.accept', accept),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file' || !/\.[cm]?tsx?$/.test(e.document.uri.fsPath)) return;
      rebuildSoon(); // the marks follow the edit
      if (runMode() === 'onType' && e.contentChanges.length > 0) changed(e.document);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (runMode() !== 'manual' && /\.[cm]?tsx?$/.test(doc.uri.fsPath)) changed(doc);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => editor.decorate(e))),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tslaws')) rebuild();
    }),
    {
      dispose() {
        scheduler.cancel();
        active?.cancel();
        if (rebuildTimer !== null) clearTimeout(rebuildTimer);
        if (dashboard !== null) dashboard.child.kill();
      },
    },
  );

  // tsserver loads the law-syntax plugin from the extension's node_modules; put it there, and restart the server once so
  // it picks the plugin up.
  if (typeof context.extensionPath === 'string') {
    const plugin = ensurePlugin({ fs, path: nodePath, extensionPath: context.extensionPath });
    if (plugin.state === 'error') output.appendLine(`tslaws: could not install the TypeScript plugin: ${plugin.error}`);
    else if (plugin.changed) void vscode.commands.executeCommand('typescript.restartTsServer');
  }

  updateStatus();
  ready = refreshLawFiles();
  void ready.then(() => {
    if (config().get('runOnOpen', false) && runMode() !== 'manual' && lawFiles.length > 0)
      void runNow({ files: null, auto: true });
  });

  return { launch, scheduler, rebuild, state: () => ({ records, view, active }) };
}

module.exports = { activateExtension };
