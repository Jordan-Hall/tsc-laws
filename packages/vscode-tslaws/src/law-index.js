'use strict';

// Which laws exist and which functions each one exercises, for navigation. The first source is the last report (its
// `exercises`); where no run has covered a law yet, the laws file's own imports say what it uses: an imported function
// the law mentions is a function the law exercises. Pure: `readText` and `exists` are passed in.

const nodePath = require('node:path/posix');
const { findLaws } = require('./find-laws.js');
const { declarationRange, declarations } = require('./ranges.js');

const isLawsFile = (rel) => rel.endsWith('.laws.ts');
const key = (file, name) => `${file}::${name}`;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/** The project file a relative module specifier names, or null. */
function resolveSpecifier(fromRel, spec, exists) {
  const base = nodePath.normalize(nodePath.join(nodePath.dirname(fromRel), spec));
  const stripped = base.replace(/\.[cm]?js$/, '');
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => stripped + e),
    ...EXTENSIONS.map((e) => nodePath.join(base, `index${e}`)),
  ];
  return candidates.find((c) => EXTENSIONS.some((e) => c.endsWith(e)) && exists(c)) ?? null;
}

/**
 * The relative imports of a file: named imports as `local -> {file, name}` and namespace imports as `local -> file`.
 * @returns {{named: Map<string, {file: string, name: string}>, namespaces: Map<string, string>}}
 */
function importsOf(text, fromRel, exists) {
  const named = new Map();
  const namespaces = new Map();
  const from = /import\s+(?:type\s+)?([^'";]*?)\s+from\s+['"](\.{1,2}\/[^'"]*)['"]/g;
  let m;
  while ((m = from.exec(text)) !== null) {
    const file = resolveSpecifier(fromRel, m[2], exists);
    if (file === null) continue;
    const clause = m[1];
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns !== null) namespaces.set(ns[1], file);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces === null) continue;
    for (const part of braces[1].split(',')) {
      const item = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (item !== null) named.set(item[2] ?? item[1], { file, name: item[1] });
    }
  }
  return { named, namespaces };
}

/** Functions an imported name or namespace member the law mentions refers to, whose declaration is found in its file. */
function staticFunctions({ lawText, law, nextLine, file, readText, exists }) {
  const lines = lawText.split(/\r?\n/);
  const body = lines.slice(law.line, nextLine ?? lines.length).join('\n');
  const { named, namespaces } = importsOf(lawText, file, exists);
  const found = new Map();
  const add = (target, name) => {
    const text = readText(target);
    if (text === undefined) return;
    const range = declarationRange(text, { line: 0, column: 0 }, name);
    const declared = declarations(text.split(/\r?\n/), name);
    if (range === null || declared.length === 0) return;
    found.set(key(target, name), { file: target, name, range });
  };
  for (const [local, target] of named) {
    if (new RegExp(`(?<![\\w$.])${escapeRegExp(local)}(?![\\w$])`).test(body)) add(target.file, target.name);
  }
  for (const [local, target] of namespaces) {
    const member = new RegExp(`(?<![\\w$.])${escapeRegExp(local)}\\.([A-Za-z_$][\\w$]*)`, 'g');
    let m;
    while ((m = member.exec(body)) !== null) add(target, m[1]);
  }
  return [...found.values()];
}

/**
 * @param {{
 *   records: object[] | null, lawFiles: string[],
 *   readText: (rel: string) => string | undefined, exists: (rel: string) => boolean,
 * }} o
 * @returns {{
 *   laws: {file: string, name: string, line: number, start: number, end: number, status: string, record?: object, functions: {file: string, name: string, range: object}[], viaReport: boolean}[],
 *   byFunction: Map<string, object[]>, byLaw: Map<string, object>,
 * }}
 */
function buildNavigation({ records, lawFiles, readText, exists }) {
  const files = new Set([...lawFiles, ...(records ?? []).map((r) => r.file).filter(isLawsFile)]);
  const laws = [];
  for (const file of [...files].sort()) {
    const text = readText(file);
    if (text === undefined) continue;
    const found = findLaws(text);
    found.forEach((law, i) => {
      const record = (records ?? []).find((r) => r.file === file && r.name === law.name);
      const exercises = record?.exercises ?? [];
      let functions = [];
      for (const e of exercises) {
        const source = readText(e.declaration.file);
        const range = source === undefined ? null : declarationRange(source, e.declaration, e.name);
        if (range !== null) functions.push({ file: e.declaration.file, name: e.name, range });
      }
      const viaReport = functions.length > 0;
      if (!viaReport) {
        functions = staticFunctions({ lawText: text, law, nextLine: found[i + 1]?.line, file, readText, exists });
      }
      laws.push({
        file,
        name: law.name,
        line: law.line,
        start: law.nameColumn,
        end: law.nameColumn + law.name.length,
        status: record?.status ?? 'not run',
        record,
        functions,
        viaReport,
      });
    });
  }
  const byFunction = new Map();
  const byLaw = new Map();
  for (const law of laws) {
    byLaw.set(key(law.file, law.name), law);
    for (const f of law.functions) {
      const id = key(f.file, f.name);
      if (!byFunction.has(id)) byFunction.set(id, []);
      byFunction.get(id).push(law);
    }
  }
  return { laws, byFunction, byLaw };
}

/** The identifier at `character` of `line`, with its range, or null. */
function wordAt(line, character) {
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (character >= m.index && character <= m.index + m[0].length) {
      return { word: m[0], start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

/**
 * The function a word in `rel` refers to, as `file::name` ids to try: the function declared in this file under that name,
 * the imported name it came from, or a member of an imported namespace.
 */
function functionIdsFor({ rel, text, line, character, exists }) {
  const lines = text.split(/\r?\n/);
  const at = wordAt(lines[line] ?? '', character);
  if (at === null) return { word: null, ids: [] };
  const ids = [key(rel, at.word)];
  const { named, namespaces } = importsOf(text, rel, exists);
  const imported = named.get(at.word);
  if (imported !== undefined) ids.push(key(imported.file, imported.name));
  const before = (lines[line] ?? '').slice(0, at.start);
  const ns = /([A-Za-z_$][\w$]*)\.$/.exec(before);
  if (ns !== null && namespaces.has(ns[1])) ids.push(key(namespaces.get(ns[1]), at.word));
  return { word: at.word, range: at, ids };
}

module.exports = {
  buildNavigation,
  importsOf,
  staticFunctions,
  resolveSpecifier,
  functionIdsFor,
  wordAt,
  isLawsFile,
  key,
};
