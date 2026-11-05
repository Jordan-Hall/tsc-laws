'use strict';

// Rewrites `law` declarations into TypeScript that `tsserver` parses, as a list of edits, and maps offsets between the
// original text and the rewritten text. Pure: no TypeScript, no vscode.
//
//   [export] [async] law [proved] name<T>(a: A) { ... }   ->  [export] [async] function name<T>(a: A) { ... }
//   [export] [async] law [proved] name<T>(a: A): R => e;  ->  [export] const name = [async ]<T>(a: A): R => e;
//
// Only the head of a declaration changes, so the end of an arrow body is left to the TypeScript parser. A declaration is
// found the way the compiler finds one (`parser.ts`: `scanLawDeclarationStart`): `law name(` or `law name<`, or
// `law proved name(`, with the names on the line of `law`. Everything else named `law` is left alone.

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$‌‍]/u;

/**
 * Splits `text` into the tokens the law finder needs: identifiers, single punctuation characters (and `=>`), and one
 * opaque token for each string, number, template piece and regular expression. Comments are skipped.
 * @returns {{k: 'id' | 'p' | 'x', t: string, s: number, e: number, nl: boolean}[]}
 */
function lex(text) {
  const tokens = [];
  const n = text.length;
  const templates = [];
  let depth = 0;
  let nl = false;
  let i = 0;
  const push = (k, s, e) => {
    tokens.push({ k, t: text.slice(s, e), s, e, nl });
    nl = false;
  };
  const scanTemplate = (from) => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '`') return { end: j + 1, open: false };
      else if (c === '$' && text[j + 1] === '{') return { end: j + 2, open: true };
      else j++;
    }
    return { end: n, open: false };
  };
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (prev === undefined) return true;
    if (prev.k === 'id') return KEYWORDS_BEFORE_EXPRESSION.has(prev.t);
    if (prev.k === 'x') return false;
    return !(prev.t === ')' || prev.t === ']' || prev.t === '}');
  };
  while (i < n) {
    const c = text[i];
    if (c === '\n' || c === '\r' || c === ' ' || c === ' ') {
      nl = true;
      i++;
    } else if (c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === ' ' || c === '﻿') i++;
    else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      if (/[\r\n]/.test(text.slice(i, stop))) nl = true;
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      push('x', i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
    } else if (c === '`') {
      const r = scanTemplate(i + 1);
      push('x', i, r.end);
      if (r.open) templates.push(depth);
      i = r.end;
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') j += 2;
        else {
          if (text[j] === '[') inClass = true;
          else if (text[j] === ']') inClass = false;
          else if (text[j] === '/' && !inClass) break;
          j++;
        }
      }
      j = Math.min(j + 1, n);
      while (j < n && ID_PART.test(text[j])) j++;
      push('x', i, j);
      i = j;
    } else if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      push('x', i, j);
      i = j;
    } else if (ID_START.test(c) || (c === '\\' && text[i + 1] === 'u')) {
      let j = i + 1;
      while (j < n && (ID_PART.test(text[j]) || text[j] === '\\')) j++;
      push('id', i, j);
      i = j;
    } else if (c === '=' && text[i + 1] === '>') {
      push('p', i, i + 2);
      i += 2;
    } else if (c === '}' && templates.length > 0 && templates[templates.length - 1] === depth) {
      templates.pop();
      const r = scanTemplate(i + 1);
      push('x', i, r.end);
      if (r.open) templates.push(depth);
      i = r.end;
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      push('p', i, i + 1);
      i++;
    }
  }
  return tokens;
}

const OPEN = { '(': ')', '[': ']', '{': '}' };

/** Index of the token after the group that opens at `i` (`(`, `[` or `{`), or -1 when it never closes. */
function skipGroup(tokens, i) {
  const stack = [];
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.k !== 'p') continue;
    if (OPEN[t.t] !== undefined) stack.push(OPEN[t.t]);
    else if (t.t === ')' || t.t === ']' || t.t === '}') {
      if (stack.pop() !== t.t) return -1;
      if (stack.length === 0) return j + 1;
    }
  }
  return -1;
}

