// Object literals: their types, computed members and spreads.
import {
  type Node,
  type PropertyAssignment,
  type ShorthandPropertyAssignment,
  ModifierFlags,
  getExpression,
  getName,
  getProperties,
  getSymbol,
  getText,
  getType,
} from './ast.js';
import { isAssignmentTarget } from './binder-utilities.js';
import { createDiagnosticForNode, type Checker } from './checker.js';
import { Diagnostics } from './diagnostics.js';
import { CheckFlags, type Symbol, SymbolFlags, internalSymbolNamePrefix } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { CheckMode, IndexInfo, ObjectFlags, type Type, TypeFlags } from './checker-types.js';
import {
  checkCrossProductUnion,
  createAnonymousType,
  getIntersectionType,
  getUnionType,
  getUnionTypeEx,
  isErrorType,
  mapType,
  typesOf,
  UnionReduction,
} from './checker-type-factory.js';
import {
  getDeclarationModifierFlagsFromSymbol,
  getIndexInfoOfType,
  getIndexInfosOfType,
  getIndexTypeOfType,
  getPropertiesOfType,
  getReducedType,
} from './checker-members.js';
import { getMergedSymbol, getSymbolOfDeclaration } from './checker-symbols.js';
import { addOptionality, getTypeOfSymbol, removeMissingOrUndefinedType } from './checker-symbol-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import { isGenericMappedType, isGenericObjectType, isTypeAssignableToKindEx } from './checker-type-operators.js';
import { isTypeAssignableTo } from './relations.js';
import { getPropertyNameFromType, isNumericLiteralName, isTypeUsableAsPropertyName } from './checker-utilities.js';
import { getSpreadSymbol, isSpreadableProperty, isValidSpreadType, hasDefaultValue } from './checker-destructuring.js';
import {
  checkComputedPropertyName,
  checkExpressionEx,
  checkExpressionForMutableLocation,
  checkTypeAssignableToAndOptionallyElaborate,
  isConstContext,
} from './checker-expressions.js';
import { checkFunctionExpressionOrObjectLiteralMethod, getTypeOfObjectLiteralMethod } from './checker-functions.js';
import { isEmptyObjectType } from './checker-type-factory.js';

/** Builds the type of the members collected since the last spread. */
class ObjectLiteralBuilder {
  readonly node: Node;
  readonly inDestructuringPattern: boolean;
  members = new Map<string, Symbol>();
  /** Members in order, including those with computed names that only feed index signatures. */
  properties: Symbol[] = [];
  objectFlags = ObjectFlags.FreshLiteral;
  patternWithComputedProperties = false;
  hasComputedString = false;
  hasComputedNumber = false;
  hasComputedSymbol = false;
  /** Where the members since the last spread start in `properties`. */
  offset = 0;

  constructor(node: Node, inDestructuringPattern: boolean) {
    this.node = node;
    this.inDestructuringPattern = inDestructuringPattern;
  }

  createType(c: Checker): Type {
    const indexInfos: IndexInfo[] = [];
    const isReadonly = isConstContext(this.node);
    const properties = this.properties.slice(this.offset);
    if (this.hasComputedString) indexInfos.push(getObjectLiteralIndexInfo(c, isReadonly, properties, c.stringType));
    if (this.hasComputedNumber) indexInfos.push(getObjectLiteralIndexInfo(c, isReadonly, properties, c.numberType));
    if (this.hasComputedSymbol) indexInfos.push(getObjectLiteralIndexInfo(c, isReadonly, properties, c.esSymbolType));
    const result = createAnonymousType(c, getSymbol(this.node), this.members, [], [], indexInfos);
    result.objectFlags |= this.objectFlags | ObjectFlags.ObjectLiteral | ObjectFlags.ContainsObjectOrArrayLiteral;
    if (this.patternWithComputedProperties)
      result.objectFlags |= ObjectFlags.ObjectLiteralPatternWithComputedProperties;
    return result;
  }

  reset(): void {
    this.members = new Map<string, Symbol>();
    this.properties = [];
    this.offset = 0;
    this.hasComputedString = false;
    this.hasComputedNumber = false;
    this.hasComputedSymbol = false;
  }
}

