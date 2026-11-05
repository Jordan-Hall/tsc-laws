'use strict';

// Finds `law` declarations the way the compiler does: `law [proved] name(` or `name<` at the start of a statement,
// optionally after `export` and/or `async`. Pure; no vscode import.

const LAW_RE = /^(\s*)(?:export\s+)?(?:async\s+)?(law)\s+(proved\s+(?=[A-Za-z_$]))?([A-Za-z_$][\w$]*)\s*[(<]/;

/**
 * @param {string} text
 * @returns {{name: string, line: number, column: number, nameColumn: number, proved: boolean, params: string[]}[]}
 *   line is 0-based; column is where `law` starts and nameColumn where the name starts; params are the parameter names
 */
function findLaws(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = ' '.repeat(end + 2) + line.slice(end + 2);
      inBlock = false;
    }
    const m = LAW_RE.exec(line);
    if (m !== null) {
      const column = line.indexOf('law', m[1].length);
      const nameColumn = line.indexOf(m[4], column + 3 + (m[3] ?? '').length);
      out.push({
        name: m[4],
        line: i,
        column,
        nameColumn,
        proved: m[3] !== undefined,
        params: paramNames(lines, i, nameColumn + m[4].length),
      });
    }
    // Track a block comment opened on this line and not closed on it.
    const open = line.lastIndexOf('/*');
    if (open >= 0 && line.indexOf('*/', open) < 0 && !/\/\/.*\/\*/.test(line)) inBlock = true;
  }
  return out;
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