/** Index of the token after the type parameter list that opens at `i` (a `<`), or -1. `=>` is not a closer. */
function skipAngles(tokens, i) {
  let depth = 0;
  const stack = [];
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.k !== 'p') continue;
    if (t.t === '<' && stack.length === 0) depth++;
    else if (t.t === '>' && stack.length === 0 && --depth === 0) return j + 1;
    else if (OPEN[t.t] !== undefined) stack.push(OPEN[t.t]);
    else if (t.t === ')' || t.t === ']' || t.t === '}') stack.pop();
  }
  return -1;
}

const TYPE_OPERATORS = new Set([':', '|', '&', '<', ',', '(', '=>', '?', '[']);

/**
 * After the parameter list: is the body `=> expression` (true), a block (false), or neither (undefined)? A return type
 * may hold braces (`{ a: number }`) and arrows (`(a) => b`), so those are skipped before the body is looked for.
 */
function bodyForm(tokens, i) {
  const first = tokens[i];
  if (first === undefined) return undefined;
  if (first.t === '=>') return true;
  if (first.t === '{') return false;
  if (first.t !== ':') return undefined;
  let angles = 0;
  let functionType = false;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j];
    const prev = tokens[j - 1];
    if (t.k !== 'p') continue;
    if (t.t === '<') angles++;
    else if (t.t === '>') angles--;
    else if (t.t === '(' || t.t === '[' || t.t === '{') {
      if (t.t === '{' && angles === 0 && !TYPE_OPERATORS.has(prev.t)) return false;
      if (t.t === '(' && angles === 0 && TYPE_OPERATORS.has(prev.t)) functionType = true;
      const after = skipGroup(tokens, j);
      if (after < 0) return undefined;
      j = after - 1;
    } else if (t.t === '=>' && angles === 0) {
      if (functionType) functionType = false;
      else return true;
    } else if (t.t === ';') return undefined;
  }
  return undefined;
}

const STATEMENT_ENDS = new Set([';', '{', '}']);

/**
 * Finds the law declarations of `text` and the edits that make them TypeScript.
 * @param {string} text
 * @returns {{edits: {start: number, end: number, text: string}[], laws: {start: number, name: string, nameStart: number, nameEnd: number, proved: boolean, arrow: boolean, async: boolean}[]}}
 */
function transformLaws(text) {
  const edits = [];
  const laws = [];
  if (!/\blaw\b/.test(text)) return { edits, laws };
  const tokens = lex(text);
  for (let i = 0; i < tokens.length; i++) {
    const law = tokens[i];
    if (law.k !== 'id' || law.t !== 'law') continue;
    const before = tokens[i - 1];
    if (before !== undefined && before.t === '.') continue;
    // The statement starts at `async` when it precedes `law`; `export` may come before either.
    const isAsync = before !== undefined && before.t === 'async' && before.k === 'id';
    const head = isAsync ? before : law;
    const beforeHead = tokens[i - (isAsync ? 2 : 1)];
    if (!(head.nl || beforeHead === undefined || STATEMENT_ENDS.has(beforeHead.t) || beforeHead.t === 'export'))
      continue;
    // `law name(`, `law name<`, `law proved name(`, `law proved name<` (and `law proved(`, a law named proved).
    let at = i + 1;
    const first = tokens[at];
    if (first === undefined || first.k !== 'id' || first.nl) continue;
    let name = first;
    let proved = false;
    const second = tokens[at + 1];
    if (first.t === 'proved' && second !== undefined && second.k === 'id' && !second.nl) {
      name = second;
      proved = true;
      at++;
    }
    const open = tokens[at + 1];
    if (open === undefined || open.k !== 'p' || !(open.t === '(' || open.t === '<')) continue;
    // An unfinished declaration (still being typed) is rewritten as a block law; the type checker reports what is missing.
    let paren = at + 1;
    if (open.t === '<') paren = skipAngles(tokens, paren);
    const afterParams = paren >= 0 && tokens[paren]?.t === '(' ? skipGroup(tokens, paren) : -1;
    const arrow = afterParams >= 0 && bodyForm(tokens, afterParams) === true;
    if (arrow) {
      edits.push({ start: head.s, end: name.s, text: 'const ' });
      edits.push({ start: name.e, end: name.e, text: isAsync ? ' = async ' : ' = ' });
    } else {
      edits.push({ start: law.s, end: name.s, text: 'function ' });
    }
    laws.push({ start: law.s, name: name.t, nameStart: name.s, nameEnd: name.e, proved, arrow, async: isAsync });
  }
  return { edits, laws };
}

