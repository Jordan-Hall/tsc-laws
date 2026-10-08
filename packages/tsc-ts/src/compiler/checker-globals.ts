// Lazily resolved global types from the libraries.
import type { Checker } from './checker.js';
import type { Type } from './checker-types.js';
import { getCachedGlobalType } from './checker-symbols.js';

export function getGlobalESSymbolType(c: Checker): Type {
  return getCachedGlobalType(c, 'Symbol', 0, false);
}

export function getGlobalBigIntType(c: Checker): Type {
  return getCachedGlobalType(c, 'BigInt', 0, false);
}

export function getGlobalTemplateStringsArrayType(c: Checker): Type {
  return getCachedGlobalType(c, 'TemplateStringsArray', 0, true);
}
