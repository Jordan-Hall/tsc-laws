// Symbol functions of tsc-ts's public API.

import type { Symbol } from './types.js';

/** The prefix of tsc-ts's internal symbol names (`internalSymbolNamePrefix` in compiler/symbol.ts). */
export const internalNamePrefix = '￾';

/**
 * The name of `symbol`, as TypeScript 7's API gives it: internal names start with `__` (`__call`,
 * `__type`, `__object`), and `default`, `export=`, `this` and `module.exports` are written as they are.
 */
export function symbolName(symbol: Symbol): string {
  const name = (symbol as unknown as { readonly name: string }).name;
  return name.startsWith(internalNamePrefix) ? '__' + name.substring(1) : name;
}
