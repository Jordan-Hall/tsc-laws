function toLower(ch: number): number {
  if (ch < 0x80) return ch >= 0x41 && ch <= 0x5a ? ch + 0x20 : ch;
  const lower = String.fromCodePoint(ch).toLowerCase();
  return lower.length === 0 ? ch : lower.codePointAt(0)!;
}

/** The code points of a string and their lowercase forms, in arrays reused from one string to the next. */
export class CodePoints {
  codes = new Int32Array(16);
  lower = new Int32Array(16);
  length = 0;

  /** Takes the code points of `text`. */
  set(text: string): void {
    if (this.codes.length < text.length) {
      this.codes = new Int32Array(text.length * 2);
      this.lower = new Int32Array(text.length * 2);
    }
    let n = 0;
    for (let i = 0; i < text.length;) {
      const ch = text.codePointAt(i)!;
      this.codes[n] = ch;
      this.lower[n] = toLower(ch);
      n++;
      i += ch >= 0x10000 ? 2 : 1;
    }
    this.length = n;
  }
}

/** The candidate of the current comparison; a nested search compares its own candidates before it is set. */
const candidateCodePoints = new CodePoints();
let previousRow = new Float64Array(32);
let currentRow = new Float64Array(32);

/** Levenshtein distance where a case-only substitution costs 0.1; -1 if above `max`. */
function levenshteinWithMax(s1: CodePoints, s2: CodePoints, max: number): number {
  const length2 = s2.length;
  if (previousRow.length <= length2) {
    previousRow = new Float64Array(length2 * 2 + 1);
    currentRow = new Float64Array(length2 * 2 + 1);
  }
  let previous = previousRow;
  let current = currentRow;
  for (let i = 0; i <= length2; i++) previous[i] = i;
  const big = max + 0.01;
  for (let i = 1; i <= s1.length; i++) {
    const c1 = s1.codes[i - 1]!;
    const lower1 = s1.lower[i - 1]!;
    const minJ = Math.max(Math.ceil(i - max), 1);
    const maxJ = Math.min(Math.floor(max + i), length2);
    let colMin = i;
    current[0] = i;
    for (let j = 1; j < minJ; j++) current[j] = big;
    for (let j = minJ; j <= maxJ; j++) {
      let dist = previous[j - 1]!;
      if (c1 !== s2.codes[j - 1]) {
        const substitution = dist + (lower1 === s2.lower[j - 1] ? 0.1 : 2);
        dist = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
      }
      current[j] = dist;
      colMin = Math.min(colMin, dist);
    }
    for (let j = maxJ + 1; j <= length2; j++) current[j] = big;
    if (colMin > max) return -1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  const result = previous[length2]!;
  return result > max ? -1 : result;
}

/** The distance from `name` to `candidate` (levenshteinWithMax), -1 if above `max`. */
export function distanceToCandidate(name: CodePoints, candidate: string, max: number): number {
  candidateCodePoints.set(candidate);
  return levenshteinWithMax(name, candidateCodePoints, max);
}

/** The candidate closest to `name` by edit distance, or `''`; ties go to the lexicographically smaller. */
export function getSpellingSuggestion(name: string, candidates: readonly string[]): string {
  const nameCodePoints = new CodePoints();
  nameCodePoints.set(name);
  const maximumLengthDifference = Math.max(2, Math.floor(nameCodePoints.length * 0.34));
  let bestDistance = Math.floor(nameCodePoints.length * 0.4) + 0.9;
  let best = '';
  let hasBest = false;
  const lowerName = name.toLowerCase();
  for (const candidate of candidates) {
    const maxLength = Math.max(candidate.length, nameCodePoints.length);
    const minLength = Math.min(candidate.length, nameCodePoints.length);
    if (candidate === '' || maxLength - minLength > maximumLengthDifference || candidate === name) continue;
    // Short candidates only count when they differ by case.
    if (candidate.length < 3 && candidate.toLowerCase() !== lowerName) continue;
    const distance = distanceToCandidate(nameCodePoints, candidate, bestDistance);
    if (distance < 0) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      hasBest = true;
    } else if (!hasBest || candidate < best) {
      best = candidate;
      hasBest = true;
    }
  }
  return best;
}

/** The length of `s` in UTF-8 bytes. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch < 0x80) n += 1;
    else if (ch < 0x800) n += 2;
    else if (ch >= 0xd800 && ch <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
