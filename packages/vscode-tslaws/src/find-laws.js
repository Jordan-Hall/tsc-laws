'use strict';

// Finds `law` declarations the way the compiler does: `law [proved] name(` or `name<` at the start of a statement,
// optionally after `export` and/or `async`. Pure; no vscode import.

const LAW_RE = /^(\s*)(?:export\s+)?(?:async\s+)?(law)\s+(proved\s+(?=[A-Za-z_$]))?([A-Za-z_$][\w$]*)\s*[(<]/;

/**
 * @param {string} text
 * @returns {{name: string, line: number, column: number, proved: boolean}[]} line is 0-based
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
      out.push({ name: m[4], line: i, column: line.indexOf('law', m[1].length), proved: m[3] !== undefined });
    }
    // Track a block comment opened on this line and not closed on it.
    const open = line.lastIndexOf('/*');
    if (open >= 0 && line.indexOf('*/', open) < 0 && !/\/\/.*\/\*/.test(line)) inBlock = true;
  }
  return out;
}

module.exports = { findLaws };