export function checkObjectLiteral(c: Checker, node: Node, checkMode: CheckMode): Type {
  const inDestructuringPattern = isAssignmentTarget(node);
  const allProperties = c.strictNullChecks ? new Map<string, Symbol>() : undefined;
  const inConstContext = isConstContext(node);
  const checkFlags = inConstContext ? CheckFlags.Readonly : 0;
  const builder = new ObjectLiteralBuilder(node, inDestructuringPattern);
  let spread: Type = c.emptyObjectType;
  const elements = getProperties(node)!.nodes;
  // Computed names are checked up front: a spread may bail out before the member is reached.
  for (const e of elements) {
    const name = getName(e);
    if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, name);
  }
  for (const memberDecl of elements) {
    let member = getSymbolOfDeclaration(c, memberDecl);
    const name = getName(memberDecl);
    const computedNameType =
      name !== undefined && name.kind === SyntaxKind.ComputedPropertyName
        ? checkComputedPropertyName(c, name)
        : undefined;
    if (
      memberDecl.kind === SyntaxKind.PropertyAssignment ||
      memberDecl.kind === SyntaxKind.ShorthandPropertyAssignment ||
      memberDecl.kind === SyntaxKind.MethodDeclaration
    ) {
      let t: Type;
      if (memberDecl.kind === SyntaxKind.PropertyAssignment)
        t = checkPropertyAssignment(c, memberDecl as PropertyAssignment, checkMode);
      else if (memberDecl.kind === SyntaxKind.ShorthandPropertyAssignment)
        t = checkShorthandPropertyAssignment(
          c,
          memberDecl as ShorthandPropertyAssignment,
          inDestructuringPattern,
          checkMode,
        );
      else t = getTypeOfObjectLiteralMethod(c, memberDecl, checkMode);
      if (member === undefined) continue;
      builder.objectFlags |= t.objectFlags & ObjectFlags.PropagatingFlags;
      const nameType =
        computedNameType !== undefined && isTypeUsableAsPropertyName(computedNameType) ? computedNameType : undefined;
      const prop = c.newSymbolWithCheckFlags(
        SymbolFlags.Property | member.flags,
        nameType !== undefined ? getPropertyNameFromType(nameType) : member.name,
        checkFlags | (nameType !== undefined ? CheckFlags.Late : 0),
      );
      const links = c.symbolLinks(prop);
      if (nameType !== undefined) links.nameType = nameType;
      // Defaults in assignment patterns make the property optional.
      if (inDestructuringPattern && hasDefaultValue(memberDecl)) prop.flags |= SymbolFlags.Optional;
      prop.declarations = member.declarations;
      prop.parent = member.parent;
      prop.valueDeclaration = member.valueDeclaration;
      links.type = t;
      links.target = member;
      member = prop;
      if (allProperties !== undefined) allProperties.set(prop.name, prop);
    } else if (memberDecl.kind === SyntaxKind.SpreadAssignment) {
      if (builder.properties.length > 0) {
        spread = getSpreadType(c, spread, builder.createType(c), getSymbol(node), builder.objectFlags, inConstContext);
        builder.reset();
      }
      const t = getReducedType(c, checkExpressionEx(c, getExpression(memberDecl)!, checkMode & CheckMode.Inferential));
      if (isValidSpreadType(c, t)) {
        const mergedType = tryMergeUnionOfObjectTypeAndEmptyObject(c, t, inConstContext);
        if (allProperties !== undefined) checkSpreadPropOverrides(c, mergedType, allProperties, memberDecl);
        builder.offset = builder.properties.length;
        if (isErrorType(c, spread)) continue;
        spread = getSpreadType(c, spread, mergedType, getSymbol(node), builder.objectFlags, inConstContext);
      } else {
        c.error(memberDecl, Diagnostics.Spread_types_may_only_be_created_from_object_types);
        spread = c.errorType;
      }
      continue;
    } else {
      // Accessors are checked like functions.
      checkFunctionExpressionOrObjectLiteralMethod(c, memberDecl, checkMode);
      if (member === undefined) continue;
      member = getMergedSymbol(c, member);
    }
    if (computedNameType !== undefined && (computedNameType.flags & TypeFlags.StringOrNumberLiteralOrUnique) === 0) {
      if (isTypeAssignableTo(c, computedNameType, c.stringNumberSymbolType)) {
        if (isTypeAssignableTo(c, computedNameType, c.numberType)) builder.hasComputedNumber = true;
        else if (isTypeAssignableTo(c, computedNameType, c.esSymbolType)) builder.hasComputedSymbol = true;
        else builder.hasComputedString = true;
        if (inDestructuringPattern) builder.patternWithComputedProperties = true;
      }
    } else builder.members.set(member.name, member);
    builder.properties.push(member);
  }
  if (isErrorType(c, spread)) return c.errorType;
  if (spread !== c.emptyObjectType) {
    if (builder.properties.length > 0) {
      spread = getSpreadType(c, spread, builder.createType(c), getSymbol(node), builder.objectFlags, inConstContext);
      builder.reset();
    }
    // The raw empty object fed in at the start becomes a fresh empty literal unique to this site.
    return mapType(c, spread, (t) => (t === c.emptyObjectType ? builder.createType(c) : t));
  }
  return builder.createType(c);
}

