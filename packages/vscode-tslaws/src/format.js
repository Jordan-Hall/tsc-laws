'use strict';

// The words the editor shows: lens titles, diagnostic and hover text, the command that reproduces a failure. Pure.

const { PASSING, countStatuses, ORDER } = require('./summary.js');

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Splits `[a, [b, c], "d,e"]` into its top-level elements; null when the text is not a bracketed list. */
function splitArguments(text) {
  const t = String(text).trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 1; i < t.length - 1; i++) {
    const ch = t[i];
    if (quote !== '') {
      current += ch;
      if (ch === '\\') current += t[++i] ?? '';
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
    } else if ('([{'.includes(ch)) {
      depth++;
      current += ch;
    } else if (')]}'.includes(ch)) {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** The shrunk counterexample as named inputs: `xs = [1,1]`, or `price = 0, coupon = 1`; the raw text when names do not fit. */
function inputsText(counterexample, params = []) {
  if (counterexample === undefined) return undefined;
  const raw = oneLine(counterexample);
  const parts = splitArguments(raw);
  if (parts === null || parts.length !== params.length || params.length === 0) return raw;
  return parts.map((value, i) => `${params[i]} = ${value}`).join(', ');
}

const quoteArg = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replaceAll('"', '\\"')}"`);

/** The command that runs one law again: `npx tslaws check src/a.laws.ts --law name --seed 7`. */
function reproduceCommand(record, { withSeed = true } = {}) {
  const parts = ['npx', 'tslaws', 'check', quoteArg(record.file), '--law', record.name];
  if (withSeed && record.status === 'failed' && Number.isInteger(record.seed))
    parts.push('--seed', String(record.seed));
  return parts.join(' ');
}

/** `12:03:45`, in the local time of `at` (ms since epoch). */
function clock(at) {
  const d = new Date(at);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function methodText(r) {
  const bits = [];
  if (typeof r.method === 'string' && r.method !== '') bits.push(r.method);
  if (Number.isInteger(r.runs)) bits.push(`${r.runs} runs`);
  if (r.status === 'failed' && Number.isInteger(r.seed)) bits.push(`seed ${r.seed}`);
  return bits.join(', ');
}

/**
 * The message of a law's diagnostic, with the shrunk inputs and how to reproduce.
 * @param {object} record
 * @param {string[]} params the law's parameter names
 */
function lawMessage(record, params = []) {
  const how = methodText(record);
  const head = `Law ${record.name} ${record.status}${how === '' ? '' : ` (${how})`}${record.message ? `: ${oneLine(record.message)}` : ''}`;
  const lines = [head];
  const inputs = inputsText(record.counterexample, params);
  if (inputs !== undefined) lines.push(`Shrunk counterexample: ${inputs}`);
  if (record.status === 'failed') lines.push(`Reproduce: ${reproduceCommand(record)}`);
  else if (record.hint) lines.push(`Next: ${oneLine(record.hint)}`);
  return lines.join('\n');
}

/** The message on the function a failing law exercises. */
function sourceMessage(record, exercise, certain, params = []) {
  const lines = [
    certain
      ? `Law ${record.name} fails on ${exercise.name}.`
      : `Law ${record.name} fails and calls ${exercise.name}; this may be where.`,
  ];
  const inputs = inputsText(record.counterexample, params);
  if (inputs !== undefined) lines.push(`Shrunk counterexample: ${inputs}`);
  if (record.message) lines.push(oneLine(record.message));
  lines.push(`Reproduce: ${reproduceCommand(record)}`);
  return lines.join('\n');
}

/** The one-line text that follows the code on a failing line. */
function inlineText(record, params = [], role = 'law') {
  const inputs = inputsText(record.counterexample, params);
  const cause = inputs !== undefined ? `counterexample ${inputs}` : oneLine(record.message ?? record.status);
  return role === 'law' ? `  ${record.status}: ${cause}` : `  fails law ${record.name}: ${cause}`;
}

function statusIcon(status) {
  if (PASSING.has(status)) return '$(check)';
  if (status === 'not run') return '$(circle-outline)';
  if (status === 'open' || status === 'uncovered') return '$(warning)';
  return '$(error)';
}

/** The title of the lens above a law: its status, how it was reached, the counts and when it ran. */
function lawLensTitle(record, at) {
  if (record === undefined) return `${statusIcon('not run')} not run`;
  const how = methodText(record);
  const when = at === undefined ? '' : ` · ${clock(at)}`;
  return `${statusIcon(record.status)} ${record.status}${how === '' ? '' : ` · ${how}`}${when}`;
}

/** The title of the lens at the top of a laws file: the counts of its laws. */
function fileLensTitle(records) {
  if (records.length === 0) return '$(circle-outline) laws not run';
  const counts = countStatuses(records);
  const text = ORDER.filter((s) => counts[s] !== undefined)
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  return `${records.every((r) => PASSING.has(r.status)) ? '$(check)' : '$(error)'} ${text}`;
}

/** The title of the lens above a function the laws reach. */
function sourceLensTitle(laws) {
  const failing = laws.filter((l) => l.failing).length;
  const n = laws.length;
  return `${failing === 0 ? '$(shield)' : '$(error)'} covered by ${n} law${n === 1 ? '' : 's'}, ${failing} failing`;
}

module.exports = {
  splitArguments,
  inputsText,
  reproduceCommand,
  clock,
  lawMessage,
  sourceMessage,
  inlineText,
  lawLensTitle,
  fileLensTitle,
  sourceLensTitle,
  oneLine,
  statusIcon,
};
