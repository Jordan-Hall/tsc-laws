'use strict';

// What `tslaws list --json` says about the project's laws files, and the Explorer badge each one gets. Pure; no vscode
// import. The tool decides which files are laws files and at what level they run (from their names by default, from
// their imports with `levels: "imports"` in tslaws.json); the extension asks instead of matching file names.

const KINDS = new Set(['node', 'browser', 'e2e']);
const STATUSES = new Set(['accepted', 'unaccepted', 'proposed']);

/**
 * @typedef {{file: string, kind: 'node' | 'browser' | 'e2e', status: 'accepted' | 'unaccepted' | 'proposed', error?: string, notices: string[]}} LawFile
 */

/**
 * Parses the output of `tslaws list --json`. Returns null for anything that is not that shape (an older tslaws that has
 * no `list` prints usage text or nothing), so the caller can fall back.
 * @param {string} text
 * @returns {LawFile[] | null}
 */
function parseList(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || !Array.isArray(data.files)) return null;
  const out = [];
  for (const f of data.files) {
    if (typeof f !== 'object' || f === null || typeof f.file !== 'string') return null;
    if (!KINDS.has(f.kind) || !STATUSES.has(f.status)) return null;
    out.push({
      file: f.file.replaceAll('\\', '/'),
      kind: f.kind,
      status: f.status,
      ...(typeof f.error === 'string' ? { error: f.error } : {}),
      notices: Array.isArray(f.notices) ? f.notices.map(String) : [],
    });
  }
  return out;
}

/**
 * What an older tslaws (no `list`) leaves us with: every `*.laws.ts`, the level taken from the file name (the default way levels are decided).
 * @param {string} rel
 * @returns {LawFile}
 */
function fromName(rel) {
  const kind = /\.e2e\.laws\.[cm]?ts$/.test(rel) ? 'e2e' : /\.browser\.laws\.[cm]?ts$/.test(rel) ? 'browser' : 'node';
  return { file: rel, kind, status: rel.endsWith('.proposed.laws.ts') ? 'proposed' : 'accepted', notices: [] };
}

const WORDS = { node: 'Node', browser: 'browser', e2e: 'end-to-end' };

/**
 * The Explorer badge for a file: one letter for the level (N node, B browser, E end to end), P for a proposal. The
 * tooltip says it in words and notes a file the lock does not know.
 * @param {LawFile} entry
 * @returns {{badge: string, tooltip: string, color: string}}
 */
function badgeFor(entry) {
  const level = `${WORDS[entry.kind]} laws`;
  if (entry.status === 'proposed')
    return { badge: 'P', tooltip: `proposed ${level} (not accepted, not in the lock)`, color: 'charts.yellow' };
  const color = entry.kind === 'browser' ? 'charts.blue' : entry.kind === 'e2e' ? 'charts.purple' : 'charts.green';
  const letter = entry.kind === 'browser' ? 'B' : entry.kind === 'e2e' ? 'E' : 'N';
  const note = entry.status === 'unaccepted' ? ' (not in tsc-laws.lock yet: a person must run `tslaws accept`)' : '';
  return { badge: letter, tooltip: `${level}${note}${entry.error === undefined ? '' : `: ${entry.error}`}`, color };
}

module.exports = { parseList, fromName, badgeFor };