function checkPropertyAssignment(c: Checker, node: PropertyAssignment, _checkMode: CheckMode): Type {
  if (node.name.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, node.name);
  const initializerType = checkExpressionForMutableLocation(c, node.initializer);
  const typeNode = getType(node);
  if (typeNode === undefined) return initializerType;
  const t = getTypeFromTypeNode(c, typeNode);
  checkTypeAssignableToAndOptionallyElaborate(c, initializerType, t, node, node.initializer);
  return t;
}

function checkShorthandPropertyAssignment(
  c: Checker,
  node: ShorthandPropertyAssignment,
  inDestructuringPattern: boolean,
  _checkMode: CheckMode,
): Type {
  const expr = (inDestructuringPattern ? undefined : node.objectAssignmentInitializer) ?? node.name;
  const expressionType = checkExpressionForMutableLocation(c, expr);
  const typeNode = getType(node);
  if (typeNode === undefined) return expressionType;
  const t = getTypeFromTypeNode(c, typeNode);
  checkTypeAssignableToAndOptionallyElaborate(c, expressionType, t, node, expr);
  return t;
}

function getObjectLiteralIndexInfo(c: Checker, isReadonly: boolean, properties: Symbol[], keyType: Type): IndexInfo {
  const propTypes: Type[] = [];
  const components: Node[] = [];
  for (const prop of properties) {
    if (
      (keyType === c.stringType && !isSymbolWithSymbolName(c, prop)) ||
      (keyType === c.numberType && isSymbolWithNumericName(c, prop)) ||
      (keyType === c.esSymbolType && isSymbolWithSymbolName(c, prop))
    ) {
      propTypes.push(getTypeOfSymbol(c, prop));
      if (isSymbolWithComputedName(prop)) components.push(prop.declarations[0]);
    }
  }
  const unionType =
    propTypes.length !== 0
      ? getUnionTypeEx(c, propTypes, UnionReduction.Subtype, undefined, undefined)
      : c.undefinedType;
  return new IndexInfo(keyType, unionType, isReadonly, undefined, components);
}

function getFirstDeclarationName(symbol: Symbol): Node | undefined {
  return symbol.declarations.length !== 0 ? getName(symbol.declarations[0]) : undefined;
}

function isSymbolWithSymbolName(c: Checker, symbol: Symbol): boolean {
  if (symbol.name.startsWith(internalSymbolNamePrefix + '@')) return true;
  const name = getFirstDeclarationName(symbol);
  return (
    name !== undefined &&
    name.kind === SyntaxKind.ComputedPropertyName &&
    isTypeAssignableToKindEx(c, checkComputedPropertyName(c, name), TypeFlags.ESSymbol, false)
  );
}

function isSymbolWithNumericName(c: Checker, symbol: Symbol): boolean {
  if (isNumericLiteralName(symbol.name)) return true;
  const name = getFirstDeclarationName(symbol);
  if (name === undefined) return false;
  switch (name.kind) {
    case SyntaxKind.ComputedPropertyName:
      return isTypeAssignableToKindEx(c, checkComputedPropertyName(c, name), TypeFlags.NumberLike, false);
    case SyntaxKind.Identifier:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.StringLiteral:
      return isNumericLiteralName(getText(name));
  }
  return false;
}

function isSymbolWithComputedName(symbol: Symbol): boolean {
  const name = getFirstDeclarationName(symbol);
  return name !== undefined && name.kind === SyntaxKind.ComputedPropertyName;
}

/** Reports earlier properties that a spread always overwrites. */
function checkSpreadPropOverrides(c: Checker, t: Type, props: Map<string, Symbol>, spread: Node): void {
  for (const right of getPropertiesOfType(c, t)) {
    if ((right.flags & SymbolFlags.Optional) !== 0 || (right.checkFlags & CheckFlags.Partial) !== 0) continue;
    const left = props.get(right.name);
    if (left === undefined) continue;
    const diagnostic = c.error(
      left.valueDeclaration,
      Diagnostics.X_0_is_specified_more_than_once_so_this_usage_will_be_overwritten,
      left.name,
    );
    diagnostic.addRelatedInfo(
      createDiagnosticForNode(spread, Diagnostics.This_spread_always_overwrites_this_property, []),
    );
  }
}

