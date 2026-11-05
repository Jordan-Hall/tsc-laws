'use strict';

// Turns the output of `tslaws check` (`--json`, or the `--reporter ndjson` stream) into per-law records. Pure.

/** Extract and parse the JSON object from stdout, tolerating noise before it. */
function parseReport(stdout) {
  const text = String(stdout);
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON in tslaws output');
  return normalizeReport(JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)));
}

function normalizeReport(raw) {
  const results = Array.isArray(raw.results) ? raw.results : [];
  return {
    records: results.map(normalizeRecord),
    compileDiagnostics: typeof raw.compileDiagnostics === 'string' ? raw.compileDiagnostics : '',
    compileOk: raw.compileOk !== false,
    lockMissing: raw.lockMissing === true,
    ok: raw.ok === true,
  };
}

function normalizeRecord(r) {
  return {
    file: normalizePath(r.file),
    name: String(r.name ?? ''),
    line: Number.isInteger(r.line) ? r.line : 0, // 1-based; 0 when unknown
    status: String(r.status ?? 'error'),
    method: r.method,
    runs: r.runs,
    seed: r.seed,
    counterexample: r.counterexample,
    message: r.message,
    hint: r.hint,
    exercises: Array.isArray(r.exercises) ? r.exercises.map(normalizeExercise).filter((e) => e !== null) : [],
  };
}

function normalizeSpan(s) {
  if (s === null || typeof s !== 'object' || !Number.isInteger(s.line)) return undefined;
  const column = Number.isInteger(s.column) ? s.column : 1;
  return {
    file: normalizePath(s.file),
    line: s.line,
    column,
    endLine: Number.isInteger(s.endLine) ? s.endLine : s.line,
    endColumn: Number.isInteger(s.endColumn) ? s.endColumn : column,
  };
}

function normalizeExercise(e) {
  const declaration = normalizeSpan(e?.declaration);
  if (declaration === undefined || typeof e.name !== 'string') return null;
  return { name: e.name, declaration, call: normalizeSpan(e.call), failing: e.failing === true };
}

function normalizePath(p) {
  return String(p ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
}

/**
 * Reads the `--reporter ndjson` stream a chunk at a time. `onEvent` gets each parsed event: `plan`, `start`, `result`
 * (the record normalised) and `report` (the normalised report). Lines that are not JSON go to `onNoise`.
 * @returns {{write(chunk: string): void, end(): void}}
 */
function createStreamParser(onEvent, onNoise = () => {}) {
  let buffer = '';
  const line = (text) => {
    if (text.trim() === '') return;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return onNoise(text);
    }
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return onNoise(text);
    if (event.type === 'result') onEvent({ type: 'result', record: normalizeRecord(event.result ?? {}) });
    else if (event.type === 'report') onEvent({ type: 'report', report: normalizeReport(event) });
    else if (event.type === 'plan')
      onEvent({
        type: 'plan',
        laws: (Array.isArray(event.laws) ? event.laws : []).map((l) => ({
          file: normalizePath(l.file),
          name: String(l.name),
          line: l.line,
        })),
      });
    else if (event.type === 'start')
      onEvent({ type: 'start', file: normalizePath(event.file), name: String(event.name) });
  };
  return {
    write(chunk) {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    },
    end() {
      line(buffer);
      buffer = '';
    },
  };
}

/** Records for one file. `file` may be absolute; `root` is the workspace root. */
function recordsForFile(records, file, root) {
  const rel = relativeTo(file, root);
  return records.filter((r) => r.file === rel);
}

function relativeTo(file, root) {
  const f = normalizePath(file);
  const r = normalizePath(root).replace(/\/$/, '');
  if (r !== '' && f.toLowerCase().startsWith(r.toLowerCase() + '/')) return f.slice(r.length + 1);
  return f;
}

/** Distinct files that have records. */
function filesOf(records) {
  return [...new Set(records.map((r) => r.file))];
}

/** Parse the URL a `tslaws ui` process prints: `tslaws ui: http://127.0.0.1:PORT/`. */
function parseUiUrl(text) {
  const m = /tslaws ui:\s*(http:\/\/127\.0\.0\.1:\d+\/?)/.exec(String(text));
  return m === null ? null : m[1];
}

module.exports = {
  parseReport,
  createStreamParser,
  normalizeRecord,
  normalizePath,
  recordsForFile,
  filesOf,
  parseUiUrl,
  relativeTo,
};
