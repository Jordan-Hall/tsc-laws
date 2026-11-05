'use strict';

// The editor surface: diagnostics, CodeLens, hover, quick fixes and decorations. `vscode` is passed in (only
// extension.js requires it), and everything shown is built by the pure modules from the view the host supplies.

const path = require('node:path');
const { findLaws } = require('./find-laws.js');
const { declarationRange } = require('./ranges.js');
const { lawLensTitle, fileLensTitle, sourceLensTitle } = require('./format.js');
const { relativeTo } = require('./parse-report.js');

const SELECTOR = [{ scheme: 'file', pattern: '**/*.{ts,tsx,mts,cts}' }];
const MEDIA = path.join(__dirname, '..', 'media');
const COMMANDS = ['tslaws.runLaw', 'tslaws.copyReproduce', 'tslaws.openLaw', 'tslaws.openSource', 'tslaws.writeLaw'];

const commandUri = (command, args) => `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
const isLawsFile = (rel) => rel.endsWith('.laws.ts');

/**
 * @param {typeof import('vscode')} vscode
 * @param {{
 *   root: () => string | undefined,
 *   view: () => {records: object[] | null, ranAt: Map<string, number>, descs: Map<string, object[]>, index: Map<string, object>},
 *   readText: (rel: string) => string | undefined,
 *   inlineEnabled: () => boolean,
 * }} host
 */
function createEditor(vscode, host) {
  const collection = vscode.languages.createDiagnosticCollection('tslaws');
  const lensChanged = new vscode.EventEmitter();
  const uriOf = (rel) => vscode.Uri.file(path.join(host.root(), rel));
  const relOf = (doc) => (host.root() === undefined ? undefined : relativeTo(doc.uri.fsPath, host.root()));
  const rangeOf = (r) => new vscode.Range(r.line, r.start, r.line, r.end);

  // ---- diagnostics ----
  const publish = () => {
    collection.clear();
    if (host.root() === undefined) return;
    for (const [file, descs] of host.view().descs) {
      collection.set(
        uriOf(file),
        descs.map((d) => {
          const diag = new vscode.Diagnostic(
            rangeOf(d.range),
            d.message,
            d.severity === 'error'
              ? vscode.DiagnosticSeverity.Error
              : d.severity === 'hint'
                ? vscode.DiagnosticSeverity.Hint
                : vscode.DiagnosticSeverity.Warning,
          );
          diag.source = d.source;
          diag.code = d.code;
          diag.relatedInformation = d.related.map(
            (r) =>
              new vscode.DiagnosticRelatedInformation(new vscode.Location(uriOf(r.file), rangeOf(r.range)), r.message),
          );
          return diag;
        }),
      );
    }
  };

  // ---- CodeLens ----
  const lens = (range, title, command, args = []) => new vscode.CodeLens(range, { title, command, arguments: args });
  const lensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(doc) {
      const rel = relOf(doc);
      if (rel === undefined) return [];
      const { records, ranAt, index } = host.view();
      const out = [];
      if (isLawsFile(rel)) {
        const text = doc.getText();
        const mine = (records ?? []).filter((r) => r.file === rel);
        const first = new vscode.Range(0, 0, 0, 0);
        out.push(lens(first, fileLensTitle(mine), 'tslaws.runFile', [doc.uri]));
        out.push(lens(first, '$(play) Run laws in this file', 'tslaws.runFile', [doc.uri]));
        for (const law of findLaws(text)) {
          const record =
            mine.find((r) => r.name === law.name && r.line - 1 === law.line) ?? mine.find((r) => r.name === law.name);
          const at = new vscode.Range(law.line, 0, law.line, 0);
          out.push(lens(at, lawLensTitle(record, ranAt.get(`${rel}::${law.name}`)), 'tslaws.runLaw', [rel, law.name]));
          if (record?.status === 'failed' && record.counterexample !== undefined) {
            const where = (record.exercises ?? []).find((e) => e.failing) ?? (record.exercises ?? [])[0];
            out.push(
              where === undefined
                ? lens(at, '$(clippy) Copy reproduce command', 'tslaws.copyReproduce', [rel, law.name])
                : lens(at, `$(go-to-file) Fails in ${where.name}`, 'tslaws.openSource', [rel, law.name]),
            );
          }
        }
        return out;
      }
      const text = doc.getText();
      for (const entry of index.values()) {
        if (entry.file !== rel) continue;
        const range = declarationRange(text, entry.declaration, entry.name);
        if (range === null) continue;
        out.push(
          lens(rangeOf({ ...range, start: 0, end: 0 }), sourceLensTitle(entry.laws), 'tslaws.goToLaws', [
            rel,
            entry.name,
          ]),
        );
      }
      return out;
    },
  };

  // ---- hover ----
  const within = (r, pos) => pos.line === r.line && pos.character >= r.start && pos.character <= r.end;
  const hoverProvider = {
    provideHover(doc, position) {
      const rel = relOf(doc);
      if (rel === undefined) return undefined;
      const here = (host.view().descs.get(rel) ?? []).filter((d) => within(d.range, position));
      if (here.length === 0) return undefined;
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: COMMANDS };
      md.supportThemeIcons = true;
      here.forEach((d, i) => {
        if (i > 0) md.appendMarkdown('\n\n---\n\n');
        md.appendMarkdown(`**tslaws** \`${d.code}\`\n\n`);
        md.appendCodeblock(d.message, 'text');
        const links = [];
        if (d.lawFile !== undefined) {
          const args = [d.lawFile, d.lawName];
          links.push(`[Re-run this law](${commandUri('tslaws.runLaw', args)})`);
          if (d.reproduce !== undefined)
            links.push(`[Copy the reproduce command](${commandUri('tslaws.copyReproduce', args)})`);
          links.push(
            d.role === 'source'
              ? `[Open the failing law](${commandUri('tslaws.openLaw', args)})`
              : `[Open the code it exercises](${commandUri('tslaws.openSource', args)})`,
          );
        }
        if (links.length > 0) md.appendMarkdown(`\n\n${links.join(' | ')}`);
      });
      return new vscode.Hover(md, rangeOf(here[0].range));
    },
  };

  // ---- quick fixes ----
  const actionProvider = {
    provideCodeActions(doc, range, context) {
      const rel = relOf(doc);
      if (rel === undefined) return [];
      const descs = host.view().descs.get(rel) ?? [];
      const out = [];
      for (const diag of context.diagnostics) {
        if (diag.source !== 'tslaws') continue;
        const d = descs.find((x) => x.code === diag.code && x.range.line === diag.range.start.line);
        if (d !== undefined && d.role === 'source' && d.lawFile === undefined) {
          const action = new vscode.CodeAction('tslaws: Write a law for this function', vscode.CodeActionKind.QuickFix);
          action.command = { title: 'Write a law', command: 'tslaws.writeLaw', arguments: [rel, d.lawName] };
          action.diagnostics = [diag];
          out.push(action);
          continue;
        }
        if (d === undefined || d.lawFile === undefined) continue;
        const args = [d.lawFile, d.lawName];
        const add = (title, command) => {
          const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          action.command = { title, command, arguments: args };
          action.diagnostics = [diag];
          out.push(action);
        };
        add('tslaws: Re-run this law', 'tslaws.runLaw');
        if (d.role === 'source') add('tslaws: Open the failing law', 'tslaws.openLaw');
        else add('tslaws: Go to the code it exercises', 'tslaws.openSource');
        if (d.reproduce !== undefined) add('tslaws: Copy the reproduce command', 'tslaws.copyReproduce');
      }
      return out;
    },
  };

  // ---- decorations: the counterexample after the failing line, and a gutter mark ----
  const decoration = (kind) =>
    vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 1.5em',
        fontStyle: 'italic',
        color: new vscode.ThemeColor(kind === 'error' ? 'editorError.foreground' : 'editorWarning.foreground'),
      },
      light: {
        gutterIconPath: vscode.Uri.file(path.join(MEDIA, kind === 'error' ? 'failed-light.svg' : 'warning-light.svg')),
      },
      dark: {
        gutterIconPath: vscode.Uri.file(path.join(MEDIA, kind === 'error' ? 'failed-dark.svg' : 'warning-dark.svg')),
      },
      gutterIconSize: 'contain',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      overviewRulerColor: new vscode.ThemeColor(
        kind === 'error' ? 'editorOverviewRuler.errorForeground' : 'editorOverviewRuler.warningForeground',
      ),
    });
  const callType = vscode.window.createTextEditorDecorationType({
    borderStyle: 'none none dashed none',
    borderWidth: '0 0 1px 0',
    borderColor: new vscode.ThemeColor('editorError.foreground'),
  });
  const errorType = decoration('error');
  const warningType = decoration('warning');

  const decorate = (editor) => {
    const rel = relOf(editor.document);
    const none = [];
    if (rel === undefined || !host.inlineEnabled()) {
      editor.setDecorations(errorType, none);
      editor.setDecorations(warningType, none);
      editor.setDecorations(callType, none);
      return;
    }
    const descs = host.view().descs.get(rel) ?? [];
    const options = (list) =>
      list.map((d) => ({
        range: new vscode.Range(d.range.line, Number.MAX_SAFE_INTEGER, d.range.line, Number.MAX_SAFE_INTEGER),
        hoverMessage: d.message,
        renderOptions: { after: { contentText: d.inline } },
      }));
    // One mark per line: a line that has several failing laws shows the first.
    const firstPerLine = (list) => [...new Map(list.map((d) => [d.range.line, d])).values()];
    editor.setDecorations(
      errorType,
      options(
        firstPerLine(descs.filter((d) => d.severity === 'error' && d.inline !== undefined && d.role !== 'source')),
      ),
    );
    editor.setDecorations(
      warningType,
      options(
        firstPerLine(descs.filter((d) => d.severity === 'warning' && d.inline !== undefined && d.role !== 'source')),
      ),
    );
    editor.setDecorations(
      callType,
      descs.flatMap((d) => (d.calls ?? []).map((c) => ({ range: rangeOf(c) }))),
    );
  };

  const refresh = () => {
    publish();
    lensChanged.fire();
    for (const editor of vscode.window.visibleTextEditors) decorate(editor);
  };

  return {
    refresh,
    decorate,
    disposables: [
      collection,
      lensChanged,
      errorType,
      warningType,
      callType,
      vscode.languages.registerCodeLensProvider(SELECTOR, lensProvider),
      vscode.languages.registerHoverProvider(SELECTOR, hoverProvider),
      vscode.languages.registerCodeActionsProvider(SELECTOR, actionProvider, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    ],
  };
}

module.exports = { createEditor, SELECTOR, commandUri };
