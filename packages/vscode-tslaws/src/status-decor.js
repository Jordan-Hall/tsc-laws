'use strict';

// The always-visible status after each function the laws reach (and each exported function none reaches): `proved`,
// `tested 24 runs`, `failing: counterexample (price=0, coupon=1)`, `running…`, `stale · ran 3m ago`, `uncovered`. It is a
// text decoration in a theme colour with a gutter icon, so it shows without hovering. `vscode` is passed in.

const path = require('node:path');
const { declarationRange } = require('./ranges.js');
const { relativeTo } = require('./parse-report.js');
const { functionStatus, uncoveredStatus } = require('./live-status.js');

const MEDIA = path.join(__dirname, '..', 'media');

const TONES = {
  ok: { colour: 'testing.iconPassed', icon: 'passed', ruler: 'editorOverviewRuler.infoForeground' },
  error: { colour: 'editorError.foreground', icon: 'failed', ruler: 'editorOverviewRuler.errorForeground' },
  warn: { colour: 'editorWarning.foreground', icon: 'warning', ruler: 'editorOverviewRuler.warningForeground' },
  muted: { colour: 'editorCodeLens.foreground', icon: undefined, ruler: undefined },
};

/**
 * The statuses of the functions declared in one file, as they are now.
 * @param {{
 *   rel: string, text: string,
 *   view: {records: object[] | null, index: Map<string, object>},
 *   context: object,
 * }} o `context` is what `functionStatus` needs, less the function's own file
 * @returns {{range: {line: number, start: number, end: number}, name: string, file: string, status: object}[]}
 */
function statusesIn({ rel, text, view, context }) {
  const out = [];
  for (const entry of view.index.values()) {
    if (entry.file !== rel) continue;
    const range = declarationRange(text, entry.declaration, entry.name);
    if (range === null) continue;
    out.push({ range, name: entry.name, file: rel, status: functionStatus(entry, { ...context, functionFile: rel }) });
  }
  for (const r of view.records ?? []) {
    if (r.status !== 'uncovered' || r.file !== rel) continue;
    const range = declarationRange(text, { line: r.line, column: 0 }, r.name);
    if (range !== null) out.push({ range, name: r.name, file: rel, status: uncoveredStatus() });
  }
  return out;
}

/**
 * @param {typeof import('vscode')} vscode
 * @param {{
 *   root: () => string | undefined,
 *   view: () => {records: object[] | null, index: Map<string, object>},
 *   readText: (rel: string) => string | undefined,
 *   statusContext: () => object,
 *   inlineEnabled: () => boolean,
 *   commandUri: (command: string, args: unknown[]) => string,
 * }} host
 */
function createStatusDecorations(vscode, host) {
  const types = {};
  for (const [tone, t] of Object.entries(TONES)) {
    const options = {
      after: { margin: '0 0 0 1.5em', fontStyle: 'italic', color: new vscode.ThemeColor(t.colour) },
    };
    if (t.icon !== undefined) {
      options.light = { gutterIconPath: vscode.Uri.file(path.join(MEDIA, `${t.icon}-light.svg`)) };
      options.dark = { gutterIconPath: vscode.Uri.file(path.join(MEDIA, `${t.icon}-dark.svg`)) };
      options.gutterIconSize = 'contain';
      options.overviewRulerLane = vscode.OverviewRulerLane.Right;
      options.overviewRulerColor = new vscode.ThemeColor(t.ruler);
    }
    types[tone] = vscode.window.createTextEditorDecorationType(options);
  }

  const hover = (rel, s) => {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['tslaws.writeLaw', 'tslaws.goToLaws', 'tslaws.peekLaws'] };
    md.appendMarkdown(`**tslaws** ${s.status.text}`);
    if (s.status.kind === 'uncovered') {
      md.appendMarkdown(`\n\n[Write a law for this function](${host.commandUri('tslaws.writeLaw', [rel, s.name])})`);
    } else {
      md.appendMarkdown(`\n\n[Go to laws](${host.commandUri('tslaws.goToLaws', [rel, s.name])})`);
      md.appendMarkdown(` | [Peek laws](${host.commandUri('tslaws.peekLaws', [rel, s.name])})`);
    }
    return md;
  };

  /** The statuses shown for a document, as decoration options per tone (for tests and for `decorate`). */
  const optionsFor = (rel, text) => {
    const view = host.view();
    const byTone = { ok: [], error: [], warn: [], muted: [] };
    for (const s of statusesIn({ rel, text, view, context: host.statusContext() })) {
      byTone[s.status.tone].push({
        range: new vscode.Range(s.range.line, Number.MAX_SAFE_INTEGER, s.range.line, Number.MAX_SAFE_INTEGER),
        hoverMessage: hover(rel, s),
        renderOptions: { after: { contentText: `  ${s.status.text}` } },
      });
    }
    return byTone;
  };

  const decorate = (editor) => {
    const root = host.root();
    const rel = root === undefined ? undefined : relativeTo(editor.document.uri.fsPath, root);
    const isProject = rel !== undefined && rel !== editor.document.uri.fsPath.replaceAll('\\', '/');
    const byTone =
      isProject && host.inlineEnabled()
        ? optionsFor(rel, editor.document.getText())
        : { ok: [], error: [], warn: [], muted: [] };
    for (const [tone, type] of Object.entries(types)) editor.setDecorations(type, byTone[tone]);
  };

  return {
    decorate,
    optionsFor,
    types,
    disposables: Object.values(types),
  };
}

module.exports = { createStatusDecorations, statusesIn, TONES };
