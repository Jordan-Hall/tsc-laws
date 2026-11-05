'use strict';

// Getting between a function and its laws, from either end: Go to Laws, Peek Laws, Go to the function a law exercises,
// Go to law (all laws), Go to Implementation and Find All References on a function (they list its laws), and the laws as
// document and workspace symbols. The laws a function has come from the last report, and from the laws files' imports
// where no run has covered them yet (`law-index.js`). `vscode` is passed in.

const path = require('node:path');
const { buildNavigation, functionIdsFor, isLawsFile, wordAt, key } = require('./law-index.js');
const { findLaws } = require('./find-laws.js');
const { statusIcon, inputsText, oneLine } = require('./format.js');
const { relativeTo } = require('./parse-report.js');

const SELECTOR = [{ scheme: 'file', pattern: '**/*.{ts,tsx,mts,cts}' }];
const ORDER = ['failed', 'open', 'tampered', 'error', 'not run', 'tested', 'bounded', 'proved'];
const rank = (status) => (ORDER.includes(status) ? ORDER.indexOf(status) : ORDER.length);

/** Letters of `query` appear in order in `text`, ignoring case. */
function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let at = 0;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/**
 * @param {typeof import('vscode')} vscode
 * @param {{
 *   root: () => string | undefined,
 *   records: () => object[] | null,
 *   lawFiles: () => string[],
 *   readText: (rel: string) => string | undefined,
 *   exists: (rel: string) => boolean,
 *   open: (file: string, range: {line: number, start: number, end: number} | null) => Promise<void>,
 *   paramsOf: (file: string, name: string) => string[],
 * }} host
 */