/** @param {string} text @param {{start: number, end: number, text: string}[]} edits sorted, not overlapping */
function applyEdits(text, edits) {
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

/**
 * Converts offsets between a text and its rewrite. `bias` says which side a boundary belongs to: a range's `start` is
 * after a zero-width insertion at that offset, its `end` before it; an offset inside replaced text goes to the start
 * of the replacement for a `start` and to its end for an `end`.
 */
class PositionMap {
  /** @param {{start: number, end: number, text: string}[]} edits */
  constructor(edits) {
    this.edits = edits;
    let delta = 0;
    this.spans = edits.map((e) => {
      const newStart = e.start + delta;
      delta += e.text.length - (e.end - e.start);
      return { oldStart: e.start, oldEnd: e.end, newStart, newEnd: newStart + e.text.length };
    });
  }

  get identity() {
    return this.spans.length === 0;
  }

  /** @param {number} offset in the original text @param {'start' | 'end'} [bias] */
  toNew(offset, bias = 'start') {
    let delta = 0;
    for (const s of this.spans) {
      if (offset < s.oldStart) break;
      if (s.oldEnd === s.oldStart) {
        if (offset === s.oldStart) return bias === 'end' ? s.newStart : s.newEnd;
      } else if (offset <= s.oldEnd) {
        if (offset === s.oldStart) return s.newStart;
        if (offset === s.oldEnd) return s.newEnd;
        return bias === 'end' ? s.newEnd : s.newStart;
      }
      delta = s.newEnd - s.oldEnd;
    }
    return offset + delta;
  }

  /** @param {number} offset in the rewritten text @param {'start' | 'end'} [bias] */
  toOriginal(offset, bias = 'start') {
    let delta = 0;
    for (const s of this.spans) {
      if (offset < s.newStart) break;
      if (offset <= s.newEnd) {
        if (offset === s.newStart) return s.oldStart;
        if (offset === s.newEnd) return s.oldEnd;
        return bias === 'end' ? s.oldEnd : s.oldStart;
      }
      delta = s.oldEnd - s.newEnd;
    }
    return offset + delta;
  }

  /** A span `{start, length}` of the original, as one of the rewrite. */
  spanToNew(span) {
    const start = this.toNew(span.start, 'start');
    const end = this.toNew(span.start + span.length, 'end');
    return { start, length: Math.max(0, end - start) };
  }

  /** A span `{start, length}` of the rewrite, as one of the original. */
  spanToOriginal(span) {
    const start = this.toOriginal(span.start, 'start');
    const end = this.toOriginal(span.start + span.length, 'end');
    return { start, length: Math.max(0, end - start) };
  }
}

/** The rewrite of `text` and its map, or null when there is no law declaration in it. */
function rewrite(text) {
  const { edits, laws } = transformLaws(text);
  if (edits.length === 0) return null;
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  return { text: applyEdits(text, edits), map: new PositionMap(edits), laws };
}

module.exports = { lex, transformLaws, applyEdits, PositionMap, rewrite };
