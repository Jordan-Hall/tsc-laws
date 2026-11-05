'use strict';

// Where a diagnostic goes in a file as it is now. The report's positions are those of the last run; the buffer may have
// moved on since, so each reported position is checked against the text and, when it no longer holds, the declaration is
// searched for nearby. Ranges are 0-based `{line, start, end}` on one line and cover a name, never the whole line.

const { findLaws } = require('./find-laws.js');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name of law `name` in `text`: the identifier after `law` (and `proved`), or null when no such law is declared. */
function lawRange(text, name) {
  const law = findLaws(text).find((l) => l.name === name);
  return law === undefined ? null : { line: law.line, start: law.nameColumn, end: law.nameColumn + name.length };
}

/** Lines of `text` that declare function-like `name`, as `{line, start}`: `function name`, `class name`, `const name =`. */
function declarations(lines, name) {
  const word = escapeRegExp(name);
  const decl = new RegExp(
    `(?:\\bfunction\\s*\\*?\\s+|\\bclass\\s+|\\b(?:const|let|var)\\s+)(${word})\\b(?=\\s*(?:[=(<:{]|extends\\b|implements\\b|$))`,
  );
  const out = [];
  lines.forEach((text, line) => {
    const m = decl.exec(text);
    if (m !== null) out.push({ line, start: m.index + m[0].length - name.length });
  });
  return out;
}

/**
 * Where function `name` is declared, given the span the report gave (1-based; `line` only for an uncovered function).
 * The reported range is kept when the name is still there; otherwise the nearest declaration of the name wins.
 * @returns {{line: number, start: number, end: number} | null}
 */
function declarationRange(text, span, name) {
  const lines = String(text).split(/\r?\n/);
  const line = span.line - 1;
  if (Number.isInteger(span.column) && span.column > 0) {
    const start = span.column - 1;
    if (lines[line]?.startsWith(name, start)) return { line, start, end: start + name.length };
  }
  const found = declarations(lines, name);
  if (found.length === 0) return null;
  const nearest = found.reduce((a, b) => (Math.abs(b.line - line) < Math.abs(a.line - line) ? b : a));
  return { line: nearest.line, start: nearest.start, end: nearest.start + name.length };
}

/**
 * Where law text refers to function `name`, given the reported span of the call. Searches the law's own lines when the
 * reported range has moved.
 * @returns {{line: number, start: number, end: number} | null}
 */
function callRange(text, span, name, lawName) {
  const lines = String(text).split(/\r?\n/);
  const line = span.line - 1;
  const start = span.column - 1;
  if (lines[line]?.startsWith(name, start)) return { line, start, end: start + name.length };
  const law = lawName === undefined ? undefined : findLaws(text).find((l) => l.name === lawName);
  if (law === undefined) return null;
  const word = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`);
  const next = findLaws(text).find((l) => l.line > law.line);
  const last = next === undefined ? lines.length : next.line;
  for (let i = law.line; i < last; i++) {
    const m = word.exec(lines[i]);
    if (m !== null) return { line: i, start: m.index, end: m.index + name.length };
  }
  return null;
}

/** The text of a range, for tests and hovers. */
function textOf(text, range) {
  return String(text).split(/\r?\n/)[range.line]?.slice(range.start, range.end);
}

module.exports = { lawRange, declarationRange, callRange, textOf, declarations };
