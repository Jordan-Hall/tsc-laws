export function codePoints(text: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < text.length;) {
    const ch = text.codePointAt(i)!;
    result.push(ch);
    i += ch >= 0x10000 ? 2 : 1;
  }
  return result;
}

function toLower(ch: number): number {
  if (ch < 0x80) return ch >= 0x41 && ch <= 0x5a ? ch + 0x20 : ch;
  const lower = String.fromCodePoint(ch).toLowerCase();
  return lower.length === 0 ? ch : lower.codePointAt(0)!;
}

// Levenshtein distance where a case-only substitution costs 0.1; -1 if above `max`.
export function levenshteinWithMax(s1: number[], s2: number[], max: number): number {
  let previous = new Float64Array(s2.length + 1);
  let current = new Float64Array(s2.length + 1);
  for (let i = 0; i <= s2.length; i++) previous[i] = i;
  const big = max + 0.01;
  for (let i = 1; i <= s1.length; i++) {
    const c1 = s1[i - 1]!;
    const lower1 = toLower(c1);
    const minJ = Math.max(Math.ceil(i - max), 1);
    const maxJ = Math.min(Math.floor(max + i), s2.length);
    let colMin = i;
    current[0] = i;
    for (let j = 1; j < minJ; j++) current[j] = big;
    for (let j = minJ; j <= maxJ; j++) {
      const c2 = s2[j - 1]!;
      let dist = previous[j - 1];
      if (c1 !== c2) {
        const substitution = dist + (lower1 === toLower(c2) ? 0.1 : 2);
        dist = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      }
      current[j] = dist;
      colMin = Math.min(colMin, dist);
    }
    for (let j = maxJ + 1; j <= s2.length; j++) current[j] = big;
    if (colMin > max) return -1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  const result = previous[s2.length];
  return result > max ? -1 : result;
}

/** The candidate closest to `name` by edit distance, or `''`; ties go to the lexicographically smaller. */
export function getSpellingSuggestion(name: string, candidates: readonly string[]): string {
  const nameCodePoints = codePoints(name);
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
    const distance = levenshteinWithMax(nameCodePoints, codePoints(candidate), bestDistance);
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
