// The TypeChecker of tsc-ts's public API: a checker of the program for queries, independent of the
// checker that reports the program's diagnostics, as `tsc-ts --api` answers queries. Each method answers
// as the `tsc-ts --api` request of the same name does.

import type { Node as CompilerNode } from '../compiler/ast.js';
import { type Checker, disposeChecker } from '../compiler/checker.js';
import { getBaseTypes, getDeclaredTypeOfSymbol } from '../compiler/checker-declared-types.js';
import { getNonNullableType } from '../compiler/checker-flow.js';
import {
  getIndexInfosOfType,
  getPropertiesOfType,
  getPropertyOfType,
  getSignaturesOfType,
  isArrayLikeType,
} from '../compiler/checker-members.js';
import {
  getConstantValue,
  getShorthandAssignmentValueSymbol,
  getSymbolAtLocation,
  getTypeAtLocation,
  getTypeOfSymbolAtLocation,
  queryContextualType,
  queryResolvedSignature,
  querySignatureFromDeclaration,
} from '../compiler/checker-services.js';
import { getReturnTypeOfSignature, getTypePredicateOfSignature } from '../compiler/checker-signatures.js';
import { getTypeOfSymbol } from '../compiler/checker-symbol-types.js';
import { resolveAlias, resolveName } from '../compiler/checker-symbols.js';
import {
  getBaseTypeOfLiteralType,
  getTypeArguments,
  isArrayType,
  isTupleType,
} from '../compiler/checker-type-factory.js';
import { getTypeFromTypeNode } from '../compiler/checker-type-nodes.js';
import {
  type Signature as CompilerSignature,
  SignatureKind as CompilerSignatureKind,
  type Type as CompilerType,
} from '../compiler/checker-types.js';
import { typeToStringFromTypeNode } from '../compiler/node-builder.js';
import { isTypeAssignableTo } from '../compiler/relations.js';
import {
  getSymbolId,
  type Symbol as CompilerSymbol,
  type SymbolFlags as CompilerSymbolFlags,
} from '../compiler/symbol.js';
import { typeToString } from '../compiler/type-printer.js';
import type { Expression, Identifier, Node, TypeNode } from './ast.js';
import { SignatureKind, SymbolFlags, TypeFormatFlags, type TypePredicateKind } from './enums.generated.js';
import { internalError } from './errors.js';
import type {
  IndexInfo,
  InterfaceType,
  Signature,
  Symbol,
  Type,
  TypeChecker,
  TypePredicate,
  TypeReference,
} from './types.js';

// The API's objects are tsc-ts's own: these name the conversions between the public and compiler types.
const node = (n: Node): CompilerNode => n as unknown as CompilerNode;
const nodeOrUndefined = (n: Node | undefined): CompilerNode | undefined => n as unknown as CompilerNode | undefined;
const type = (t: Type): CompilerType => t as unknown as CompilerType;
const signature = (s: Signature): CompilerSignature => s as unknown as CompilerSignature;
const compilerSymbol = (s: Symbol): CompilerSymbol => s as unknown as CompilerSymbol;
const publicType = (t: CompilerType | undefined): Type | undefined => t as unknown as Type | undefined;
const publicTypes = (types: readonly CompilerType[]): readonly Type[] => types.slice() as unknown as readonly Type[];
const publicSignature = (s: CompilerSignature | undefined): Signature | undefined =>
  s as unknown as Signature | undefined;

/** `symbol`, with its id assigned: every symbol the API hands out has one. */
export function publicSymbol(symbol: CompilerSymbol | undefined): Symbol | undefined {
  if (symbol === undefined) return undefined;
  getSymbolId(symbol);
  return symbol as unknown as Symbol;
}

export function publicSymbols(symbols: readonly CompilerSymbol[]): readonly Symbol[] {
  const result: Symbol[] = [];
  for (const symbol of symbols) result.push(publicSymbol(symbol)!);
  return result;
}

/** The flags of typeToString without flags, as TypeScript 7's API uses them. */
const defaultTypeFormatFlags =
  TypeFormatFlags.AllowUniqueESSymbolType | TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

export class LibraryTypeChecker implements TypeChecker {
  constructor(private readonly c: Checker) {}

  dispose(): void {
    disposeChecker(this.c);
  }

