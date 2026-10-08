// Object literal types: freshness and regular forms.
import type { Checker } from './checker.js';
import { CheckFlags, type Symbol } from './symbol.js';
import { ObjectFlags, type Type, TypeFlags } from './checker-types.js';
import { createAnonymousType } from './checker-type-factory.js';
import { getPropertiesOfObjectType, resolveStructuredTypeMembers } from './checker-members.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { getLiteralTypeFromProperty } from './checker-type-operators.js';

/** The non-fresh form of an object literal type, with nested object literals regular too. */
export function getRegularTypeOfObjectLiteral(c: Checker, t: Type): Type {
  if (
    (t.objectFlags & ObjectFlags.ObjectLiteral) === 0 ||
    (t.objectFlags & ObjectFlags.FreshLiteral) === 0 ||
    (t.flags & TypeFlags.Object) === 0
  )
    return t;
  const key = 'regularObjectLiteral' + t.id;
  const cached = c.cachedTypes.get(key);
  if (cached !== undefined) return cached;
  const resolved = resolveStructuredTypeMembers(c, t);
  const members = new Map<string, Symbol>();
  for (const prop of getPropertiesOfObjectType(c, t)) {
    const original = getTypeOfSymbol(c, prop);
    const updated = getRegularTypeOfObjectLiteral(c, original);
    members.set(prop.name, updated === original ? prop : createSymbolWithTypeLocal(c, prop, updated));
  }
  const regular = createAnonymousType(
    c,
    t.symbol,
    members,
    resolved.callSignatures,
    resolved.constructSignatures,
    resolved.indexInfos,
  );
  regular.flags = resolved.flags;
  regular.objectFlags |= resolved.objectFlags & ~ObjectFlags.FreshLiteral;
  c.cachedTypes.set(key, regular);
  return regular;
}

function createSymbolWithTypeLocal(c: Checker, source: Symbol, t: Type): Symbol {
  const symbol = c.newSymbolWithCheckFlags(source.flags, source.name, source.checkFlags & CheckFlags.Readonly);
  symbol.declarations = source.declarations;
  symbol.parent = source.parent;
  symbol.valueDeclaration = source.valueDeclaration;
  const links = c.symbolLinks(symbol);
  links.type = t;
  links.target = source;
  links.nameType = c.symbolLinks(source).nameType;
  return symbol;
}

export function getLiteralTypeFromPropertyForRelations(
  c: Checker,
  prop: Symbol,
  include: TypeFlags,
  includeNonPublic: boolean,
): Type {
  return getLiteralTypeFromProperty(c, prop, include, includeNonPublic);
}
