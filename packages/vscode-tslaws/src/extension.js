'use strict';

// Thin VS Code glue. All logic lives in the pure modules; this is the only file that requires `vscode`.

const vscode = require('vscode');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findLaws } = require('./find-laws.js');
const { parseReport, recordsForFile, lensesFor, diagnosticsFor, parseUiUrl, relativeTo } = require('./parse-report.js');
const { summaryText, allPass } = require('./summary.js');
const { resolveCommand, acceptCommandText } = require('./command.js');

const LAWS_GLOB = '**/*.laws.ts';
const DEBOUNCE_MS = 750;

function isLawsFile(doc) {
  return doc.uri.scheme === 'file' && doc.uri.fsPath.endsWith('.laws.ts');
}

function activate(context) {
  const output = vscode.window.createOutputChannel('tslaws');
  const diagnostics = vscode.languages.createDiagnosticCollection('tslaws');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const lensChanged = new vscode.EventEmitter();
  /** @type {object[] | null} */
  let records = null;
  let running = 0;
  let dashboard = null;
  let timer = null;

  status.command = 'tslaws.openDashboard';
  const refreshStatus = () => {
    status.text = summaryText(records, { running: running > 0 });
    status.tooltip = 'tslaws: open the dashboard';
    status.backgroundColor =
      records !== null && !allPass(records) ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.show();
  };

  const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const config = () => vscode.workspace.getConfiguration('tslaws');
  const cmdFor = (sub) =>
    resolveCommand({ root: root(), executable: config().get('executable'), args: config().get('args') }, sub);

  const publishDiagnostics = () => {
    diagnostics.clear();
    if (records === null) return;
    const byFile = new Map();
    for (const r of records) byFile.set(r.file, true);
    for (const file of byFile.keys()) {
      const uri = vscode.Uri.file(path.join(root(), file));
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
      const laws = open !== undefined ? findLaws(open.getText()) : [];
      const list = diagnosticsFor(
        records.filter((r) => r.file === file),
        laws,
      ).map((d) => {
        const range = new vscode.Range(d.line, 0, d.line, 1000);
        const diag = new vscode.Diagnostic(
          range,
          d.message,
          d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        );
        diag.source = d.source;
        diag.code = d.code;
        return diag;
      });
      diagnostics.set(uri, list);
    }
  };

  /** Run `tslaws check --json` (optionally on files relative to the root) and merge the report. */
  const runCheck = (files = []) =>
    new Promise((resolve) => {
      const cwd = root();
      if (cwd === undefined) {
        void vscode.window.showWarningMessage('tslaws: open a folder first.');
        return resolve();
      }
      const { command, args, shell } = cmdFor(['check', '--json', ...files]);
      running++;
      refreshStatus();
      output.appendLine(`> ${command} ${args.join(' ')}`);
      let stdout = '';
      let stderr = '';
      const child = spawn(command, args, { cwd, shell });
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const finish = () => {
        running--;
        publishDiagnostics();
        lensChanged.fire();
        refreshStatus();
        resolve();
      };
      child.on('error', (e) => {
        output.appendLine(`tslaws failed to start: ${e.message}`);
        void vscode.window.showErrorMessage(`tslaws failed to start: ${e.message}`);
        finish();
      });
      child.on('close', () => {
        try {
          const report = parseReport(stdout);
          if (files.length === 0 || records === null) {
            records = report.records;
          } else {
            const ran = new Set(files.map((f) => relativeTo(f, cwd)));
            records = [...records.filter((r) => !ran.has(r.file)), ...report.records];
          }
          if (!report.compileOk && report.compileDiagnostics !== '') output.appendLine(report.compileDiagnostics);
        } catch (e) {
          output.appendLine(`could not read tslaws output: ${e.message}\n${stdout}\n${stderr}`);
          void vscode.window.showErrorMessage('tslaws: could not read the check report. See the tslaws output.');
        }
        finish();
      });
    });

  const lensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(doc) {
      if (!isLawsFile(doc) || root() === undefined) return [];
      const laws = findLaws(doc.getText());
      const mine = records === null ? [] : recordsForFile(records, doc.uri.fsPath, root());
      return lensesFor(laws, mine).map((l) => {
        const range = new vscode.Range(l.line, 0, l.line, 0);
        return new vscode.CodeLens(range, { title: l.title, command: l.command, arguments: [doc.uri] });
      });
    },
  };
  // A second lens per law with the Run action.
  const runLensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(doc) {
      if (!isLawsFile(doc)) return [];
      return findLaws(doc.getText()).map(
        (law) =>
          new vscode.CodeLens(new vscode.Range(law.line, 0, law.line, 0), {
            title: '$(play) Run',
            command: 'tslaws.runFile',
            arguments: [doc.uri],
          }),
      );
    },
  };

  const runFile = (uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (target === undefined || root() === undefined) return runCheck();
    return runCheck([relativeTo(target.fsPath, root())]);
  };

  const openDashboard = () => {
    const cwd = root();
    if (cwd === undefined) return;
    if (dashboard !== null && dashboard.url !== null) {
      return vscode.env.openExternal(vscode.Uri.parse(dashboard.url));
    }
    if (dashboard !== null) return;
    const { command, args, shell } = cmdFor(['ui', '--no-open', '--port', '0']);
    const child = spawn(command, args, { cwd, shell });
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

  context.subscriptions.push(
    output,
    diagnostics,
    status,
    lensChanged,
    vscode.languages.registerCodeLensProvider({ pattern: LAWS_GLOB }, lensProvider),
    vscode.languages.registerCodeLensProvider({ pattern: LAWS_GLOB }, runLensProvider),
    vscode.commands.registerCommand('tslaws.check', () => runCheck()),
    vscode.commands.registerCommand('tslaws.runFile', runFile),
    vscode.commands.registerCommand('tslaws.openDashboard', openDashboard),
    vscode.commands.registerCommand('tslaws.accept', accept),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!config().get('runOnSave', true) || doc.uri.scheme !== 'file' || !/\.tsx?$/.test(doc.uri.fsPath)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void runCheck(), DEBOUNCE_MS);
    }),
    {
      dispose() {
        if (timer !== null) clearTimeout(timer);
        if (dashboard !== null) dashboard.child.kill();
      },
    },
  );

  refreshStatus();
}

function deactivate() {}

module.exports = { activate, deactivate };
