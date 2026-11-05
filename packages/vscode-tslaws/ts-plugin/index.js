'use strict';

// A tsserver plugin that lets VS Code's TypeScript understand `law` declarations. tsserver is shown a rewrite of each
// file that declares a law (`transform.js`) and every request and answer is converted between the original text and the
// rewrite with a position map, so the editor only ever sees offsets of the text on screen. Files with no law
// declaration get the very snapshot tsserver had, and every method of the language service that this plugin does not
// map is passed straight through.

const { rewrite } = require('./transform.js');

const SCRIPT_FILE = /\.(?:ts|mts|cts)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** @param {{typescript: typeof import('typescript')}} modules */
function init(modules) {
  const ts = modules.typescript;

  function create(info) {
    const host = info.languageServiceHost;
    const service = info.languageService;
    const originalSnapshot = host.getScriptSnapshot.bind(host);
    /** @type {Map<string, {version: string, original: string, rewritten: ReturnType<typeof rewrite>, snapshot: object | null}>} */
    const entries = new Map();

    const candidate = (fileName) =>
      SCRIPT_FILE.test(fileName) && !DECLARATION_FILE.test(fileName) && !/[\\/]node_modules[\\/]/.test(fileName);

    /** The rewrite of `fileName` as of its current version, or null when it declares no law. */
    function entryFor(fileName, snapshot) {
      const version = host.getScriptVersion?.(fileName) ?? '';
      const known = entries.get(fileName);
      if (known !== undefined && known.version === version && version !== '') return known;
      const source = snapshot ?? originalSnapshot(fileName);
      if (source === undefined) return null;
      const original = source.getText(0, source.getLength());
      if (known !== undefined && known.original === original) {
        known.version = version;
        return known;
      }
      const rewritten = rewrite(original);
      const entry = {
        version,
        original,
        rewritten,
        snapshot: rewritten === null ? null : ts.ScriptSnapshot.fromString(rewritten.text),
      };
      entries.set(fileName, entry);
      return entry;
    }

    host.getScriptSnapshot = (fileName) => {
      const snapshot = originalSnapshot(fileName);
      if (snapshot === undefined || !candidate(fileName)) return snapshot;
      const entry = entryFor(fileName, snapshot);
      return entry !== null && entry.snapshot !== null ? entry.snapshot : snapshot;
    };

    /** The position map of a file, or null when the file is shown to tsserver as it is. */
    function mapOf(fileName) {
      if (!candidate(fileName)) return null;
      const entry = entryFor(fileName);
      return entry === null || entry.rewritten === null ? null : entry.rewritten.map;
    }
    const originalText = (fileName) => entries.get(fileName)?.original ?? '';

    // Offsets in, offsets out.
    const pos = (fileName, p) => {
      const map = mapOf(fileName);
      return map === null ? p : map.toNew(p, 'start');
    };
    const posBack = (fileName, p, bias = 'start') => {
      const map = mapOf(fileName);
      return map === null ? p : map.toOriginal(p, bias);
    };
    const spanIn = (fileName, span) => {
      const map = mapOf(fileName);
      return map === null || span === undefined ? span : map.spanToNew(span);
    };
    const spanBack = (fileName, span) => {
      const map = mapOf(fileName);
      return map === null || span === undefined ? span : map.spanToOriginal(span);
    };
    /** A range given as `{pos, end}` (a TextRange) or as a position. */
    const rangeIn = (fileName, range) => {
      if (typeof range === 'number') return pos(fileName, range);
      const map = mapOf(fileName);
      return map === null ? range : { pos: map.toNew(range.pos, 'start'), end: map.toNew(range.end, 'end') };
    };

    /** A document span (definition, reference, highlight, rename location ...) in the original text. */
    function documentSpan(item, fileKey = 'fileName') {
      if (item === undefined || item === null) return item;
      const file = item[fileKey];
      if (mapOf(file) === null) return item;
      const copy = { ...item };
      if (item.textSpan !== undefined) copy.textSpan = spanBack(file, item.textSpan);
      if (item.contextSpan !== undefined) copy.contextSpan = spanBack(file, item.contextSpan);
      if (item.originalTextSpan !== undefined) copy.originalTextSpan = spanBack(file, item.originalTextSpan);
      if (item.originalContextSpan !== undefined) copy.originalContextSpan = spanBack(file, item.originalContextSpan);
      return copy;
    }
    const documentSpans = (items) => (items === undefined ? items : items.map((i) => documentSpan(i)));

    /** The file a diagnostic names, shown with the original text so line and offset come out right. */
    function originalFile(sourceFile) {
      const map = mapOf(sourceFile.fileName);
      if (map === null) return sourceFile;
      const text = originalText(sourceFile.fileName);
      const shown = Object.create(sourceFile);
      Object.defineProperties(shown, {
        text: { value: text, writable: true },
        end: { value: text.length, writable: true },
        lineMap: { value: undefined, writable: true },
      });
      return shown;
    }
    /** Is this range of the rewrite wholly inside text that the rewrite wrote? */
    function insideRewrittenText(map, start, length) {
      const end = start + length;
      return map.spans.some((s) => s.newEnd > s.newStart && start >= s.newStart && end <= s.newEnd);
    }
    function diagnostics(fileName, list) {
      const map = mapOf(fileName);
      if (map === null) return list;
      const out = [];
      for (const d of list) {
        const own = d.file === undefined || d.file.fileName === fileName;
        if (own && d.start !== undefined && insideRewrittenText(map, d.start, d.length ?? 0)) continue;
        out.push(diagnostic(d));
      }
      return out;
    }
    function diagnostic(d) {
      if (d.file === undefined || mapOf(d.file.fileName) === null) return d;
      const span = spanBack(d.file.fileName, { start: d.start ?? 0, length: d.length ?? 0 });
      const copy = { ...d, start: span.start, length: span.length, file: originalFile(d.file) };
      if (d.relatedInformation !== undefined) copy.relatedInformation = d.relatedInformation.map(diagnostic);
      return copy;
    }

    function textChanges(changes) {
      if (changes === undefined) return changes;
      return changes.map((change) => {
        if (mapOf(change.fileName) === null) return change;
        return {
          ...change,
          textChanges: change.textChanges
            .map((c) => ({ ...c, span: spanBack(change.fileName, c.span) }))
            .filter((c, i) => !touchesRewrite(change.fileName, change.textChanges[i].span)),
        };
      });
    }
    /** Does this edit of the rewrite cut into text the rewrite wrote? It cannot be said in terms of the original. */
    function touchesRewrite(fileName, span) {
      const map = mapOf(fileName);
      if (map === null) return false;
      const end = span.start + span.length;
      return map.spans.some((s) =>
        span.length === 0
          ? span.start > s.newStart && span.start < s.newEnd
          : span.start < s.newEnd && end > s.newStart && s.newEnd > s.newStart,
      );
    }
    function formatting(fileName, edits) {
      const map = mapOf(fileName);
      if (map === null) return edits;
      return edits
        .filter((e) => !touchesRewrite(fileName, e.span))
        .map((e) => ({ ...e, span: spanBack(fileName, e.span) }));
    }
    function codeActions(actions) {
      return actions === undefined ? actions : actions.map((a) => ({ ...a, changes: textChanges(a.changes) }));
    }
    function navigationTree(fileName, node) {
      if (node === undefined) return node;
      return {
        ...node,
        spans: node.spans.map((s) => spanBack(fileName, s)),
        nameSpan: node.nameSpan === undefined ? undefined : spanBack(fileName, node.nameSpan),
        childItems: node.childItems === undefined ? undefined : node.childItems.map((c) => navigationTree(fileName, c)),
      };
    }
    function navigationBar(fileName, items) {
      return items.map((n) => ({
        ...n,
        spans: n.spans.map((s) => spanBack(fileName, s)),
        childItems: navigationBar(fileName, n.childItems ?? []),
      }));
    }
    function selectionRange(fileName, range) {
      if (range === undefined) return range;
      return {
        textSpan: spanBack(fileName, range.textSpan),
        parent: range.parent === undefined ? undefined : selectionRange(fileName, range.parent),
      };
    }

    /** Everything the service answers, as the proxy answers it. Methods not listed pass through. */
    const proxy = Object.create(null);
    for (const key of Object.keys(service)) {
      const member = service[key];
      proxy[key] = typeof member === 'function' ? (...args) => member.apply(service, args) : member;
    }
    const wrap = (name, make) => {
      const inner = service[name];
      if (typeof inner === 'function') proxy[name] = make(inner.bind(service));
    };

    wrap('getSyntacticDiagnostics', (f) => (file) => diagnostics(file, f(file)));
    wrap('getSemanticDiagnostics', (f) => (file) => diagnostics(file, f(file)));
    wrap('getSuggestionDiagnostics', (f) => (file) => diagnostics(file, f(file)));
    wrap('getQuickInfoAtPosition', (f) => (file, p, ...rest) => {
      const r = f(file, pos(file, p), ...rest);
      return r === undefined ? r : { ...r, textSpan: spanBack(file, r.textSpan) };
    });
    wrap('getDefinitionAtPosition', (f) => (file, p) => documentSpans(f(file, pos(file, p))));
    wrap('getDefinitionAndBoundSpan', (f) => (file, p) => {
      const r = f(file, pos(file, p));
      return r === undefined ? r : { definitions: documentSpans(r.definitions), textSpan: spanBack(file, r.textSpan) };
    });
    wrap('getTypeDefinitionAtPosition', (f) => (file, p) => documentSpans(f(file, pos(file, p))));
    wrap('getImplementationAtPosition', (f) => (file, p) => documentSpans(f(file, pos(file, p))));
    wrap('getReferencesAtPosition', (f) => (file, p) => documentSpans(f(file, pos(file, p))));
    wrap('getFileReferences', (f) => (file) => documentSpans(f(file)));
    wrap('findReferences', (f) => (file, p) => {
      const r = f(file, pos(file, p));
      return r === undefined
        ? r
        : r.map((s) => ({ ...s, definition: documentSpan(s.definition), references: documentSpans(s.references) }));
    });
    wrap('getRenameInfo', (f) => (file, p, ...rest) => {
      const r = f(file, pos(file, p), ...rest);
      return r !== undefined && r.canRename ? { ...r, triggerSpan: spanBack(file, r.triggerSpan) } : r;
    });
    wrap(
      'findRenameLocations',
      (f) =>
        (file, p, ...rest) =>
          documentSpans(f(file, pos(file, p), ...rest)),
    );
    wrap('getDocumentHighlights', (f) => (file, p, filesToSearch) => {
      const r = f(file, pos(file, p), filesToSearch);
      return r === undefined
        ? r
        : r.map((h) => ({
            ...h,
            highlightSpans: h.highlightSpans.map((s) => ({
              ...s,
              textSpan: spanBack(h.fileName, s.textSpan),
              contextSpan: s.contextSpan === undefined ? undefined : spanBack(h.fileName, s.contextSpan),
            })),
          }));
    });
    wrap('getCompletionsAtPosition', (f) => (file, p, ...rest) => {
      const r = f(file, pos(file, p), ...rest);
      if (r === undefined || mapOf(file) === null) return r;
      return {
        ...r,
        optionalReplacementSpan: spanBack(file, r.optionalReplacementSpan),
        entries: r.entries.map((e) =>
          e.replacementSpan === undefined ? e : { ...e, replacementSpan: spanBack(file, e.replacementSpan) },
        ),
      };
    });
    wrap('getCompletionEntryDetails', (f) => (file, p, ...rest) => {
      const r = f(file, pos(file, p), ...rest);
      return r === undefined || r.codeActions === undefined ? r : { ...r, codeActions: codeActions(r.codeActions) };
    });
    wrap('getSignatureHelpItems', (f) => (file, p, ...rest) => {
      const r = f(file, pos(file, p), ...rest);
      return r === undefined ? r : { ...r, applicableSpan: spanBack(file, r.applicableSpan) };
    });
    wrap('getNavigationTree', (f) => (file) => navigationTree(file, f(file)));
    wrap('getNavigationBarItems', (f) => (file) => navigationBar(file, f(file)));
    wrap(
      'getNavigateToItems',
      (f) =>
        (...args) =>
          f(...args).map((i) =>
            mapOf(i.fileName) === null ? i : { ...i, textSpan: spanBack(i.fileName, i.textSpan) },
          ),
    );
    wrap(
      'getOutliningSpans',
      (f) => (file) =>
        f(file).map((s) => ({ ...s, textSpan: spanBack(file, s.textSpan), hintSpan: spanBack(file, s.hintSpan) })),
    );
    wrap('getEncodedSemanticClassifications', (f) => (file, span, format) => {
      const r = f(file, spanIn(file, span), format);
      if (mapOf(file) === null) return r;
      const spans = [];
      for (let i = 0; i + 2 < r.spans.length; i += 3) {
        const s = spanBack(file, { start: r.spans[i], length: r.spans[i + 1] });
        if (s.length > 0) spans.push(s.start, s.length, r.spans[i + 2]);
      }
      return { ...r, spans };
    });
    wrap('getEncodedSyntacticClassifications', (f) => (file, span) => {
      const r = f(file, spanIn(file, span));
      if (mapOf(file) === null) return r;
      const spans = [];
      for (let i = 0; i + 2 < r.spans.length; i += 3) {
        const s = spanBack(file, { start: r.spans[i], length: r.spans[i + 1] });
        if (s.length > 0) spans.push(s.start, s.length, r.spans[i + 2]);
      }
      return { ...r, spans };
    });
    wrap('getCodeFixesAtPosition', (f) => (file, start, end, codes, ...rest) => {
      const map = mapOf(file);
      const r = f(file, pos(file, start), map === null ? end : map.toNew(end, 'end'), codes, ...rest);
      return codeActions(r);
    });
    wrap(
      'getApplicableRefactors',
      (f) =>
        (file, range, ...rest) =>
          f(file, rangeIn(file, range), ...rest),
    );
    wrap('getEditsForRefactor', (f) => (file, format, range, ...rest) => {
      const r = f(file, format, rangeIn(file, range), ...rest);
      return r === undefined ? r : { ...r, edits: textChanges(r.edits) };
    });
    wrap(
      'organizeImports',
      (f) =>
        (args, ...rest) =>
          textChanges(f(args, ...rest)),
    );
    wrap('getFormattingEditsForRange', (f) => (file, start, end, ...rest) => {
      const map = mapOf(file);
      return formatting(file, f(file, pos(file, start), map === null ? end : map.toNew(end, 'end'), ...rest));
    });
    wrap(
      'getFormattingEditsForDocument',
      (f) =>
        (file, ...rest) =>
          formatting(file, f(file, ...rest)),
    );
    wrap(
      'getFormattingEditsAfterKeystroke',
      (f) =>
        (file, p, ...rest) =>
          formatting(file, f(file, pos(file, p), ...rest)),
    );
    wrap('getSmartSelectionRange', (f) => (file, p) => selectionRange(file, f(file, pos(file, p))));
    wrap('getInlayHints', (f) => (file, span, ...rest) => {
      const r = f(file, spanIn(file, span), ...rest);
      return mapOf(file) === null ? r : r.map((h) => ({ ...h, position: posBack(file, h.position) }));
    });
    wrap('getBraceMatchingAtPosition', (f) => (file, p) => f(file, pos(file, p)).map((s) => spanBack(file, s)));
    wrap(
      'getSpanOfEnclosingComment',
      (f) =>
        (file, p, ...rest) =>
          spanBack(file, f(file, pos(file, p), ...rest)),
    );
    wrap(
      'getDocCommentTemplateAtPosition',
      (f) =>
        (file, p, ...rest) =>
          f(file, pos(file, p), ...rest),
    );
    wrap(
      'getCompletionEntrySymbol',
      (f) =>
        (file, p, ...rest) =>
          f(file, pos(file, p), ...rest),
    );
    wrap('prepareCallHierarchy', (f) => (file, p) => {
      const r = f(file, pos(file, p));
      const item = (i) =>
        mapOf(i.file) === null
          ? i
          : { ...i, span: spanBack(i.file, i.span), selectionSpan: spanBack(i.file, i.selectionSpan) };
      return r === undefined ? r : Array.isArray(r) ? r.map(item) : item(r);
    });
    const callItem = (i) =>
      mapOf(i.file) === null
        ? i
        : { ...i, span: spanBack(i.file, i.span), selectionSpan: spanBack(i.file, i.selectionSpan) };
    wrap(
      'provideCallHierarchyIncomingCalls',
      (f) => (file, p) =>
        f(file, pos(file, p)).map((c) => ({
          ...c,
          from: callItem(c.from),
          fromSpans: c.fromSpans.map((s) => spanBack(c.from.file, s)),
        })),
    );
    wrap(
      'provideCallHierarchyOutgoingCalls',
      (f) => (file, p) =>
        f(file, pos(file, p)).map((c) => ({
          ...c,
          to: callItem(c.to),
          fromSpans: c.fromSpans.map((s) => spanBack(file, s)),
        })),
    );

    return proxy;
  }

  return { create };
}

module.exports = init;
