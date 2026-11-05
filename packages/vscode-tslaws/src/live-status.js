'use strict';

// The one-line status of a function the laws reach, shown after its signature: `proved`, `tested 24 runs`, `bounded`,
// `failing: counterexample (price=0, coupon=1)`, `running…`, `stale · ran 3m ago`, or `uncovered`. Pure.

const { inputsText } = require('./format.js');

/** `just now`, `3m ago`, `2h ago`, `4d ago`. */
function ageText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The counterexample as `(price=0, coupon=1)`, or the raw one-line message when there are no names. */
function counterexampleText(record, params = []) {
  const inputs = inputsText(record.counterexample, params);
  if (inputs === undefined) return String(record.message ?? record.status).split(/\r?\n/)[0];
  return `(${inputs.replaceAll(' = ', '=')})`;
}

/**
 * @param {{laws: {file: string, name: string, status: string}[]}} entry the laws that reach the function
 * @param {{
 *   recordOf: (file: string, name: string) => object | undefined,
 *   paramsOf: (file: string, name: string) => string[],
 *   isRunning: (file: string, name: string) => boolean,
 *   ranAt: (file: string, name: string) => number | undefined,
 *   touched: (file: string) => number,
 *   functionFile: string,
 *   now: number,
 * }} ctx
 * @returns {{kind: 'running' | 'stale' | 'failing' | 'open' | 'proved' | 'bounded' | 'tested', tone: 'ok' | 'error' | 'warn' | 'muted', text: string}}
 */
function functionStatus(entry, ctx) {
  const laws = entry.laws.map((l) => ctx.recordOf(l.file, l.name) ?? l);
  if (entry.laws.some((l) => ctx.isRunning(l.file, l.name)))
    return { kind: 'running', tone: 'muted', text: 'running…' };

  const ran = Math.max(0, ...entry.laws.map((l) => ctx.ranAt(l.file, l.name) ?? 0));
  const edited = Math.max(ctx.touched(ctx.functionFile), ...entry.laws.map((l) => ctx.touched(l.file)));
  if (edited > ran) {
    return { kind: 'stale', tone: 'warn', text: ran === 0 ? 'stale' : `stale · ran ${ageText(ctx.now - ran)}` };
  }

  const failed = laws.filter((l) => l.status === 'failed');
  if (failed.length > 0) {
    const first = failed[0];
    const more = failed.length > 1 ? ` (+${failed.length - 1} more)` : '';
    const detail = first.counterexample !== undefined ? 'counterexample ' : '';
    return {
      kind: 'failing',
      tone: 'error',
      text: `failing: ${detail}${counterexampleText(first, ctx.paramsOf(first.file, first.name))}${more}`,
    };
  }
  const other = laws.find((l) => !['proved', 'bounded', 'tested'].includes(l.status));
  if (other !== undefined) return { kind: 'open', tone: 'warn', text: `${other.status}: ${other.name}` };

  const tested = laws.filter((l) => l.status === 'tested');
  if (tested.length > 0) {
    const runs = tested.reduce((sum, l) => sum + (Number.isInteger(l.runs) ? l.runs : 0), 0);
    return { kind: 'tested', tone: 'ok', text: runs > 0 ? `tested ${runs} runs` : 'tested' };
  }
  if (laws.some((l) => l.status === 'bounded')) return { kind: 'bounded', tone: 'ok', text: 'bounded' };
  return { kind: 'proved', tone: 'ok', text: 'proved' };
}

/** The status of an exported function no law reaches: a hint, not an error. */
function uncoveredStatus() {
  return { kind: 'uncovered', tone: 'muted', text: 'uncovered: no law reaches this function' };
}

module.exports = { functionStatus, uncoveredStatus, ageText, counterexampleText };
