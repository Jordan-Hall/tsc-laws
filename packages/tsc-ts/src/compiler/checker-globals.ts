// Lazily resolved global types from the libraries.
import type { Checker } from './checker.js';
import type { Type } from './checker-types.js';
import { createTypeFromGenericGlobalType } from './checker-type-factory.js';
import { getCachedGlobalType } from './checker-symbols.js';

export function getGlobalESSymbolType(c: Checker): Type {
  return getCachedGlobalType(c, 'Symbol', 0, false);
}

export function getGlobalBigIntType(c: Checker): Type {
  return getCachedGlobalType(c, 'BigInt', 0, false);
}

export function getGlobalPromiseType(c: Checker): Type {
  return getCachedGlobalType(c, 'Promise', 1, false);
}

export function getGlobalPromiseLikeType(c: Checker): Type {
  return getCachedGlobalType(c, 'PromiseLike', 1, true);
}

export function getGlobalTemplateStringsArrayType(c: Checker): Type {
  return getCachedGlobalType(c, 'TemplateStringsArray', 0, true);
}

export function getGlobalIterableType(c: Checker): Type {
  return getCachedGlobalType(c, 'Iterable', 3, false);
}

export function getGlobalIterableIteratorType(c: Checker): Type {
  return getCachedGlobalType(c, 'IterableIterator', 3, false);
}

export function getGlobalGeneratorType(c: Checker): Type {
  return getCachedGlobalType(c, 'Generator', 3, false);
}

export function getGlobalAsyncGeneratorType(c: Checker): Type {
  return getCachedGlobalType(c, 'AsyncGenerator', 3, false);
}

export function createPromiseType(c: Checker, promisedType: Type): Type {
  const globalPromiseType = getGlobalPromiseType(c);
  return globalPromiseType !== c.emptyGenericType
    ? createTypeFromGenericGlobalType(c, globalPromiseType, [promisedType])
    : c.unknownType;
}
