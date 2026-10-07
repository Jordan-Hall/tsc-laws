import { CharacterCodes } from './character-codes.js';

/**
 * Converts a bigint literal without its `n` suffix (`0b101`, `0o17`, `0xff`, `007`)
 * to its decimal digits.
 */
export function parsePseudoBigInt(literal: string): string {
  let log2Base: number;
  switch (literal.length > 1 ? literal.charCodeAt(1) : 0) {
    case CharacterCodes.b:
    case CharacterCodes.B:
      log2Base = 1;
      break;
    case CharacterCodes.o:
    case CharacterCodes.O:
      log2Base = 3;
      break;
    case CharacterCodes.x:
    case CharacterCodes.X:
      log2Base = 4;
      break;
    default: {
      let start = 0;
      while (start < literal.length && literal.charCodeAt(start) === CharacterCodes._0) start++;
      return start === literal.length ? '0' : literal.substring(start);
    }
  }
  // Pack the digits into 16-bit segments, then repeatedly divide by 10.
  const bits = (literal.length - 2) * log2Base;
  const segments = new Uint16Array((bits >>> 4) + ((bits & 15) !== 0 ? 1 : 0) + 1);
  for (let i = literal.length - 1, bitOffset = 0; i >= 2; i--, bitOffset += log2Base) {
    const segment = bitOffset >>> 4;
    const ch = literal.charCodeAt(i);
    const digit =
      ch <= CharacterCodes._9
        ? ch - CharacterCodes._0
        : 10 + ch - (ch <= CharacterCodes.F ? CharacterCodes.A : CharacterCodes.a);
    const shifted = digit << (bitOffset & 15);
    segments[segment] |= shifted;
    const residual = shifted >>> 16;
    if (residual !== 0) segments[segment + 1] |= residual;
  }
  let result = '';
  let firstNonZero = segments.length - 1;
  let remaining = true;
  while (remaining) {
    let mod10 = 0;
    remaining = false;
    for (let segment = firstNonZero; segment >= 0; segment--) {
      const value = (mod10 << 16) | segments[segment];
      const quotient = (value / 10) | 0;
      segments[segment] = quotient;
      mod10 = value - quotient * 10;
      if (quotient !== 0 && !remaining) {
        firstNonZero = segment;
        remaining = true;
      }
    }
    result = String.fromCharCode(CharacterCodes._0 + mod10) + result;
  }
  return result;
}