  getSymbolAtLocation(location: Node): Symbol | undefined {
    try {
      return publicSymbol(getSymbolAtLocation(this.c, node(location)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getTypeAtLocation(location: Node): Type | undefined {
    try {
      return publicType(getTypeAtLocation(this.c, node(location)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getTypeOfSymbol(symbol: Symbol): Type | undefined {
    try {
      return publicType(getTypeOfSymbol(this.c, compilerSymbol(symbol)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getDeclaredTypeOfSymbol(symbol: Symbol): Type {
    try {
      return publicType(getDeclaredTypeOfSymbol(this.c, compilerSymbol(symbol)))!;
    } catch (e) {
      throw internalError(e);
    }
  }

  getTypeOfSymbolAtLocation(symbol: Symbol, location: Node): Type {
    try {
      return publicType(getTypeOfSymbolAtLocation(this.c, compilerSymbol(symbol), node(location)))!;
    } catch (e) {
      throw internalError(e);
    }
  }

  getTypeArguments(reference: TypeReference): readonly Type[] {
    try {
      return publicTypes(getTypeArguments(this.c, type(reference)));
    } catch (e) {
      throw internalError(e);
    }
  }

  /** The target of an alias; throws an InternalCompilerError for any other symbol, as TypeScript 7 does. */
  getAliasedSymbol(symbol: Symbol): Symbol {
    try {
      if ((symbol.flags & SymbolFlags.Alias) === 0) throw new Error('Should only get alias here');
      return publicSymbol(resolveAlias(this.c, compilerSymbol(symbol)))!;
    } catch (e) {
      throw internalError(e);
    }
  }

  getPropertyOfType(t: Type, name: string): Symbol | undefined {
    try {
      return publicSymbol(getPropertyOfType(this.c, type(t), name));
    } catch (e) {
      throw internalError(e);
    }
  }

  getPropertiesOfType(t: Type): readonly Symbol[] {
    try {
      return publicSymbols(getPropertiesOfType(this.c, type(t)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getSignaturesOfType(t: Type, kind: SignatureKind): readonly Signature[] {
    try {
      const signatures = getSignaturesOfType(
        this.c,
        type(t),
        kind === SignatureKind.Call ? CompilerSignatureKind.Call : CompilerSignatureKind.Construct,
      );
      return signatures.slice() as unknown as readonly Signature[];
    } catch (e) {
      throw internalError(e);
    }
  }

  getIndexInfosOfType(t: Type): readonly IndexInfo[] {
    try {
      return getIndexInfosOfType(this.c, type(t)).slice() as unknown as readonly IndexInfo[];
    } catch (e) {
      throw internalError(e);
    }
  }

  getReturnTypeOfSignature(s: Signature): Type | undefined {
    try {
      return publicType(getReturnTypeOfSignature(this.c, signature(s)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getTypePredicateOfSignature(s: Signature): TypePredicate | undefined {
    try {
      const predicate = getTypePredicateOfSignature(this.c, signature(s));
      if (predicate === undefined) return undefined;
      return {
        kind: predicate.kind as number as TypePredicateKind,
        parameterIndex: predicate.parameterIndex,
        parameterName: predicate.parameterName === '' ? undefined : predicate.parameterName,
        type: publicType(predicate.type),
      };
    } catch (e) {
      throw internalError(e);
    }
  }

  getSignatureFromDeclaration(declaration: Node): Signature | undefined {
    try {
      return publicSignature(querySignatureFromDeclaration(this.c, node(declaration)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getResolvedSignature(call: Node): Signature | undefined {
    try {
      return publicSignature(queryResolvedSignature(this.c, node(call)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getContextualType(expression: Expression): Type | undefined {
    try {
      return publicType(queryContextualType(this.c, node(expression)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getShorthandAssignmentValueSymbol(location: Node): Symbol | undefined {
    try {
      return publicSymbol(getShorthandAssignmentValueSymbol(this.c, node(location)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getTypeFromTypeNode(typeNode: TypeNode): Type | undefined {
    try {
      return publicType(getTypeFromTypeNode(this.c, node(typeNode)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getBaseTypeOfLiteralType(t: Type): Type | undefined {
    try {
      return publicType(getBaseTypeOfLiteralType(this.c, type(t)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getNonNullableType(t: Type): Type | undefined {
    try {
      return publicType(getNonNullableType(this.c, type(t)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getBaseTypes(t: InterfaceType): readonly Type[] {
    try {
      return publicTypes(getBaseTypes(this.c, type(t)));
    } catch (e) {
      throw internalError(e);
    }
  }

  getConstantValue(location: Node): string | number | undefined {
    try {
      return getConstantValue(this.c, node(location));
    } catch (e) {
      throw internalError(e);
    }
  }

  isArrayType(t: Type): boolean {
    try {
      return isArrayType(this.c, type(t));
    } catch (e) {
      throw internalError(e);
    }
  }

  isTupleType(t: Type): boolean {
    try {
      return isTupleType(type(t));
    } catch (e) {
      throw internalError(e);
    }
  }

  isArrayLikeType(t: Type): boolean {
    try {
      return isArrayLikeType(this.c, type(t));
    } catch (e) {
      throw internalError(e);
    }
  }

  isTypeAssignableTo(source: Type, target: Type): boolean {
    try {
      return isTypeAssignableTo(this.c, type(source), type(target));
    } catch (e) {
      throw internalError(e);
    }
  }

  resolveName(name: string, meaning: SymbolFlags, location?: Node, excludeGlobals = false): Symbol | undefined {
    try {
      return publicSymbol(
        resolveName(
          this.c,
          nodeOrUndefined(location),
          name,
          meaning as number as CompilerSymbolFlags,
          undefined,
          false,
          excludeGlobals,
        ),
      );
    } catch (e) {
      throw internalError(e);
    }
  }

  /** The value an identifier names where it is: resolveName of its text, as TypeScript 7's API defines it. */
  getResolvedSymbol(identifier: Identifier): Symbol | undefined {
    if (identifier.text === '') return undefined;
    return this.resolveName(identifier.text, SymbolFlags.Value | SymbolFlags.ExportValue, identifier);
  }

  typeToString(t: Type, enclosingDeclaration?: Node, flags?: TypeFormatFlags): string {
    try {
      const enclosing = nodeOrUndefined(enclosingDeclaration);
      const formatFlags = flags === undefined || flags === 0 ? defaultTypeFormatFlags : flags;
      return (
        typeToStringFromTypeNode(this.c, type(t), enclosing, formatFlags) ??
        typeToString(this.c, type(t), enclosing, formatFlags)
      );
    } catch (e) {
      throw internalError(e);
    }
  }

  getAnyType(): Type {
    return this.c.anyType as unknown as Type;
  }

  getUnknownType(): Type {
    return this.c.unknownType as unknown as Type;
  }

  getNeverType(): Type {
    return this.c.neverType as unknown as Type;
  }

  getStringType(): Type {
    return this.c.stringType as unknown as Type;
  }

  getNumberType(): Type {
    return this.c.numberType as unknown as Type;
  }

  getBigIntType(): Type {
    return this.c.bigintType as unknown as Type;
  }

  getBooleanType(): Type {
    return this.c.booleanType as unknown as Type;
  }
}
