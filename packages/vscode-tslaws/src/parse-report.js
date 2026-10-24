'use strict';

// Turns the output of `tslaws check --json` into per-law records and lens/diagnostic descriptors. Pure.

const { PASSING } = require('./summary.js');

const DIAGNOSTIC_STATUSES = new Set(['failed', 'open', 'tampered', 'error', 'uncovered']);

/** Extract and parse the JSON object from stdout, tolerating noise before it. */
function parseReport(stdout) {
  const text = String(stdout);
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON in tslaws output');
  const raw = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
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
  };
}

function normalizePath(p) {
  return String(p ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
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

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * Lens descriptors for the law declarations found in a file.
 * @param {{name: string, line: number}[]} laws from findLaws (0-based lines)
 * @param {object[]} fileRecords records of this file
 * @returns {{line: number, title: string, command: string, status: string}[]} line 0-based
 */
function lensesFor(laws, fileRecords) {
  const out = [];
  for (const law of laws) {
    const rec = fileRecords.find((r) => r.name === law.name);
    const status = rec === undefined ? 'not run' : rec.status;
    out.push({ line: law.line, title: `${statusIcon(status)} ${status}`, command: 'tslaws.runFile', status });
    if (rec !== undefined && rec.status === 'failed' && rec.counterexample !== undefined) {
      out.push({
        line: law.line,
        title: `counterexample: ${oneLine(rec.counterexample)}`,
        command: 'tslaws.openDashboard',
        status: 'counterexample',
      });
    }
  }
  return out;
}

function statusIcon(status) {
  if (PASSING.has(status)) return '$(check)';
  if (status === 'not run') return '$(circle-outline)';
  return '$(error)';
}

/**
 * Diagnostic descriptors for records of a file. Laws are located by declaration when found, else by the reported line.
 * @returns {{line: number, severity: 'error'|'warning', message: string, source: string, code: string}[]} line 0-based
 */
function diagnosticsFor(fileRecords, laws = []) {
  const out = [];
  for (const r of fileRecords) {
    if (!DIAGNOSTIC_STATUSES.has(r.status)) continue;
    const decl = laws.find((l) => l.name === r.name);
    const line = decl !== undefined ? decl.line : Math.max(0, r.line - 1);
    const parts = [`law ${r.name}: ${r.status}`];
    if (r.message) parts[0] += ` - ${oneLine(r.message)}`;
    if (r.counterexample !== undefined) parts.push(`counterexample: ${oneLine(r.counterexample)}`);
    if (r.hint) parts.push(`hint: ${oneLine(r.hint)}`);
    out.push({
      line,
      severity: r.status === 'open' || r.status === 'uncovered' ? 'warning' : 'error',
      message: parts.join('\n'),
      source: 'tslaws',
      code: r.status,
    });
  }
  return out;
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

module.exports = { parseReport, recordsForFile, lensesFor, diagnosticsFor, filesOf, parseUiUrl, relativeTo };
