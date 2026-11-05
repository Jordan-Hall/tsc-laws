'use strict';

// Finds laws in two syntaxes. Pure; no vscode import.
//  - call style (ordinary TypeScript): `law('name', ...)` and `law.proved('name', ...)`, the name a string or
//    no-substitution template literal, the call possibly spanning lines;
//  - old keyword style: `law [proved] name(` or `name<` at the start of a statement, optionally after `export`/`async`.

const LAW_RE = /^(\s*)(?:export\s+)?(?:async\s+)?(law)\s+(proved\s+(?=[A-Za-z_$]))?([A-Za-z_$][\w$]*)\s*[(<]/;
const CALL_RE = /(?<![\w$.])law(\s*\.\s*proved)?\s*\(\s*/g;

/**
 * Replace comments and the contents of string/template literals with spaces (newlines kept), so offsets and
 * line numbers match the original text but nothing inside a comment or string can look like a law.
 * Quote characters stay, so the start of a literal is still visible.
 */
function mask(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  const blank = (s) => s.replace(/[^\r\n]/g, ' ');
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
      out += blank(text.slice(i, j));
      i = j;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      out += blank(text.slice(i, j));
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c && (c === '`' || (text[j] !== '\n' && text[j] !== '\r'))) {
        j += text[j] === '\\' ? 2 : 1;
      }
      const closed = j < n && text[j] === c;
      const stop = Math.min(j, n);
      out += c + blank(text.slice(i + 1, stop)) + (closed ? c : '');
      i = closed ? stop + 1 : stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

function unescape(s) {
  return s.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r?\n|[\s\S])/g, (m, g, u1, u2, x) => {
    if (u1 !== undefined) return String.fromCodePoint(parseInt(u1, 16));
    if (u2 !== undefined) return String.fromCharCode(parseInt(u2, 16));
    if (x !== undefined) return String.fromCharCode(parseInt(x, 16));
    if (g[0] === '\n' || g[0] === '\r') return '';
    return ESCAPES[g] ?? g;
  });
}

/**
 * @param {string} text
 * @returns {{name: string, line: number, column: number, nameColumn: number, proved: boolean, params: string[]}[]}
 *   line is 0-based, in source order; column is where `law` starts and nameColumn where the name starts; params are
 *   the parameter names
 */
function findLaws(text) {
  const src = String(text);
  const masked = mask(src);
  const out = [];

  // Line starts, to turn offsets into line/column.
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
    else if (src[i] === '\r' && src[i + 1] !== '\n') starts.push(i + 1);
  }
  const locate = (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, column: offset - starts[lo] };
  };

  // Old keyword syntax, line by line on the masked text.
  const lines = masked.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = LAW_RE.exec(lines[i]);
    if (m !== null) {
      const column = lines[i].indexOf('law', m[1].length);
      const nameColumn = lines[i].indexOf(m[4], column + 3 + (m[3] ?? '').length);
      out.push({
        name: m[4],
        line: i,
        column,
        nameColumn,
        proved: m[3] !== undefined,
        params: paramNames(lines, i, nameColumn + m[4].length),
      });
    }
  }

  // Call syntax.
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(masked)) !== null) {
    const q = m.index + m[0].length;
    const quote = src[q];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    const close = masked.indexOf(quote, q + 1);
    if (close < 0) continue;
    const raw = src.slice(q + 1, close);
    if (quote === '`' && raw.includes('${')) continue; // not a constant name
    if (!/^\s*,/.test(masked.slice(close + 1, close + 200))) continue; // the name is followed by the law function
    const { line, column } = locate(m.index);
    const named = locate(q + 1);
    // The parameters are those of the function after the name: `, async (a, b) =>` or `, function (a, b)`.
    const lead = /^\s*,\s*(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?(?=[(<])/.exec(
      masked.slice(close + 1, close + 200),
    );
    const at = lead === null ? null : locate(close + 1 + lead[0].length);
    out.push({
      name: unescape(raw),
      line,
      column,
      nameColumn: named.line === line ? named.column : column,
      proved: m[1] !== undefined,
      params: at === null ? [] : paramNames(lines, at.line, at.column),
    });
  }

  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The parameter names of the declaration whose name ends at `column` of `lines[start]`: `(a: number, { b }: P)` gives a, arg2. */
function paramNames(lines, start, column) {
  let text = '';
  for (let i = start; i < Math.min(lines.length, start + 12); i++)
    text += i === start ? lines[i].slice(column) : '\n' + lines[i];
  // Skip type parameters `<T extends X>`, then read the balanced `( ... )`.
  let at = 0;
  if (text[0] === '<') {
    let depth = 0;
    for (; at < text.length; at++) {
      if (text[at] === '<') depth++;
      else if (text[at] === '>' && --depth === 0) break;
    }
    at++;
  }
  while (at < text.length && /\s/.test(text[at])) at++;
  if (text[at] !== '(') return [];
  const names = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    if (current.trim() !== '') {
      const m = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*[?:=,]?/.exec(current);
      names.push(m === null ? `arg${names.length + 1}` : m[1]);
    }
    current = '';
  };
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if ('([{<'.includes(ch) && !(ch === '<' && text[i + 1] === '=')) {
      depth++;
      if (depth === 1) continue;
    } else if (')]}>'.includes(ch) && !(ch === '>' && text[i - 1] === '=')) {
      depth--;
      if (depth === 0) {
        flush();
        break;
      }
    } else if (ch === ',' && depth === 1) {
      flush();
      continue;
    }
    if (depth >= 1) current += ch;
  }
  return names;
}

module.exports = { findLaws };