// ---- Spread types

/**
 * The type of spreading `right` after `left`. Object literals fold their spreads left to right,
 * with `left` the result so far.
 */
export function getSpreadType(
  c: Checker,
  leftIn: Type,
  rightIn: Type,
  symbol: Symbol | undefined,
  objectFlags: ObjectFlags,
  readonly: boolean,
): Type {
  let left = leftIn;
  let right = rightIn;
  if ((left.flags & TypeFlags.Any) !== 0 || (right.flags & TypeFlags.Any) !== 0) return c.anyType;
  if ((left.flags & TypeFlags.Unknown) !== 0 || (right.flags & TypeFlags.Unknown) !== 0) return c.unknownType;
  if ((left.flags & TypeFlags.Never) !== 0) return right;
  if ((right.flags & TypeFlags.Never) !== 0) return left;
  left = tryMergeUnionOfObjectTypeAndEmptyObject(c, left, readonly);
  if ((left.flags & TypeFlags.Union) !== 0) {
    if (!checkCrossProductUnion(c, [left, right])) return c.errorType;
    const r = right;
    return mapType(c, left, (t) => getSpreadType(c, t, r, symbol, objectFlags, readonly));
  }
  right = tryMergeUnionOfObjectTypeAndEmptyObject(c, right, readonly);
  if ((right.flags & TypeFlags.Union) !== 0) {
    if (!checkCrossProductUnion(c, [left, right])) return c.errorType;
    const l = left;
    return mapType(c, right, (t) => getSpreadType(c, l, t, symbol, objectFlags, readonly));
  }
  if (
    (right.flags &
      (TypeFlags.BooleanLike |
        TypeFlags.NumberLike |
        TypeFlags.BigIntLike |
        TypeFlags.StringLike |
        TypeFlags.EnumLike |
        TypeFlags.NonPrimitive |
        TypeFlags.Index)) !==
    0
  )
    return left;
  if (isGenericObjectType(c, left) || isGenericObjectType(c, right)) {
    if (isEmptyObjectType(c, left)) return right;
    // `T & { a: string }` spread with `{ b: string }` merges into `T & { a: string, b: string }`.
    if ((left.flags & TypeFlags.Intersection) !== 0) {
      const types = typesOf(left);
      const lastLeft = types[types.length - 1];
      if (isNonGenericObjectType(c, lastLeft) && isNonGenericObjectType(c, right)) {
        const newTypes = types.slice();
        newTypes[newTypes.length - 1] = getSpreadType(c, lastLeft, right, symbol, objectFlags, readonly);
        return getIntersectionType(c, newTypes);
      }
    }
    return getIntersectionType(c, [left, right]);
  }
  const members = new Map<string, Symbol>();
  const skippedPrivateMembers = new Set<string>();
  const indexInfos = left === c.emptyObjectType ? getIndexInfosOfType(c, right) : getUnionIndexInfos(c, [left, right]);
  for (const rightProp of getPropertiesOfType(c, right)) {
    if (
      (getDeclarationModifierFlagsFromSymbol(c, rightProp, false) &
        (ModifierFlags.Private | ModifierFlags.Protected)) !==
      0
    )
      skippedPrivateMembers.add(rightProp.name);
    else if (isSpreadableProperty(rightProp)) members.set(rightProp.name, getSpreadSymbol(c, rightProp, readonly));
  }
  for (const leftProp of getPropertiesOfType(c, left)) {
    if (skippedPrivateMembers.has(leftProp.name) || !isSpreadableProperty(leftProp)) continue;
    const rightProp = members.get(leftProp.name);
    if (rightProp === undefined) {
      members.set(leftProp.name, getSpreadSymbol(c, leftProp, readonly));
      continue;
    }
    if ((rightProp.flags & SymbolFlags.Optional) === 0) continue;
    const result = c.newSymbol(SymbolFlags.Property | (leftProp.flags & SymbolFlags.Optional), leftProp.name);
    const links = c.symbolLinks(result);
    // Spreading into the same type is common, as with options bags; skip the subtype reduction then.
    const leftType = getTypeOfSymbol(c, leftProp);
    const leftTypeWithoutUndefined = removeMissingOrUndefinedType(c, leftType);
    const rightTypeWithoutUndefined = removeMissingOrUndefinedType(c, getTypeOfSymbol(c, rightProp));
    links.type =
      leftTypeWithoutUndefined === rightTypeWithoutUndefined
        ? leftType
        : getUnionTypeEx(c, [leftType, rightTypeWithoutUndefined], UnionReduction.Subtype, undefined, undefined);
    links.leftSpread = leftProp;
    links.rightSpread = rightProp;
    result.declarations = leftProp.declarations.concat(rightProp.declarations);
    links.nameType = c.symbolLinks(leftProp).nameType;
    members.set(leftProp.name, result);
  }
  const spreadIndexInfos = indexInfos.map((info) => getIndexInfoWithReadonly(info, readonly));
  const spread = createAnonymousType(c, symbol, members, [], [], spreadIndexInfos);
  spread.objectFlags |=
    ObjectFlags.ObjectLiteral | ObjectFlags.ContainsObjectOrArrayLiteral | ObjectFlags.ContainsSpread | objectFlags;
  return spread;
}

