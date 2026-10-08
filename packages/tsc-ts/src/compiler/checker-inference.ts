// Type inference. Not ported yet: callers fall back to permissive results.
import type { Checker } from './checker.js';
import type { ConditionalRoot, Type, TypeMapper } from './checker-types.js';

/**
 * A mapper from a conditional type's `infer` type parameters to their inferences, or undefined
 * when inference isn't available.
 */
export function inferTypesForConditional(
  _c: Checker,
  _root: ConditionalRoot,
  _checkType: Type,
  _extendsType: Type,
  _mapper: TypeMapper | undefined,
  _checkTypeDeferred: boolean,
): TypeMapper | undefined {
  return undefined;
}
