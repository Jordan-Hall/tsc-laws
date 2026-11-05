'use strict';

// Builds the diagnostics for a set of records: on the law's name, and for a failing law on the functions it exercises,
// each pointing at the other. Pure: `readText(file)` supplies the current text of a project file (the open buffer, else
// the file on disk), so ranges are those of the code as it is now.

const { findLaws } = require('./find-laws.js');
const { lawRange, declarationRange, callRange } = require('./ranges.js');
const { lawMessage, sourceMessage, inlineText, reproduceCommand } = require('./format.js');
const { blamedFunctions } = require('./model.js');

const SHOWN = new Set(['failed', 'open', 'tampered', 'error', 'uncovered']);
const WARNING = new Set(['open', 'uncovered']);

/** The stable code of a diagnostic: `tslaws/<law or function name>`. */
const codeOf = (record) => `tslaws/${record.name}`;

const spanText = (file, range) => `${file}:${range.line + 1}`;

/**
 * @param {object[]} records
 * @param {(file: string) => string | undefined} readText
 * @returns {Map<string, object[]>} descriptors by project-relative file, in file order
 */
function buildDiagnostics(records, readText) {
  const out = new Map();
  const push = (file, d) => {
    if (!out.has(file)) out.set(file, []);
    out.get(file).push({ file, source: 'tslaws', ...d });
  };
  for (const record of records) {
    if (!SHOWN.has(record.status)) continue;
    const severity = WARNING.has(record.status) ? 'warning' : 'error';
    const code = codeOf(record);

    if (record.status === 'uncovered') {
      const text = readText(record.file);
      if (text === undefined) continue;
      const range = declarationRange(text, { line: record.line, column: 0 }, record.name);
      if (range === null) continue;
      push(record.file, {
        range,
        severity,
        code,
        role: 'source',
        lawFile: undefined,
        lawName: record.name,
        message: `${record.name} is exported but no law reaches it.\n${record.message ?? ''}`.trim(),
        related: [],
      });
      continue;
    }

    const lawText = readText(record.file);
    if (lawText === undefined) continue;
    const found = findLaws(lawText);
    const declared =
      found.find((l) => l.name === record.name && record.line - 1 === l.line) ??
      found.find((l) => l.name === record.name);
    const params = declared?.params ?? [];
    const range = lawRange(lawText, record.name) ?? {
      line: Math.max(0, record.line - 1),
      start: 0,
      end: (lawText.split(/\r?\n/)[Math.max(0, record.line - 1)] ?? '').length || 1,
    };

    // Where the failure is on the code side: resolved against the text as it is now.
    const targets = [];
    if (record.status === 'failed') {
      for (const { exercise, certain } of blamedFunctions(record)) {
        const text = readText(exercise.declaration.file);
        const declaration = text === undefined ? null : declarationRange(text, exercise.declaration, exercise.name);
        if (declaration === null) continue;
        const call =
          exercise.call === undefined || exercise.call.file !== record.file
            ? null
            : callRange(lawText, exercise.call, exercise.name, record.name);
        targets.push({ exercise, certain, declaration, call });
      }
    }

    const related = [];
    for (const t of targets) {
      related.push({
        file: t.exercise.declaration.file,
        range: t.declaration,
        message: `${t.exercise.name} is declared here, and law ${record.name} exercises it`,
      });
      if (t.call !== null)
        related.push({
          file: record.file,
          range: t.call,
          message: `${record.name} calls ${t.exercise.name} here`,
        });
    }
    push(record.file, {
      range,
      severity,
      code,
      role: 'law',
      calls: targets.map((t) => t.call).filter((c) => c !== null),
      lawFile: record.file,
      lawName: record.name,
      message: lawMessage(record, params),
      inline: inlineText(record, params, 'law'),
      reproduce: record.status === 'failed' ? reproduceCommand(record) : undefined,
      related,
    });

    for (const t of targets) {
      push(t.exercise.declaration.file, {
        range: t.declaration,
        severity: t.certain ? 'error' : 'warning',
        code,
        role: 'source',
        lawFile: record.file,
        lawName: record.name,
        message: sourceMessage(record, t.exercise, t.certain, params),
        inline: inlineText(record, params, 'source'),
        reproduce: reproduceCommand(record),
        related: [
          { file: record.file, range, message: `Law ${record.name} (${record.status}) is declared here` },
          ...(t.call === null
            ? []
            : [
                {
                  file: record.file,
                  range: t.call,
                  message: `${record.name} calls ${t.exercise.name} at ${spanText(record.file, t.call)}`,
                },
              ]),
        ],
      });
    }
  }
  return out;
}

module.exports = { buildDiagnostics, codeOf, SHOWN };
