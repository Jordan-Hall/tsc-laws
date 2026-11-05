'use strict';

// The compiler's own law rules (TS9101 to TS9106: a law returns boolean or void, is exported, has typed parameters ...)
// reach the editor through `tslaws check`, which compiles the project with the tsc-laws compiler and reports what it
// printed as `compileDiagnostics`. This turns those lines into diagnostics on the same ranges, so they show in the
// Problems view beside the TypeScript ones. Pure.

const LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS91\d\d):\s+(.*)$/;

/**
 * @param {string} text the compiler's output
 * @param {(file: string) => string} toRelative turns the printed path into a project-relative one
 * @returns {{file: string, line: number, column: number, code: string, message: string}[]} line and column are 1-based
 */
function parseLawDiagnostics(text, toRelative = (f) => f) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = LINE.exec(raw.trim());
    if (m === null) continue;
    out.push({
      file: toRelative(m[1].replaceAll(String.fromCharCode(92), '/')),
      line: Number(m[2]),
      column: Number(m[3]),
      code: m[4],
      message: m[5],
    });
  }
  return out;
}

/**
 * Diagnostic descriptors, as `buildDiagnostics` makes them, for the compiler's law rules.
 * @param {string} text
 * @param {(file: string) => string | undefined} readText
 * @param {(file: string) => string} toRelative
 * @returns {Map<string, object[]>}
 */
function compileDiagnostics(text, readText, toRelative) {
  const out = new Map();
  for (const d of parseLawDiagnostics(text, toRelative)) {
    const source = readText(d.file);
    const line = source === undefined ? undefined : source.split(/\r?\n/)[d.line - 1];
    const start = d.column - 1;
    // The compiler points at a name or a parameter; cover the identifier that starts there.
    const word = line === undefined ? null : /^[\w$]+/.exec(line.slice(start));
    const range = { line: d.line - 1, start, end: start + (word === null ? 1 : word[0].length) };
    if (!out.has(d.file)) out.set(d.file, []);
    out.get(d.file).push({
      file: d.file,
      source: 'tsc-laws',
      range,
      severity: 'error',
      code: d.code,
      role: 'compiler',
      message: d.message,
      related: [],
    });
  }
  return out;
}

module.exports = { parseLawDiagnostics, compileDiagnostics };