function createNavigation(vscode, host) {
  let cache = null;
  const index = () => {
    cache ??= buildNavigation({
      records: host.records(),
      lawFiles: host.lawFiles(),
      readText: host.readText,
      exists: host.exists,
    });
    return cache;
  };
  const invalidate = () => {
    cache = null;
  };
  const uri = (rel) => vscode.Uri.file(path.join(host.root(), rel));
  const rangeOf = (r) => new vscode.Range(r.line, r.start, r.line, r.end);
  const lawLocation = (law) =>
    new vscode.Location(uri(law.file), rangeOf({ line: law.line, start: law.start, end: law.end }));
  const functionLocation = (f) => new vscode.Location(uri(f.file), rangeOf(f.range));
  const relOf = (doc) => (host.root() === undefined ? undefined : relativeTo(doc.uri.fsPath, host.root()));
  const detailOf = (law) => {
    const r = law.record;
    if (r?.status !== 'failed') return law.file;
    const inputs = inputsText(r.counterexample, host.paramsOf(law.file, law.name));
    return `${law.file} · ${inputs !== undefined ? `counterexample ${inputs}` : oneLine(r.message ?? 'failed')}`;
  };
  const lawItem = (law) => ({
    label: `${statusIcon(law.status)} ${law.name}`,
    description: law.status,
    detail: detailOf(law),
    law,
  });
  const sorted = (laws) =>
    [...laws].sort((a, b) => rank(a.status) - rank(b.status) || a.file.localeCompare(b.file) || a.line - b.line);

  /** The laws that exercise the function named by arguments, or by the word at the cursor of the active editor. */
  const lawsFor = (file, name) => {
    const found = new Map();
    const add = (id) => {
      for (const law of index().byFunction.get(id) ?? []) found.set(key(law.file, law.name), law);
    };
    if (file !== undefined && name !== undefined) {
      add(key(file, name));
      return { name, laws: sorted(found.values()) };
    }
    const editor = vscode.window.activeTextEditor;
    const rel = editor === undefined ? undefined : relOf(editor.document);
    if (editor === undefined || rel === undefined) return { name: undefined, laws: [] };
    const at = editor.selection?.active ?? new vscode.Position(0, 0);
    const found2 = functionIdsFor({
      rel,
      text: editor.document.getText(),
      line: at.line,
      character: at.character,
      exists: host.exists,
    });
    for (const id of found2.ids) add(id);
    return { name: found2.word ?? undefined, laws: sorted(found.values()) };
  };

  const pickOne = async (items, title) =>
    items.length === 1
      ? items[0]
      : vscode.window.showQuickPick(items, { title, matchOnDescription: true, matchOnDetail: true });
  const openLawAt = (law) => host.open(law.file, { line: law.line, start: law.start, end: law.end });

  const goToLaws = async (file, name) => {
    const { name: fn, laws } = lawsFor(file, name);
    if (laws.length === 0) {
      void vscode.window.showInformationMessage(
        fn === undefined ? 'tslaws: put the cursor on a function.' : `tslaws: no law exercises ${fn} yet.`,
      );
      return undefined;
    }
    const picked = await pickOne(laws.map(lawItem), `Laws that exercise ${fn}`);
    if (picked !== undefined) await openLawAt(picked.law);
    return picked?.law;
  };

  const peekLaws = async (file, name) => {
    const { laws } = lawsFor(file, name);
    const editor = vscode.window.activeTextEditor;
    if (laws.length === 0 || editor === undefined) return goToLaws(file, name);
    await vscode.commands.executeCommand(
      'editor.action.peekLocations',
      editor.document.uri,
      editor.selection?.active ?? new vscode.Position(0, 0),
      laws.map(lawLocation),
      'peek',
    );
    return undefined;
  };

  /** The law the cursor is in: the last law that starts at or above its line. */
  const lawAtCursor = () => {
    const editor = vscode.window.activeTextEditor;
    const rel = editor === undefined ? undefined : relOf(editor.document);
    if (editor === undefined || rel === undefined || !isLawsFile(rel)) return undefined;
    const line = editor.selection?.active.line ?? 0;
    const here = findLaws(editor.document.getText()).filter((l) => l.line <= line);
    const law = here[here.length - 1];
    return law === undefined ? undefined : index().byLaw.get(key(rel, law.name));
  };

  const goToFunction = async (file, name) => {
    const law = file !== undefined && name !== undefined ? index().byLaw.get(key(file, name)) : lawAtCursor();
    if (law === undefined) {
      void vscode.window.showInformationMessage('tslaws: put the cursor inside a law.');
      return undefined;
    }
    if (law.functions.length === 0) {
      void vscode.window.showInformationMessage(
        `tslaws: ${law.name} does not call a function of this project that is known yet.`,
      );
      return undefined;
    }
    const items = law.functions.map((f) => ({ label: `$(symbol-function) ${f.name}`, description: f.file, fn: f }));
    const picked = await pickOne(items, `Code that ${law.name} exercises`);
    if (picked !== undefined) await host.open(picked.fn.file, picked.fn.range);
    return picked?.fn;
  };

  const goToLaw = async () => {
    const laws = sorted(index().laws);
    if (laws.length === 0) {
      void vscode.window.showInformationMessage('tslaws: this folder has no laws.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(laws.map(lawItem), {
      title: 'Go to law',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked !== undefined) await openLawAt(picked.law);
    return picked?.law;
  };

  // ---- providers ----
  const lawsAtPosition = (doc, position) => {
    const rel = relOf(doc);
    if (rel === undefined) return [];
    const found = functionIdsFor({
      rel,
      text: doc.getText(),
      line: position.line,
      character: position.character,
      exists: host.exists,
    });
    const out = new Map();
    for (const id of found.ids)
      for (const law of index().byFunction.get(id) ?? []) out.set(key(law.file, law.name), law);
    return sorted(out.values());
  };
  const implementationProvider = {
    provideImplementation: (doc, position) => lawsAtPosition(doc, position).map(lawLocation),
  };
  const referenceProvider = {
    provideReferences: (doc, position) => lawsAtPosition(doc, position).map(lawLocation),
  };
  const definitionProvider = {
    provideDefinition(doc, position) {
      const rel = relOf(doc);
      if (rel === undefined || !isLawsFile(rel)) return [];
      const at = wordAt(doc.getText().split(/\r?\n/)[position.line] ?? '', position.character);
      const law = at === null ? undefined : index().byLaw.get(key(rel, at.word));
      if (law === undefined || law.line !== position.line || at.start !== law.start) return [];
      return law.functions.map(functionLocation);
    },
  };
  const symbolDetail = (law) => {
    const r = law.record;
    if (r?.status !== 'failed') return law.status;
    const inputs = inputsText(r.counterexample, host.paramsOf(law.file, law.name));
    return inputs === undefined ? 'failed' : `failed: ${inputs}`;
  };
  const documentSymbolProvider = {
    provideDocumentSymbols(doc) {
      const rel = relOf(doc);
      if (rel === undefined) return [];
      const text = doc.getText();
      const laws = findLaws(text);
      const lines = text.split(/\r?\n/);
      return laws.map((law, i) => {
        let last = (laws[i + 1]?.line ?? lines.length) - 1;
        while (last > law.line && (lines[last] ?? '').trim() === '') last--;
        const known = index().byLaw.get(key(rel, law.name));
        return new vscode.DocumentSymbol(
          law.name,
          known === undefined ? 'not run' : symbolDetail(known),
          vscode.SymbolKind.Function,
          new vscode.Range(law.line, 0, last, (lines[last] ?? '').length),
          new vscode.Range(law.line, law.nameColumn, law.line, law.nameColumn + law.name.length),
        );
      });
    },
  };
  const workspaceSymbolProvider = {
    provideWorkspaceSymbols(query) {
      const q = String(query)
        .replace(/^\s*law\s*:\s*/i, '')
        .trim();
      return sorted(index().laws)
        .filter((law) => q === '' || fuzzy(q, law.name) || fuzzy(q, `${law.file} ${law.name}`))
        .map(
          (law) =>
            new vscode.SymbolInformation(
              `law:${law.name}`,
              vscode.SymbolKind.Function,
              `${symbolDetail(law)} · ${law.file}`,
              lawLocation(law),
            ),
        );
    },
  };

  const l = vscode.languages;
  return {
    invalidate,
    index,
    goToLaws,
    peekLaws,
    goToFunction,
    goToLaw,
    providers: {
      implementationProvider,
      referenceProvider,
      definitionProvider,
      documentSymbolProvider,
      workspaceSymbolProvider,
    },
    disposables: [
      l.registerImplementationProvider(SELECTOR, implementationProvider),
      l.registerReferenceProvider(SELECTOR, referenceProvider),
      l.registerDefinitionProvider(SELECTOR, definitionProvider),
      l.registerDocumentSymbolProvider(SELECTOR, documentSymbolProvider, { label: 'tslaws laws' }),
      l.registerWorkspaceSymbolProvider(workspaceSymbolProvider),
    ],
  };
}

module.exports = { createNavigation, fuzzy, SELECTOR };
