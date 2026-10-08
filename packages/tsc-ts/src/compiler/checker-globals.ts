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

export function getGlobalTypedPropertyDescriptorType(c: Checker): Type {
  return getCachedGlobalType(c, 'TypedPropertyDescriptor', 1, true);
}

export function getGlobalClassDecoratorContextType(c: Checker): Type {
  return getCachedGlobalType(c, 'ClassDecoratorContext', 1, true);
}

export function getGlobalClassMethodDecoratorContextType(c: Checker): Type {
  return getCachedGlobalType(c, 'ClassMethodDecoratorContext', 2, true);
}

export function getGlobalClassGetterDecoratorContextType(c: Checker): Type {
  return getCachedGlobalType(c, 'ClassGetterDecoratorContext', 2, true);
}

export function getGlobalClassSetterDecoratorContextType(c: Checker): Type {
  return getCachedGlobalType(c, 'ClassSetterDecoratorContext', 2, true);
}

export function getGlobalClassAccessorDecoratorContextType(c: Checker): Type {
  return getCachedGlobalType(c, 'ClassAccessorDecoratorContext', 2, true);
}

export function getGlobalClassAccessorDecoratorTargetType(c: Checker): Type {
  return getCachedGlobalType(c, 'ClassAccessorDecoratorTarget', 2, true);
}

export function getGlobalClassAccessorDecoratorResultType(c: Checker): Type {
  return getCachedGlobalType(c, 'ClassAccessorDecoratorResult', 2, true);
}

export function getGlobalClassFieldDecoratorContextType(c: Checker): Type {
  return getCachedGlobalType(c, 'ClassFieldDecoratorContext', 2, true);
}