function getIndexInfoWithReadonly(info: IndexInfo, readonly: boolean): IndexInfo {
  return info.isReadonly !== readonly
    ? new IndexInfo(info.keyType, info.valueType, readonly, info.declaration, info.components)
    : info;
}

function getUnionIndexInfos(c: Checker, types: Type[]): IndexInfo[] {
  const result: IndexInfo[] = [];
  for (const info of getIndexInfosOfType(c, types[0])) {
    const indexType = info.keyType;
    if (!types.every((t) => getIndexInfoOfType(c, t, indexType) !== undefined)) continue;
    const valueTypes: Type[] = [];
    let isReadonly = false;
    for (const t of types) {
      valueTypes.push(getIndexTypeOfType(c, t, indexType)!);
      if (getIndexInfoOfType(c, t, indexType)!.isReadonly) isReadonly = true;
    }
    result.push(new IndexInfo(indexType, getUnionType(c, valueTypes), isReadonly, undefined, []));
  }
  return result;
}

function isNonGenericObjectType(c: Checker, t: Type): boolean {
  return (t.flags & TypeFlags.Object) !== 0 && !isGenericMappedType(c, t);
}

function isEmptyObjectTypeOrSpreadsIntoEmptyObject(c: Checker, t: Type): boolean {
  return (
    isEmptyObjectType(c, t) ||
    (t.flags &
      (TypeFlags.Null |
        TypeFlags.Undefined |
        TypeFlags.BooleanLike |
        TypeFlags.NumberLike |
        TypeFlags.BigIntLike |
        TypeFlags.StringLike |
        TypeFlags.EnumLike |
        TypeFlags.NonPrimitive |
        TypeFlags.Index)) !==
      0
  );
}

/** A union of one object type and types that spread to nothing, spread as that object made optional. */
function tryMergeUnionOfObjectTypeAndEmptyObject(c: Checker, t: Type, readonly: boolean): Type {
  if ((t.flags & TypeFlags.Union) === 0) return t;
  const types = typesOf(t);
  if (types.every((u) => isEmptyObjectTypeOrSpreadsIntoEmptyObject(c, u)))
    return types.find((u) => isEmptyObjectType(c, u)) ?? c.emptyObjectType;
  const firstType = types.find((u) => !isEmptyObjectTypeOrSpreadsIntoEmptyObject(c, u));
  if (firstType === undefined) return t;
  if (types.some((u) => u !== firstType && !isEmptyObjectTypeOrSpreadsIntoEmptyObject(c, u))) return t;
  const members = new Map<string, Symbol>();
  for (const prop of getPropertiesOfType(c, firstType)) {
    if (
      (getDeclarationModifierFlagsFromSymbol(c, prop, false) & (ModifierFlags.Private | ModifierFlags.Protected)) !==
      0
    )
      continue;
    if (!isSpreadableProperty(prop)) continue;
    const isSetonlyAccessor =
      (prop.flags & SymbolFlags.SetAccessor) !== 0 && (prop.flags & SymbolFlags.GetAccessor) === 0;
    const result = c.newSymbolWithCheckFlags(
      SymbolFlags.Property | SymbolFlags.Optional,
      prop.name,
      (prop.checkFlags & CheckFlags.Late) | (readonly ? CheckFlags.Readonly : 0),
    );
    const links = c.symbolLinks(result);
    links.type = isSetonlyAccessor ? c.undefinedType : addOptionality(c, getTypeOfSymbol(c, prop), true, true);
    result.declarations = prop.declarations;
    links.nameType = c.symbolLinks(prop).nameType;
    links.syntheticOrigin = prop;
    members.set(prop.name, result);
  }
  const spread = createAnonymousType(c, firstType.symbol, members, [], [], getIndexInfosOfType(c, firstType));
  spread.objectFlags |= ObjectFlags.ObjectLiteral | ObjectFlags.ContainsObjectOrArrayLiteral;
  return spread;
}
