// Printing types, symbols and signatures as text, like tsgo's node builder followed by its
// printer: the text diagnostics embed.
import {
  ModifierFlags,
  type Node,
  type SourceFile,
  getName,
  getSymbol,
  type BindingElement,
  getDotDotDotToken,
  getElements,
  getInitializer,
  getParameters,
  getQuestionToken,
  getText,
  type StringLiteral,
  type TypeReferenceNode,
  type ArrayTypeNode,
  type ComputedPropertyName,
  type ConditionalTypeNode,
  type ConstructorTypeNode,
  type IndexedAccessTypeNode,
  type InferTypeNode,
  type IntersectionTypeNode,
  type JSDocNonNullableType,
  type JSDocNullableType,
  type JSDocOptionalType,
  type JSDocTypeExpression,
  type JSDocVariadicType,
  type LiteralTypeNode,
  type MappedTypeNode,
  type NamedTupleMember,
  type NodeList,
  type OptionalTypeNode,
  type ParameterDeclaration,
  type ParenthesizedTypeNode,
  type PrefixUnaryExpression,
  type RestTypeNode,
  type TemplateLiteralTypeNode,
  type TemplateLiteralTypeSpan,
  type TemplateMiddle,
  type TemplateTail,
  type TupleTypeNode,
  type TypeLiteralNode,
  type TypeOperatorNode,
  type TypeParameterDeclaration,
  type TypePredicateNode,
  type TypeQueryNode,
  type UnionTypeNode,
  getModifiers,
  getPostfixToken,
  getType,
  getTypeParameters,
} from './ast.js';
import { nodeIsSynthesized } from './printer/utilities.js';
import { getSymbolFromTypeReference, getTypeFromTypeNode } from './checker-type-nodes.js';
import { instantiateType } from './instantiation.js';
import { getTypeWithFacts, TypeFacts } from './checker-flow.js';
import { getInferredTypeParameterConstraint } from './checker-inference.js';
import { entityNameToString, isConstTypeReference } from './checker-expressions.js';
import { isEntityNameExpression } from './checker-declared-types.js';
import { getIntendedTypeFromJSDocTypeReference } from './checker-jsdoc.js';
import { TokenFlags } from './types.js';
import { isNumericLiteralName } from './checker-utilities.js';
import {
  declarationNameToString,
  getCombinedModifierFlags,
  getNameOfDeclaration,
  getSourceFileOfNode,
  isStatic,
} from './binder-utilities.js';
import { isIdentifierText, tokenToString } from './scanner.js';
import { CheckFlags, InternalSymbolName, type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  type ConditionalType,
  ElementFlags,
  type IndexInfo,
  type IndexType,
  type IndexedAccessType,
  type InterfaceType,
  type IntrinsicType,
  type LiteralType,
  type MappedType,
  ObjectFlags,
  type ObjectType,
  type Signature,
  SignatureFlags,
  type StringMappingType,
  type SubstitutionType,
  type TemplateLiteralType,
  type TupleType,
  type Type,
  TypeFlags,
  type TypeParameter,
  type TypePredicate,
  TypePredicateKind,
  type TypeReference,
  type TypeMapper,
  type UnionType,
} from './checker-types.js';
import {
  getRegularTypeOfLiteralType,
  getTypeArguments,
  getBaseTypeOfEnumLikeType,
  typesOf,
  filterType,
} from './checker-type-factory.js';
import { getMergedSymbol, getParentOfSymbol } from './checker-symbols.js';
import {
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  getConstraintOfTypeParameter,
  getDefaultFromTypeParameter,
  getConstraintDeclaration,
  getMinTypeArgumentCount,
} from './checker-declared-types.js';
import {
  getBaseTypeVariableOfClass,
  getNonMissingTypeOfSymbol,
  getTypeOfSymbol,
  getWriteTypeOfSymbol,
  isReadonlySymbol,
  removeMissingType,
} from './checker-symbol-types.js';
import {
  getPropertiesOfObjectType,
  getReducedType,
  getSignaturesOfType,
  resolveStructuredTypeMembers,
} from './checker-members.js';
import { getReturnTypeOfSignature, getTypePredicateOfSignature } from './checker-signatures.js';
import {
  getConstraintTypeFromMappedType,
  getMappedTypeModifiers,
  getNameTypeFromMappedType,
  getTemplateTypeFromMappedType,
  getTypeParameterFromMappedType,
  isGenericMappedType,
  MappedTypeModifiers,
} from './checker-type-operators.js';
import { SignatureKind } from './checker-types.js';
import { isTypeIdenticalTo } from './relations.js';
import { getGlobalIterableIteratorType, getGlobalIterableType, isReferenceToType } from './checker-iteration.js';

const defaultMaximumTruncationLength = 160;

const enum PrintFlags {
  None = 0,
  WriteArrayAsGenericType = 1 << 1,
  UseFullyQualifiedType = 1 << 6,
  AllowUniqueESSymbolType = 1 << 20,
  InObjectTypeLiteral = 1 << 22,
  NoTypeReduction = 1 << 29,
}

/** One printing run: the visited types and the approximate output length for truncation. */
class TypePrinter {
  readonly c: Checker;
  flags: number;
  approximateLength = 0;
  truncating = false;
  readonly visited = new Set<number>();
  readonly noTruncation: boolean;
  /** Where the text appears; with one, declared type annotations are reused as written. */
  readonly enclosingDeclaration: Node | undefined;
  /** The mapper of the signature being printed, under which its declared type nodes are read. */
  mapper: TypeMapper | undefined = undefined;
  /** The `infer` type parameters of the extends type being printed. */
  inferTypeParameters: readonly Type[] = [];

  constructor(c: Checker, flags: number, noTruncation: boolean, enclosingDeclaration?: Node) {
    this.c = c;
    this.flags = flags;
    this.noTruncation = noTruncation;
    this.enclosingDeclaration = enclosingDeclaration;
  }

  checkTruncationLength(): boolean {
    if (this.truncating) return true;
    this.truncating = !this.noTruncation && this.approximateLength > defaultMaximumTruncationLength;
    return this.truncating;
  }

  // ---- Types

  type(t: Type): string {
    const c = this.c;
    if ((this.flags & PrintFlags.NoTypeReduction) === 0) t = getReducedType(c, t);
    const flags = t.flags;
    if ((flags & TypeFlags.Any) !== 0) {
      if (t.alias !== undefined) return this.aliasReference(t.alias.symbol, t.alias.typeArguments);
      this.approximateLength += 3;
      return t === c.intrinsicMarkerType ? 'intrinsic' : 'any';
    }
    if ((flags & TypeFlags.Unknown) !== 0) return 'unknown';
    if ((flags & TypeFlags.String) !== 0) return this.keyword('string');
    if ((flags & TypeFlags.Number) !== 0) return this.keyword('number');
    if ((flags & TypeFlags.BigInt) !== 0) return this.keyword('bigint');
    if ((flags & TypeFlags.Boolean) !== 0 && t.alias === undefined) return this.keyword('boolean');
    let expandingEnum = false;
    if ((flags & TypeFlags.EnumLike) !== 0) {
      const symbol = t.symbol!;
      if ((symbol.flags & SymbolFlags.EnumMember) !== 0) {
        const parentSymbol = getParentOfSymbol(c, symbol)!;
        const parentName = this.symbolReference(parentSymbol, SymbolFlags.Type);
        if (getDeclaredTypeOfSymbol(c, parentSymbol) === t) return parentName;
        const memberName = symbol.name;
        if (isIdentifierText(memberName)) return parentName + '.' + memberName;
        return '(typeof ' + parentName + ')[' + quoteString(memberName) + ']';
      }
      if ((flags & TypeFlags.Union) === 0) return this.symbolReference(symbol, SymbolFlags.Type);
      expandingEnum = false;
      return this.symbolReference(symbol, SymbolFlags.Type);
    }
    if ((flags & TypeFlags.StringLiteral) !== 0) {
      const value = (t as LiteralType).stringValue;
      this.approximateLength += value.length + 2;
      return quoteString(value);
    }
    if ((flags & TypeFlags.NumberLiteral) !== 0) {
      const text = numberText((t as LiteralType).numberValue);
      this.approximateLength += text.length;
      return text;
    }
    if ((flags & TypeFlags.BigIntLiteral) !== 0) {
      const text = (t as LiteralType).stringValue + 'n';
      this.approximateLength += text.length;
      return text;
    }
    if ((flags & TypeFlags.BooleanLiteral) !== 0) {
      const value = (t as LiteralType).stringValue;
      this.approximateLength += value.length;
      return value;
    }
    if ((flags & TypeFlags.UniqueESSymbol) !== 0) {
      // Outside declarations, a unique symbol goes by its declaration.
      if ((this.flags & PrintFlags.AllowUniqueESSymbolType) === 0 && t.symbol !== undefined) {
        this.approximateLength += 6;
        return 'typeof ' + this.uniqueSymbolReference(t.symbol);
      }
      this.approximateLength += 13;
      return 'unique symbol';
    }
    if ((flags & TypeFlags.Void) !== 0) return this.keyword('void');
    if ((flags & TypeFlags.Undefined) !== 0) return this.keyword('undefined');
    if ((flags & TypeFlags.Null) !== 0) return this.keyword('null');
    if ((flags & TypeFlags.Never) !== 0) return this.keyword('never');
    if ((flags & TypeFlags.ESSymbol) !== 0) return this.keyword('symbol');
    if ((flags & TypeFlags.NonPrimitive) !== 0) return this.keyword('object');
    if ((flags & TypeFlags.TypeParameter) !== 0 && (t as TypeParameter).isThisType) {
      this.approximateLength += 4;
      return 'this';
    }
    if (t.alias !== undefined) return this.aliasReference(t.alias.symbol, t.alias.typeArguments);
    const objectFlags = t.objectFlags;
    if ((flags & TypeFlags.Object) !== 0 && (objectFlags & ObjectFlags.Reference) !== 0)
      return this.typeReference(t as TypeReference);
    if ((flags & TypeFlags.TypeParameter) !== 0 && this.inferTypeParameters.includes(t)) return this.inferType(t);
    if (
      (flags & TypeFlags.TypeParameter) !== 0 ||
      ((flags & TypeFlags.Object) !== 0 && (objectFlags & ObjectFlags.ClassOrInterface) !== 0)
    ) {
      const varianceTypeParameter = c.varianceTypeParameter;
      if (
        (t === c.markerSuperTypeForCheck || t === c.markerSubTypeForCheck) &&
        varianceTypeParameter !== undefined &&
        varianceTypeParameter.symbol !== undefined
      ) {
        const name = (t === c.markerSubTypeForCheck ? 'sub-' : 'super-') + varianceTypeParameter.symbol.name;
        this.approximateLength += name.length;
        return name;
      }
      if (t.symbol !== undefined) return this.symbolReference(t.symbol, SymbolFlags.Type);
      return '?';
    }
    let u = t;
    if ((flags & TypeFlags.Union) !== 0 && (t as UnionType).origin !== undefined) u = (t as UnionType).origin!;
    if ((u.flags & (TypeFlags.Union | TypeFlags.Intersection)) !== 0) {
      const types = (u.flags & TypeFlags.Union) !== 0 ? formatUnionTypes(c, typesOf(u), expandingEnum) : typesOf(u);
      if (types.length === 1) return this.type(types[0]!);
      const parts = this.typeList(
        types,
        true,
        // Union and intersection constituents are parenthesized when they are themselves either.
        Precedence.TypeOperator,
      );
      return parts.join((u.flags & TypeFlags.Union) !== 0 ? ' | ' : ' & ');
    }
    // A union whose origin is a `keyof` prints as that.
    if (u !== t) return this.type(u);
    if ((flags & TypeFlags.Object) !== 0 && (objectFlags & (ObjectFlags.Anonymous | ObjectFlags.Mapped)) !== 0)
      return this.anonymousType(t as ObjectType);
    if ((flags & TypeFlags.Index) !== 0) {
      this.approximateLength += 6;
      return 'keyof ' + this.typeAt((t as IndexType).target, Precedence.TypeOperator);
    }
    if ((flags & TypeFlags.TemplateLiteral) !== 0) {
      const template = t as TemplateLiteralType;
      let text = '`' + escapeTemplate(template.texts[0]!);
      for (let i = 0; i < template.types.length; i++)
        text += '${' + this.type(template.types[i]!) + '}' + escapeTemplate(template.texts[i + 1]!);
      this.approximateLength += 2;
      return text + '`';
    }
    if ((flags & TypeFlags.StringMapping) !== 0)
      return this.symbolReference(t.symbol!, SymbolFlags.Type) + '<' + this.type((t as StringMappingType).target) + '>';
    if ((flags & TypeFlags.IndexedAccess) !== 0) {
      const access = t as IndexedAccessType;
      this.approximateLength += 2;
      return this.typeAt(access.objectType, Precedence.Postfix) + '[' + this.type(access.indexType) + ']';
    }
    if ((flags & TypeFlags.Conditional) !== 0) return this.conditionalType(t as ConditionalType);
    if ((flags & TypeFlags.Substitution) !== 0) return this.type((t as SubstitutionType).baseType);
    return '?';
  }

  keyword(text: string): string {
    this.approximateLength += text.length;
    return text;
  }

  /** `t` parenthesized when its form binds looser than `precedence`. */
  typeAt(t: Type, precedence: Precedence): string {
    const text = this.type(t);
    return typeTextPrecedence(text) < precedence ? '(' + text + ')' : text;
  }

  typeList(types: readonly Type[], isBareList: boolean, precedence: Precedence): string[] {
    if (this.checkTruncationLength()) {
      if (!isBareList) return ['...'];
      if (types.length > 2)
        return [
          this.typeAt(types[0]!, precedence),
          '... ' + (types.length - 2) + ' more ...',
          this.typeAt(types[types.length - 1]!, precedence),
        ];
    }
    const result: string[] = [];
    for (let i = 0; i < types.length; i++) {
      const displayIndex = i + 1;
      if (this.checkTruncationLength() && displayIndex + 2 < types.length - 1) {
        result.push('... ' + (types.length - displayIndex) + ' more ...');
        result.push(this.typeAt(types[types.length - 1]!, precedence));
        break;
      }
      this.approximateLength += 2;
      result.push(this.typeAt(types[i]!, precedence));
    }
    if ((this.flags & PrintFlags.UseFullyQualifiedType) === 0) this.qualifyCollidingNames(types, result, precedence);
    return result;
  }

  /** Reprints plain names that occur more than once for different types, like `Foo.Yep | Bar.Yep`. */
  qualifyCollidingNames(types: readonly Type[], result: string[], precedence: Precedence): void {
    // Only entries printed one-to-one; truncation markers aren't types.
    if (result.length !== types.length) return;
    for (let i = 0; i < result.length; i++) {
      if (!isIdentifierText(result[i]!)) continue;
      let collides = false;
      for (let j = 0; j < result.length; j++)
        if (j !== i && result[j] === result[i] && !typesAreSameReference(types[i]!, types[j]!)) collides = true;
      if (!collides) continue;
      const saveFlags = this.flags;
      this.flags |= PrintFlags.UseFullyQualifiedType;
      const name = result[i]!;
      for (let j = i; j < result.length; j++) if (result[j]! === name) result[j] = this.typeAt(types[j]!, precedence);
      this.flags = saveFlags;
    }
  }

  typeArguments(types: readonly Type[]): string {
    if (types.length === 0) return '';
    return '<' + this.typeList(types, false, Precedence.Lowest).join(', ') + '>';
  }

  aliasReference(symbol: Symbol, typeArguments: readonly Type[]): string {
    const c = this.c;
    if (typeArguments.length === 1 && symbol === c.globalArrayType.symbol)
      return this.typeAt(typeArguments[0]!, Precedence.Postfix) + '[]';
    // Arguments are printed first; the name counts toward truncation after them.
    const args = this.typeArguments(typeArguments);
    return this.symbolReference(symbol, SymbolFlags.Type) + args;
  }

  typeReference(t: TypeReference): string {
    // Deferred references can nest without bound; print revisits as `...`.
    if (t.node === undefined) return this.typeReferenceWorker(t);
    if (this.visited.has(t.id)) {
      this.approximateLength += 3;
      return '...';
    }
    this.visited.add(t.id);
    const result = this.typeReferenceWorker(t);
    this.visited.delete(t.id);
    return result;
  }

  typeReferenceWorker(t: TypeReference): string {
    const c = this.c;
    const target = t.target!;
    const typeArguments = getTypeArguments(c, t);
    if (target === c.globalArrayType || target === c.globalReadonlyArrayType) {
      if ((this.flags & PrintFlags.WriteArrayAsGenericType) !== 0)
        return (target === c.globalArrayType ? 'Array' : 'ReadonlyArray') + '<' + this.type(typeArguments[0]!) + '>';
      const element = this.typeAt(typeArguments[0]!, Precedence.Postfix) + '[]';
      return target === c.globalArrayType ? element : 'readonly ' + element;
    }
    if ((target.objectFlags & ObjectFlags.Tuple) !== 0) {
      const tuple = target as TupleType;
      const arity = tuple.typeParameters().length;
      const parts: string[] = [];
      const elementTypes: Type[] = [];
      for (let i = 0; i < arity; i++)
        elementTypes.push(
          removeMissingType(c, typeArguments[i]!, (tuple.elementInfos[i]!.flags & ElementFlags.Optional) !== 0),
        );
      const texts = elementTypes.length === 0 ? [] : this.typeList(elementTypes, false, Precedence.Lowest);
      for (let i = 0; i < texts.length; i++) {
        if (i >= tuple.elementInfos.length) {
          parts.push(texts[i]!);
          continue;
        }
        const info = tuple.elementInfos[i]!;
        const flags = info.flags;
        let text = texts[i]!;
        if (info.labeledDeclaration !== undefined) {
          const label = getText(getName(info.labeledDeclaration)!);
          if ((flags & ElementFlags.Rest) !== 0) text = parenthesizeForArray(text) + '[]';
          text =
            ((flags & ElementFlags.Variable) !== 0 ? '...' : '') +
            label +
            ((flags & ElementFlags.Optional) !== 0 ? '?' : '') +
            ': ' +
            text;
        } else if ((flags & ElementFlags.Variable) !== 0)
          text = '...' + ((flags & ElementFlags.Rest) !== 0 ? parenthesizeForArray(text) + '[]' : text);
        else if ((flags & ElementFlags.Optional) !== 0) text = parenthesizeForArray(text) + '?';
        parts.push(text);
      }
      const result = '[' + parts.join(', ') + ']';
      return tuple.readonly ? 'readonly ' + result : result;
    }
    // Outer type parameters group by their declaring container.
    const generic = target as InterfaceType;
    const outer = generic.outerTypeParameters();
    let prefix = '';
    let i = 0;
    while (i < outer.length) {
      const start = i;
      const parent = getParentSymbolOfTypeParameter(c, outer[i]!);
      do i++;
      while (i < outer.length && getParentSymbolOfTypeParameter(c, outer[i]!) === parent);
      let same = true;
      for (let j = start; j < i; j++) if (outer[j]! !== typeArguments[j]!) same = false;
      if (!same && parent !== undefined)
        prefix =
          this.symbolReference(parent, SymbolFlags.Type) + this.typeArguments(typeArguments.slice(start, i)) + '.';
    }
    let typeParameterCount = Math.min(generic.typeParameters().length, typeArguments.length);
    // Arguments equal to their defaults are elided for the iterable types, which gained two type
    // parameters, unless they were written out.
    if (isIterableTypeWithDefaults(c, t) && !hasAllTypeArgumentsWritten(t as TypeReference, typeParameterCount))
      while (typeParameterCount > 0) {
        const defaultType = getDefaultFromTypeParameter(c, generic.typeParameters()[typeParameterCount - 1]!);
        if (defaultType === undefined || !isTypeIdenticalTo(c, typeArguments[typeParameterCount - 1]!, defaultType))
          break;
        typeParameterCount--;
      }
    const args = typeArguments.length > 0 ? typeArguments.slice(i, typeParameterCount) : [];
    const argsText = this.typeArguments(args);
    if (prefix !== '') return prefix + t.symbol!.name + argsText;
    return this.symbolReference(t.symbol!, SymbolFlags.Type) + argsText;
  }

  anonymousType(t: ObjectType): string {
    const c = this.c;
    const symbol = t.symbol;
    if (symbol !== undefined) {
      const isInstance = symbol.flags & SymbolFlags.Class && t === getDeclaredTypeOfClassOrInterface(c, symbol);
      if (!isInstance) {
        if (
          (symbol.flags & SymbolFlags.Class) !== 0 &&
          t.objectFlags & ObjectFlags.Anonymous &&
          (t.objectFlags & ObjectFlags.Instantiated) === 0 &&
          getBaseTypeVariableOfClass(c, symbol) === undefined
        )
          return 'typeof ' + this.symbolReference(symbol, SymbolFlags.Value);
        if (
          (symbol.flags & (SymbolFlags.Enum | SymbolFlags.ValueModule)) !== 0 &&
          (t.objectFlags & ObjectFlags.Anonymous) !== 0
        ) {
          const specifier = getExternalModuleSpecifierText(symbol);
          if (specifier !== undefined) {
            this.approximateLength += specifier.length + 16;
            return 'typeof import("' + specifier + '")';
          }
          return 'typeof ' + this.symbolReference(symbol, SymbolFlags.Value);
        }
      }
      if (this.visited.has(t.id)) {
        // A function whose type refers to itself prints as `typeof` its name.
        const functionSymbol = typeOfFunctionSymbol(c, symbol, this.enclosingDeclaration);
        if (functionSymbol !== undefined) return 'typeof ' + this.symbolReference(functionSymbol, SymbolFlags.Value);
        const alias = getTypeAliasForTypeLiteral(c, t);
        if (alias !== undefined) return this.symbolReference(alias, SymbolFlags.Type);
        this.approximateLength += 3;
        return '...';
      }
      this.visited.add(t.id);
      const result = this.objectType(t);
      this.visited.delete(t.id);
      return result;
    }
    return this.objectType(t);
  }

  objectType(t: ObjectType): string {
    const c = this.c;
    if (isGenericMappedType(c, t) || ((t.objectFlags & ObjectFlags.Mapped) !== 0 && (t as MappedType).containsError))
      return this.mappedType(t as MappedType);
    const resolved = resolveStructuredTypeMembers(c, t);
    const calls = resolved.callSignatures;
    const constructs = resolved.constructSignatures;
    if (resolved.properties.length === 0 && resolved.indexInfos.length === 0) {
      if (calls.length === 0 && constructs.length === 0) {
        this.approximateLength += 2;
        return '{}';
      }
      if (calls.length === 1 && constructs.length === 0) return this.signature(calls[0]!, SyntaxKind.FunctionType, '');
      if (constructs.length === 1 && calls.length === 0)
        return this.signature(constructs[0]!, SyntaxKind.ConstructorType, '');
    }
    const saveFlags = this.flags;
    this.flags |= PrintFlags.InObjectTypeLiteral;
    const members = this.members(
      resolved.callSignatures,
      resolved.constructSignatures,
      resolved.indexInfos,
      resolved.properties,
    );
    this.flags = saveFlags;
    this.approximateLength += 2;
    return members.length === 0 ? '{}' : '{ ' + members.join(' ') + ' }';
  }

  members(
    calls: readonly Signature[],
    constructs: readonly Signature[],
    indexInfos: readonly IndexInfo[],
    properties: readonly Symbol[],
  ): string[] {
    if (this.checkTruncationLength()) return ['...;'];
    const result: string[] = [];
    for (const s of calls) result.push(this.signature(s, SyntaxKind.CallSignature, '') + ';');
    for (const s of constructs)
      if ((s.flags & SignatureFlags.Abstract) === 0)
        result.push(this.signature(s, SyntaxKind.ConstructSignature, '') + ';');
    for (const info of indexInfos) result.push(this.indexInfo(info) + ';');
    let i = 0;
    for (const prop of properties) {
      i++;
      if (this.checkTruncationLength() && i + 2 < properties.length - 1) {
        result.push('... ' + (properties.length - i) + ' more ...;');
        this.property(properties[properties.length - 1]!, result);
        break;
      }
      this.property(prop, result);
    }
    return result;
  }

  indexInfo(info: IndexInfo): string {
    const name = info.declaration !== undefined ? parameterNameOfIndexSignature(info.declaration) : 'x';
    this.approximateLength += name.length + 4;
    return (
      (info.isReadonly ? 'readonly ' : '') +
      '[' +
      name +
      ': ' +
      this.type(info.keyType) +
      ']: ' +
      this.type(info.valueType)
    );
  }

  property(prop: Symbol, result: string[]): void {
    const c = this.c;
    const propertyType = getNonMissingTypeOfSymbol(c, prop);
    const name = propertyNameText(c, prop);
    this.approximateLength += prop.name.length + 1;
    const optional = (prop.flags & SymbolFlags.Optional) !== 0 ? '?' : '';
    if ((prop.flags & SymbolFlags.Accessor) !== 0) {
      const writeType = getWriteTypeOfSymbol(c, prop);
      if (
        propertyType !== writeType &&
        prop.declarations.some((d) => d.kind === SyntaxKind.GetAccessor || d.kind === SyntaxKind.SetAccessor)
      ) {
        if (prop.declarations.some((d) => d.kind === SyntaxKind.GetAccessor))
          result.push('get ' + name + '(): ' + this.type(propertyType) + ';');
        if (prop.declarations.some((d) => d.kind === SyntaxKind.SetAccessor))
          result.push('set ' + name + '(arg: ' + this.type(writeType) + ');');
        return;
      }
    }
    if (
      (prop.flags & (SymbolFlags.Function | SymbolFlags.Method)) !== 0 &&
      getPropertiesOfObjectType(c, propertyType).length === 0 &&
      !isReadonlySymbol(c, prop)
    ) {
      const signatures = getSignaturesOfType(
        c,
        filterType(c, propertyType, (u) => (u.flags & TypeFlags.Undefined) === 0),
        SignatureKind.Call,
      );
      for (const s of signatures) result.push(this.signature(s, SyntaxKind.MethodSignature, name + optional) + ';');
      if (signatures.length !== 0 || optional === '') return;
    }
    const typeText =
      this.declaredTypeText(
        prop.valueDeclaration ?? (prop.declarations.length !== 0 ? prop.declarations[0]! : undefined),
        propertyType,
      ) ?? this.type(propertyType);
    const readonly = isReadonlySymbol(c, prop) ? 'readonly ' : '';
    if (readonly !== '') this.approximateLength += 9;
    result.push(readonly + name + optional + ': ' + typeText + ';');
  }

  mappedType(t: MappedType): string {
    const c = this.c;
    const modifiers = getMappedTypeModifiers(t);
    const readonly =
      (modifiers & MappedTypeModifiers.IncludeReadonly) !== 0
        ? 'readonly '
        : (modifiers & MappedTypeModifiers.ExcludeReadonly) !== 0
          ? '-readonly '
          : '';
    const question =
      (modifiers & MappedTypeModifiers.IncludeOptional) !== 0
        ? '?'
        : (modifiers & MappedTypeModifiers.ExcludeOptional) !== 0
          ? '-?'
          : '';
    const typeParameter = getTypeParameterFromMappedType(c, t);
    const constraint = getConstraintTypeFromMappedType(c, t);
    const nameType = getNameTypeFromMappedType(c, t);
    const template = getTemplateTypeFromMappedType(c, t);
    this.approximateLength += 10;
    return (
      '{ ' +
      readonly +
      '[' +
      (typeParameter.symbol?.name ?? 'P') +
      ' in ' +
      this.type(constraint) +
      (nameType !== undefined ? ' as ' + this.type(nameType) : '') +
      ']' +
      question +
      ': ' +
      this.type(template) +
      '; }'
    );
  }

  conditionalType(t: ConditionalType): string {
    const c = this.c;
    if (this.checkTruncationLength()) return '...';
    const checkText = this.typeAt(t.checkType, Precedence.Conditional + 1);
    const saveInferTypeParameters = this.inferTypeParameters;
    this.inferTypeParameters = t.root.inferTypeParameters;
    const extendsText = this.typeAt(t.extendsType, Precedence.Conditional + 1);
    this.inferTypeParameters = saveInferTypeParameters;
    const trueText = this.type(getTrueTypeLazy(c, t));
    const falseText = this.type(getFalseTypeLazy(c, t));
    this.approximateLength += 15;
    return checkText + ' extends ' + extendsText + ' ? ' + trueText + ' : ' + falseText;
  }

  /** A type parameter its conditional type infers, with the constraint its position doesn't already imply. */
  inferType(t: Type): string {
    const c = this.c;
    const name = t.symbol!.name;
    this.approximateLength += name.length + 6;
    let text = 'infer ' + name;
    const constraint = getConstraintOfTypeParameter(c, t);
    if (constraint !== undefined) {
      const inferred = getInferredTypeParameterConstraint(c, t, true);
      if (inferred === undefined || !isTypeIdenticalTo(c, constraint, inferred)) {
        this.approximateLength += 9;
        text += ' extends ' + this.typeAt(constraint, Precedence.Conditional + 1);
      }
    }
    return text;
  }

  // ---- Signatures

  signature(s: Signature, kind: SyntaxKind, name: string): string {
    const saveMapper = this.mapper;
    if (s.mapper !== undefined) this.mapper = s.mapper;
    const result = this.signatureWorker(s, kind, name);
    this.mapper = saveMapper;
    return result;
  }

  signatureWorker(s: Signature, kind: SyntaxKind, name: string): string {
    const c = this.c;
    this.approximateLength += 3;
    let typeParameters = '';
    if (s.typeParameters.length !== 0)
      typeParameters = '<' + s.typeParameters.map((tp) => this.typeParameterDeclaration(tp)).join(', ') + '>';
    const params: string[] = [];
    if (s.thisParameter !== undefined) params.push('this: ' + this.type(getTypeOfSymbol(c, s.thisParameter)));
    for (let i = 0; i < s.parameters.length; i++)
      params.push(this.parameter(s.parameters[i]!, i === s.parameters.length - 1 && s.hasRestParameter()));
    const paramList = '(' + params.join(', ') + ')';
    const returnText = this.returnType(s);
    switch (kind) {
      case SyntaxKind.FunctionType:
        return typeParameters + paramList + ' => ' + returnText;
      case SyntaxKind.ConstructorType:
        return (
          ((s.flags & SignatureFlags.Abstract) !== 0 ? 'abstract ' : '') +
          'new ' +
          typeParameters +
          paramList +
          ' => ' +
          returnText
        );
      case SyntaxKind.ConstructSignature:
        return 'new ' + typeParameters + paramList + ': ' + returnText;
      case SyntaxKind.CallSignature:
        return typeParameters + paramList + ': ' + returnText;
      default:
        return name + typeParameters + paramList + ': ' + returnText;
    }
  }

  returnType(s: Signature): string {
    const c = this.c;
    const predicate = getTypePredicateOfSignature(c, s);
    if (predicate !== undefined) return this.typePredicate(predicate);
    const returnType = getReturnTypeOfSignature(c, s);
    const declaration = s.declaration;
    if (this.enclosingDeclaration !== undefined && declaration !== undefined && !nodeIsSynthesized(declaration)) {
      const annotation = getType(declaration);
      if (annotation !== undefined && this.annotationDenotes(annotation, returnType, false))
        return this.reuseExistingTypeNode(annotation);
    }
    return this.type(returnType);
  }

  typePredicate(p: TypePredicate): string {
    const asserts =
      p.kind === TypePredicateKind.AssertsThis || p.kind === TypePredicateKind.AssertsIdentifier ? 'asserts ' : '';
    const name =
      p.kind === TypePredicateKind.This || p.kind === TypePredicateKind.AssertsThis ? 'this' : p.parameterName;
    return asserts + name + (p.type !== undefined ? ' is ' + this.type(p.type) : '');
  }

  parameter(param: Symbol, isRest: boolean): string {
    const c = this.c;
    const declaration = param.valueDeclaration;
    let t = getTypeOfSymbol(c, param);
    const rest =
      isRest ||
      (declaration !== undefined && getDotDotDotToken(declaration) !== undefined) ||
      (param.checkFlags & CheckFlags.RestParameter) !== 0;
    const optional =
      !rest &&
      ((declaration !== undefined &&
        declaration.kind === SyntaxKind.Parameter &&
        (getQuestionToken(declaration) !== undefined || getInitializer(declaration) !== undefined)) ||
        (param.checkFlags & CheckFlags.OptionalParameter) !== 0);
    let name = param.name;
    if (declaration !== undefined && declaration.kind === SyntaxKind.Parameter) {
      const n = getName(declaration);
      if (n !== undefined && n.kind !== SyntaxKind.Identifier) name = bindingPatternText(n);
    }
    // Synthetic rest parameters of type `any` take any arguments.
    const typeText =
      this.declaredTypeText(declaration, t) ??
      this.type(rest && t === c.anyType && declaration === undefined ? c.anyArrayType : t);
    this.approximateLength += name.length + 3;
    return (rest ? '...' : '') + name + (optional ? '?' : '') + ': ' + typeText;
  }

  typeParameterDeclaration(tp: Type): string {
    const c = this.c;
    let text = tp.symbol?.name ?? 'T';
    const constraint = getConstraintOfTypeParameter(c, tp);
    if (constraint !== undefined) {
      const declaration = getConstraintDeclaration(tp);
      text +=
        ' extends ' +
        (declaration !== undefined && this.typeFromTypeNode(declaration) === constraint
          ? this.reuseExistingTypeNode(declaration)
          : this.type(constraint));
    }
    const defaultType = getDefaultFromTypeParameter(c, tp);
    if (defaultType !== undefined) text += ' = ' + this.type(defaultType);
    return text;
  }

  // ---- Reusing declared type nodes

  /** A type node's type, read under the mapper of the signature being printed. */
  typeFromTypeNode(node: Node): Type {
    const t = getTypeFromTypeNode(this.c, node);
    return this.mapper !== undefined ? instantiateType(this.c, t, this.mapper) : t;
  }

  /** Whether a declaration's annotation still denotes `t`, which an optional declaration widens with `undefined`. */
  annotationDenotes(annotation: Node, t: Type, isOptionalAnnotated: boolean): boolean {
    const c = this.c;
    if ((t.flags & TypeFlags.Any) !== 0 && t === c.errorType) return true;
    const annotated = getTypeFromTypeNode(c, annotation);
    if (annotated === t) return true;
    if (isOptionalAnnotated) {
      const stripped = getTypeWithFacts(c, t, TypeFacts.NEUndefined);
      if (stripped === annotated) return true;
      if ((annotated.flags & TypeFlags.Union) !== 0 && (stripped.flags & TypeFlags.Union) !== 0)
        if (isTypeIdenticalTo(c, annotated, stripped)) return true;
    }
    if (getRegularTypeOfLiteralType(c, annotated) === getRegularTypeOfLiteralType(c, t)) return true;
    return (
      (annotated.flags & TypeFlags.Union) !== 0 &&
      (t.flags & TypeFlags.Union) !== 0 &&
      isTypeIdenticalTo(c, annotated, t)
    );
  }

  /** The annotation of a parameter or property declaration, reused when it still denotes the declared type. */
  declaredTypeText(declaration: Node | undefined, t: Type): string | undefined {
    if (this.enclosingDeclaration === undefined || declaration === undefined || nodeIsSynthesized(declaration))
      return undefined;
    if ((t.objectFlags & ObjectFlags.RequiresWidening) !== 0) return undefined;
    let annotation: Node | undefined;
    let isOptionalAnnotated = false;
    switch (declaration.kind) {
      case SyntaxKind.Parameter: {
        // Initialized parameters may need `undefined` added, which the annotation doesn't say.
        if (getInitializer(declaration) !== undefined) return undefined;
        annotation = getType(declaration);
        isOptionalAnnotated = hasQuestionToken(declaration);
        break;
      }
      case SyntaxKind.PropertySignature:
      case SyntaxKind.PropertyDeclaration:
        annotation = getType(declaration);
        isOptionalAnnotated = hasQuestionToken(declaration);
        break;
      case SyntaxKind.VariableDeclaration:
        annotation = getType(declaration);
        break;
      case SyntaxKind.GetAccessor:
        annotation = getType(declaration);
        break;
      case SyntaxKind.SetAccessor: {
        const params = getParameters(declaration)!.nodes;
        annotation = params.length !== 0 ? getType(params[0]!) : undefined;
        break;
      }
    }
    if (annotation === undefined || !this.annotationDenotes(annotation, t, isOptionalAnnotated)) return undefined;
    return this.reuseExistingTypeNode(annotation);
  }

  /** An existing type node printed as written; its length counts as its source span. */
  reuseExistingTypeNode(node: Node): string {
    const saveLength = this.approximateLength;
    const text = this.existingTypeNode(node);
    this.approximateLength = saveLength + node.end - node.pos;
    return text;
  }

  /** A type node as written, or its type printed where it can't be reused. */
  existingTypeNode(node: Node): string {
    return this.existingTypeNodeText(node) ?? this.type(this.typeFromTypeNode(node));
  }

  /** `existingTypeNode` parenthesized when it binds looser than `precedence`. */
  existingTypeNodeAt(node: Node, precedence: Precedence): string {
    const text = this.existingTypeNode(node);
    return typeTextPrecedence(text) < precedence ? '(' + text + ')' : text;
  }

  existingTypeNodes(list: NodeList | undefined, precedence: Precedence): string[] {
    const result: string[] = [];
    if (list !== undefined) for (const n of list.nodes) result.push(this.existingTypeNodeAt(n, precedence));
    return result;
  }

  /** The text of a reusable type node, or undefined when part of it can't be reused. */
  existingTypeNodeText(node: Node): string | undefined {
    switch (node.kind) {
      case SyntaxKind.AnyKeyword:
      case SyntaxKind.UnknownKeyword:
      case SyntaxKind.NumberKeyword:
      case SyntaxKind.BigIntKeyword:
      case SyntaxKind.ObjectKeyword:
      case SyntaxKind.BooleanKeyword:
      case SyntaxKind.StringKeyword:
      case SyntaxKind.SymbolKeyword:
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.NeverKeyword:
      case SyntaxKind.IntrinsicKeyword:
        return tokenToString(node.kind);
      case SyntaxKind.ThisType:
        return 'this';
      case SyntaxKind.TypeReference:
        return this.existingTypeReference(node as TypeReferenceNode);
      case SyntaxKind.ArrayType:
        return this.existingTypeNodeAt((node as ArrayTypeNode).elementType, Precedence.Postfix) + '[]';
      case SyntaxKind.TupleType:
        return '[' + this.existingTypeNodes((node as TupleTypeNode).elements, Precedence.Lowest).join(', ') + ']';
      case SyntaxKind.NamedTupleMember: {
        const member = node as NamedTupleMember;
        return (
          (member.dotDotDotToken !== undefined ? '...' : '') +
          getText(member.name) +
          (member.questionToken !== undefined ? '?' : '') +
          ': ' +
          this.existingTypeNode(member.type)
        );
      }
      case SyntaxKind.OptionalType:
        return this.existingTypeNodeAt((node as OptionalTypeNode).type, Precedence.Postfix) + '?';
      case SyntaxKind.RestType:
        return '...' + this.existingTypeNode((node as RestTypeNode).type);
      case SyntaxKind.UnionType:
        return this.existingTypeNodes((node as UnionTypeNode).types, Precedence.TypeOperator).join(' | ');
      case SyntaxKind.IntersectionType:
        return this.existingTypeNodes((node as IntersectionTypeNode).types, Precedence.TypeOperator).join(' & ');
      case SyntaxKind.ParenthesizedType:
        return '(' + this.existingTypeNode((node as ParenthesizedTypeNode).type) + ')';
      case SyntaxKind.FunctionType:
      case SyntaxKind.ConstructorType: {
        const text = this.existingSignature(node);
        if (text === undefined) return undefined;
        if (node.kind === SyntaxKind.FunctionType)
          return text.typeParameters + text.parameters + ' => ' + text.returnType;
        const modifiers = (node as ConstructorTypeNode).modifiers;
        const isAbstract =
          modifiers !== undefined && modifiers.nodes.some((m) => m.kind === SyntaxKind.AbstractKeyword);
        return (
          (isAbstract ? 'abstract ' : '') + 'new ' + text.typeParameters + text.parameters + ' => ' + text.returnType
        );
      }
      case SyntaxKind.TypeLiteral: {
        const members: string[] = [];
        for (const member of (node as TypeLiteralNode).members.nodes) {
          const text = this.existingTypeElement(member);
          if (text === undefined) return undefined;
          members.push(text);
        }
        return members.length === 0 ? '{}' : '{ ' + members.join(' ') + ' }';
      }
      case SyntaxKind.LiteralType:
        return existingLiteralText((node as LiteralTypeNode).literal);
      case SyntaxKind.TemplateLiteralType: {
        const template = node as TemplateLiteralTypeNode;
        let text = '`' + template.head.rawText;
        for (const span of template.templateSpans.nodes) {
          const typeSpan = span as TemplateLiteralTypeSpan;
          const literal = typeSpan.literal;
          const rawText =
            literal.kind === SyntaxKind.TemplateTail
              ? (literal as TemplateTail).rawText
              : (literal as TemplateMiddle).rawText;
          text += '${' + this.existingTypeNode(typeSpan.type) + '}' + rawText;
        }
        return text + '`';
      }
      case SyntaxKind.TypeOperator: {
        const operator = node as TypeOperatorNode;
        // A `unique symbol` annotation only means its own declaration's symbol.
        if (operator.operator === SyntaxKind.UniqueKeyword) return undefined;
        return tokenToString(operator.operator) + ' ' + this.existingTypeNodeAt(operator.type, Precedence.TypeOperator);
      }
      case SyntaxKind.IndexedAccessType: {
        const access = node as IndexedAccessTypeNode;
        return (
          this.existingTypeNodeAt(access.objectType, Precedence.Postfix) +
          '[' +
          this.existingTypeNode(access.indexType) +
          ']'
        );
      }
      case SyntaxKind.MappedType: {
        const mapped = node as MappedTypeNode;
        if (mapped.members !== undefined && mapped.members.nodes.length !== 0) return undefined;
        const readonlyToken = mapped.readonlyToken;
        const questionToken = mapped.questionToken;
        const typeParameter = mapped.typeParameter;
        if (typeParameter.constraint === undefined) return undefined;
        return (
          '{ ' +
          (readonlyToken === undefined
            ? ''
            : readonlyToken.kind === SyntaxKind.ReadonlyKeyword
              ? 'readonly '
              : tokenToString(readonlyToken.kind) + 'readonly ') +
          '[' +
          getText(typeParameter.name) +
          ' in ' +
          this.existingTypeNode(typeParameter.constraint) +
          (mapped.nameType !== undefined ? ' as ' + this.existingTypeNode(mapped.nameType) : '') +
          ']' +
          (questionToken === undefined
            ? ''
            : questionToken.kind === SyntaxKind.QuestionToken
              ? '?'
              : tokenToString(questionToken.kind) + '?') +
          ': ' +
          (mapped.type !== undefined ? this.existingTypeNode(mapped.type) : 'any') +
          '; }'
        );
      }
      case SyntaxKind.ConditionalType: {
        const conditional = node as ConditionalTypeNode;
        return (
          this.existingTypeNodeAt(conditional.checkType, Precedence.Conditional + 1) +
          ' extends ' +
          this.existingTypeNodeAt(conditional.extendsType, Precedence.Conditional + 1) +
          ' ? ' +
          this.existingTypeNode(conditional.trueType) +
          ' : ' +
          this.existingTypeNode(conditional.falseType)
        );
      }
      case SyntaxKind.InferType: {
        const typeParameter = (node as InferTypeNode).typeParameter;
        return (
          'infer ' +
          getText(typeParameter.name) +
          (typeParameter.constraint !== undefined
            ? ' extends ' + this.existingTypeNodeAt(typeParameter.constraint, Precedence.Conditional + 1)
            : '')
        );
      }
      case SyntaxKind.TypeQuery: {
        const query = node as TypeQueryNode;
        const args = this.existingTypeNodes(query.typeArguments, Precedence.Lowest);
        return 'typeof ' + entityNameToString(query.exprName) + (args.length !== 0 ? '<' + args.join(', ') + '>' : '');
      }
      case SyntaxKind.JSDocTypeExpression:
        return this.existingTypeNode((node as JSDocTypeExpression).type);
      case SyntaxKind.JSDocAllType:
        return 'any';
      case SyntaxKind.JSDocNullableType:
        return this.existingTypeNodeAt((node as JSDocNullableType).type, Precedence.TypeOperator) + ' | null';
      case SyntaxKind.JSDocOptionalType:
        return this.existingTypeNodeAt((node as JSDocOptionalType).type, Precedence.TypeOperator) + ' | undefined';
      case SyntaxKind.JSDocNonNullableType:
        return this.existingTypeNode((node as JSDocNonNullableType).type);
      case SyntaxKind.JSDocVariadicType:
        return this.existingTypeNodeAt((node as JSDocVariadicType).type, Precedence.Postfix) + '[]';
    }
    return undefined;
  }

  existingTypeReference(node: TypeReferenceNode): string | undefined {
    const c = this.c;
    if (isConstTypeReference(node)) return undefined;
    const typeName = node.typeName;
    if (typeName.kind === SyntaxKind.Identifier && getText(typeName) === '') return 'any';
    const t = this.typeFromTypeNode(node);
    const symbol = getSymbolFromTypeReference(c, node);
    if ((symbol.flags & SymbolFlags.TypeParameter) !== 0 && this.mapper !== undefined) {
      // A type parameter the signature being printed maps to another type reads as that type.
      const declared = getDeclaredTypeOfSymbol(c, symbol);
      if (this.mapper.map(declared) !== declared) return undefined;
    }
    // JavaScript-style names, and references that leave out type arguments, print their types.
    if (getIntendedTypeFromJSDocTypeReference(c, node) !== undefined) return undefined;
    if ((t.objectFlags & ObjectFlags.Reference) !== 0 && symbol !== c.unknownSymbol) {
      const target = getDeclaredTypeOfSymbol(c, symbol);
      if (target === (t as TypeReference).target) {
        const count = node.typeArguments !== undefined ? node.typeArguments.nodes.length : 0;
        if (count < getMinTypeArgumentCount(c, (target as InterfaceType).typeParameters())) return undefined;
      }
    }
    const args = this.existingTypeNodes(node.typeArguments, Precedence.Lowest);
    return entityNameToString(typeName) + (args.length !== 0 ? '<' + args.join(', ') + '>' : '');
  }

  /** The parts of an existing signature node; missing parameter and return types are `any`. */
  existingSignature(node: Node): { typeParameters: string; parameters: string; returnType: string } | undefined {
    let typeParameters = '';
    const typeParameterList = getTypeParameters(node);
    if (typeParameterList !== undefined && typeParameterList.nodes.length !== 0) {
      const parts: string[] = [];
      for (const tp of typeParameterList.nodes) parts.push(this.existingTypeParameter(tp as TypeParameterDeclaration));
      typeParameters = '<' + parts.join(', ') + '>';
    }
    const parameters: string[] = [];
    for (const p of getParameters(node)!.nodes) {
      const param = p as ParameterDeclaration;
      const name = param.name;
      let nameText: string;
      if (name.kind === SyntaxKind.Identifier) nameText = getText(name);
      else if (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
        nameText = bindingPatternText(name);
      else return undefined;
      const modifiers = param.modifiers;
      let modifierText = '';
      if (modifiers !== undefined) for (const m of modifiers.nodes) modifierText += tokenToString(m.kind) + ' ';
      parameters.push(
        modifierText +
          (param.dotDotDotToken !== undefined ? '...' : '') +
          nameText +
          (param.questionToken !== undefined ? '?' : '') +
          ': ' +
          (param.type !== undefined ? this.existingTypeNode(param.type) : 'any'),
      );
    }
    const returnTypeNode = getType(node);
    return {
      typeParameters,
      parameters: '(' + parameters.join(', ') + ')',
      returnType: returnTypeNode !== undefined ? this.existingTypePredicateOrType(returnTypeNode) : 'any',
    };
  }

  existingTypePredicateOrType(node: Node): string {
    if (node.kind !== SyntaxKind.TypePredicate) return this.existingTypeNode(node);
    const predicate = node as TypePredicateNode;
    return (
      (predicate.assertsModifier !== undefined ? 'asserts ' : '') +
      (predicate.parameterName.kind === SyntaxKind.ThisType ? 'this' : getText(predicate.parameterName)) +
      (predicate.type !== undefined ? ' is ' + this.existingTypeNode(predicate.type) : '')
    );
  }

  existingTypeParameter(tp: TypeParameterDeclaration): string {
    let text = '';
    if (tp.modifiers !== undefined) for (const m of tp.modifiers.nodes) text += tokenToString(m.kind) + ' ';
    text += getText(tp.name);
    if (tp.constraint !== undefined) text += ' extends ' + this.existingTypeNode(tp.constraint);
    if (tp.defaultType !== undefined) text += ' = ' + this.existingTypeNode(tp.defaultType);
    return text;
  }

  /** A member of an existing type literal, ending in `;`. */
  existingTypeElement(member: Node): string | undefined {
    const nameNode = getName(member);
    let name = '';
    if (nameNode !== undefined) {
      const text = existingPropertyNameText(nameNode);
      if (text === undefined) return undefined;
      name = text;
    }
    let modifiers = '';
    const modifierList = getModifiers(member);
    if (modifierList !== undefined) for (const m of modifierList.nodes) modifiers += tokenToString(m.kind) + ' ';
    const question = hasQuestionToken(member) ? '?' : '';
    switch (member.kind) {
      case SyntaxKind.PropertySignature: {
        const type = getType(member);
        return modifiers + name + question + ': ' + (type !== undefined ? this.existingTypeNode(type) : 'any') + ';';
      }
      case SyntaxKind.MethodSignature:
      case SyntaxKind.CallSignature:
      case SyntaxKind.ConstructSignature:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor: {
        const text = this.existingSignature(member);
        if (text === undefined) return undefined;
        const head = text.typeParameters + text.parameters;
        switch (member.kind) {
          case SyntaxKind.MethodSignature:
            return modifiers + name + question + head + ': ' + text.returnType + ';';
          case SyntaxKind.CallSignature:
            return head + ': ' + text.returnType + ';';
          case SyntaxKind.ConstructSignature:
            return 'new ' + head + ': ' + text.returnType + ';';
          case SyntaxKind.GetAccessor:
            return (
              modifiers + 'get ' + name + head + (getType(member) !== undefined ? ': ' + text.returnType : '') + ';'
            );
          default:
            return modifiers + 'set ' + name + head + ';';
        }
      }
      case SyntaxKind.IndexSignature: {
        const text = this.existingSignature(member);
        if (text === undefined) return undefined;
        return modifiers + '[' + text.parameters.slice(1, -1) + ']: ' + text.returnType + ';';
      }
    }
    return undefined;
  }

  // ---- Symbols

  uniqueSymbolReference(symbol: Symbol): string {
    const parent = getParentOfSymbol(this.c, symbol);
    if (parent !== undefined && parent.name === 'SymbolConstructor' && (symbol.flags & SymbolFlags.Property) !== 0) {
      this.approximateLength += symbol.name.length + 7;
      return 'Symbol.' + symbol.name;
    }
    return this.symbolReference(symbol, SymbolFlags.Value);
  }

  /** The (qualified) name of a symbol as a type or value reference. */
  symbolReference(symbol: Symbol, meaning: SymbolFlags): string {
    const name = this.symbolChainText(symbol, meaning);
    this.approximateLength += name.length + 1;
    return name;
  }

  symbolChainText(symbol: Symbol, meaning: SymbolFlags): string {
    const c = this.c;
    // Unresolved names print as written.
    if ((symbol.checkFlags & CheckFlags.Unresolved) !== 0)
      return symbol.parent !== undefined
        ? this.symbolChainText(symbol.parent, meaning) + '.' + symbol.name
        : symbol.name;
    // Without an enclosing declaration, names are qualified only on request.
    if ((this.flags & PrintFlags.UseFullyQualifiedType) === 0) return initialSymbolName(symbol);
    let text = symbolNameForChain(symbol);
    let current = symbol;
    for (;;) {
      const parent = getParentOfSymbol(c, current);
      if (parent === undefined || !isQualifyingParent(parent)) break;
      if (
        (parent.flags & SymbolFlags.Class) !== 0 &&
        (current.flags & SymbolFlags.Prototype) === 0 &&
        meaning === SymbolFlags.Type
      )
        break;
      text = symbolNameForChain(parent) + '.' + text;
      current = parent;
    }
    return current === symbol ? initialSymbolName(symbol) : text;
  }
}

function hasQuestionToken(node: Node): boolean {
  const token = getQuestionToken(node) ?? getPostfixToken(node);
  return token !== undefined && token.kind === SyntaxKind.QuestionToken;
}

/** A literal of an existing literal type node, quoted as written. */
function existingLiteralText(literal: Node): string | undefined {
  switch (literal.kind) {
    case SyntaxKind.StringLiteral:
      return quoteString(
        (literal as StringLiteral).text,
        ((literal as StringLiteral).tokenFlags & TokenFlags.SingleQuote) !== 0,
      );
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
      return getText(literal);
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return '`' + escapeTemplate(getText(literal)) + '`';
    case SyntaxKind.TrueKeyword:
      return 'true';
    case SyntaxKind.FalseKeyword:
      return 'false';
    case SyntaxKind.NullKeyword:
      return 'null';
    case SyntaxKind.PrefixUnaryExpression: {
      const unary = literal as PrefixUnaryExpression;
      const operand = existingLiteralText(unary.operand);
      return operand === undefined ? undefined : tokenToString(unary.operator) + operand;
    }
  }
  return undefined;
}

/** The name of a member of an existing type literal, or undefined for names computed from other expressions. */
function existingPropertyNameText(name: Node): string | undefined {
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.NumericLiteral:
      return getText(name);
    case SyntaxKind.StringLiteral:
      return existingLiteralText(name);
    case SyntaxKind.ComputedPropertyName: {
      const expression = (name as ComputedPropertyName).expression;
      if (expression.kind === SyntaxKind.Identifier || expression.kind === SyntaxKind.PropertyAccessExpression)
        return '[' + entityNameToString(expression) + ']';
      return undefined;
    }
  }
  return undefined;
}

/** The symbol a static method or non-local function's type can be named by with `typeof`, if it can be. */
function typeOfFunctionSymbol(c: Checker, symbol: Symbol, enclosingDeclaration: Node | undefined): Symbol | undefined {
  const isStaticMethod = (symbol.flags & SymbolFlags.Method) !== 0 && symbol.declarations.some((d) => isStatic(d));
  if (isStaticMethod) return symbol;
  if ((symbol.flags & SymbolFlags.Function) === 0) return undefined;
  if (symbol.parent !== undefined) return symbol;
  for (const d of symbol.declarations) {
    const parent = d.parent!;
    if (parent.kind === SyntaxKind.SourceFile || parent.kind === SyntaxKind.ModuleBlock) return symbol;
    if (
      (d.kind === SyntaxKind.FunctionExpression || d.kind === SyntaxKind.ArrowFunction) &&
      parent.kind === SyntaxKind.VariableDeclaration &&
      parent.parent!.kind === SyntaxKind.VariableDeclarationList &&
      parent.parent!.parent!.kind === SyntaxKind.VariableStatement &&
      parent.parent!.parent!.parent !== undefined &&
      (parent.parent!.parent!.parent.kind === SyntaxKind.SourceFile ||
        parent.parent!.parent!.parent.kind === SyntaxKind.ModuleBlock)
    ) {
      const valueParent = symbol.valueDeclaration?.parent;
      if (valueParent !== undefined && valueParent !== enclosingDeclaration) {
        const variable = getSymbol(valueParent);
        return variable !== undefined ? getMergedSymbol(c, variable) : symbol;
      }
      return symbol;
    }
  }
  return undefined;
}

/** The specifier an external module is printed with in `import("…")`: its ambient name or extensionless path. */
function getExternalModuleSpecifierText(symbol: Symbol): string | undefined {
  const name = symbol.name;
  if (name.length >= 2 && name.charCodeAt(0) === 0x22 && name.charCodeAt(name.length - 1) === 0x22)
    return name.substring(1, name.length - 1);
  const d = symbol.valueDeclaration;
  if (d === undefined || d.kind !== SyntaxKind.SourceFile) return undefined;
  const fileName = (d as SourceFile).fileName;
  for (const extension of ['.d.ts', '.d.mts', '.d.cts', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
    if (fileName.endsWith(extension)) return fileName.substring(0, fileName.length - extension.length);
  return fileName;
}

/** The first name of a chain: a default export goes by its declared name. */
function initialSymbolName(symbol: Symbol): string {
  if (symbol.name === InternalSymbolName.Default)
    for (const d of symbol.declarations) {
      const name = getNameOfDeclaration(d);
      if (name !== undefined) return declarationNameToString(getSourceFileOfNode(name), name);
    }
  return symbolNameForChain(symbol);
}

function typesAreSameReference(a: Type, b: Type): boolean {
  return a === b || (a.symbol !== undefined && a.symbol === b.symbol) || (a.alias !== undefined && a.alias === b.alias);
}

function isQualifyingParent(symbol: Symbol): boolean {
  if ((symbol.flags & (SymbolFlags.Module | SymbolFlags.Enum)) === 0) return false;
  // External modules and the global scope don't qualify.
  if (symbol.name.charCodeAt(0) === 0x22) return false;
  if (symbol.valueDeclaration !== undefined && symbol.valueDeclaration.kind === SyntaxKind.SourceFile) return false;
  return true;
}

function isIterableTypeWithDefaults(c: Checker, t: Type): boolean {
  return (
    isReferenceToType(t, getGlobalIterableType(c, false)) ||
    isReferenceToType(t, getGlobalIterableIteratorType(c, false)) ||
    isReferenceToType(t, getGlobalIterableType(c, true)) ||
    isReferenceToType(t, getGlobalIterableIteratorType(c, true))
  );
}

function hasAllTypeArgumentsWritten(t: TypeReference, typeParameterCount: number): boolean {
  const node = t.node;
  if (node === undefined || node.kind !== SyntaxKind.TypeReference) return false;
  const typeArguments = (node as TypeReferenceNode).typeArguments;
  return typeArguments !== undefined && typeArguments.nodes.length >= typeParameterCount;
}

function symbolNameForChain(symbol: Symbol): string {
  const name = symbol.name;
  if (name === InternalSymbolName.Default) return 'default';
  if (name.charCodeAt(0) === 0xfffe) return internalNameText(symbol);
  return name;
}

function internalNameText(symbol: Symbol): string {
  const name = symbol.name;
  if (name === InternalSymbolName.Class || name === InternalSymbolName.Function) {
    // Class and function expressions print the name they're assigned to, else `(Anonymous …)`.
    for (const d of symbol.declarations) {
      const n = getNameOfDeclaration(d);
      if (n !== undefined) return declarationNameToString(getSourceFileOfNode(n), n);
    }
    const d = symbol.declarations.length !== 0 ? symbol.declarations[0]! : symbol.valueDeclaration;
    if (d !== undefined && d.parent !== undefined && d.parent.kind === SyntaxKind.VariableDeclaration) {
      const n = getName(d.parent);
      if (n !== undefined) return declarationNameToString(getSourceFileOfNode(n), n);
    }
    return name === InternalSymbolName.Class ? '(Anonymous class)' : '(Anonymous function)';
  }
  if (name === InternalSymbolName.Type || name === InternalSymbolName.Object) return '__type';
  // `declare global` prints its keyword name.
  if (name === InternalSymbolName.Global && symbol.declarations.length > 0) {
    const n = getName(symbol.declarations[0]!);
    if (n !== undefined && n.kind === SyntaxKind.Identifier) return getText(n);
  }
  if (name.startsWith('￾@')) {
    // A unique symbol name: `[Symbol.iterator]` style for well-known symbols.
    const at = name.indexOf('@', 2);
    return '[' + name.substring(2, at < 0 ? name.length : at) + ']';
  }
  // Private names are `#<class id>@#name`.
  if (name.startsWith('￾#')) return name.substring(name.indexOf('@') + 1);
  return '__' + name.substring(1);
}

function getTypeAliasForTypeLiteral(c: Checker, t: Type): Symbol | undefined {
  const symbol = t.symbol;
  if (symbol === undefined || (symbol.flags & SymbolFlags.TypeLiteral) === 0 || symbol.declarations.length === 0)
    return undefined;
  let node = symbol.declarations[0]!.parent;
  while (node !== undefined && node.kind === SyntaxKind.ParenthesizedType) node = node.parent;
  if (node !== undefined && node.kind === SyntaxKind.TypeAliasDeclaration) return getSymbol(node);
  return undefined;
}

function getParentSymbolOfTypeParameter(c: Checker, tp: Type): Symbol | undefined {
  const symbol = tp.symbol;
  if (symbol === undefined || symbol.declarations.length === 0) return undefined;
  const container = symbol.declarations[0]!.parent;
  if (container === undefined) return undefined;
  const s = getSymbol(container);
  return s;
}

function parameterNameOfIndexSignature(declaration: Node): string {
  const params = getParameters(declaration)!.nodes;
  if (params.length === 0) return 'x';
  const name = getName(params[0]!);
  return name !== undefined && name.kind === SyntaxKind.Identifier ? getText(name) : 'x';
}

function bindingPatternText(node: Node): string {
  if (node.kind === SyntaxKind.Identifier) return getText(node);
  const elements = getElements(node)!.nodes;
  const parts: string[] = [];
  for (const e of elements) {
    if (e.kind === SyntaxKind.OmittedExpression) {
      parts.push('');
      continue;
    }
    const shape = e as BindingElement;
    let text = (shape.dotDotDotToken !== undefined ? '...' : '') + bindingPatternText(shape.name!);
    if (shape.propertyName !== undefined) text = bindingPropertyNameText(shape.propertyName) + ': ' + text;
    parts.push(text);
  }
  return node.kind === SyntaxKind.ObjectBindingPattern
    ? parts.length === 0
      ? '{}'
      : '{ ' + parts.join(', ') + ' }'
    : '[' + parts.join(', ') + ']';
}

function bindingPropertyNameText(name: Node): string {
  if (name.kind !== SyntaxKind.ComputedPropertyName) return getText(name);
  const expression = (name as ComputedPropertyName).expression;
  return '[' + (isEntityNameExpression(expression) ? entityNameToString(expression) : getText(expression)) + ']';
}

/** The name of a unique symbol: well-known symbols are members of the global `Symbol`, such as `Symbol.iterator`. */
function uniqueSymbolNameText(c: Checker, symbol: Symbol): string {
  const parent = getParentOfSymbol(c, symbol);
  if (parent !== undefined && parent.name === 'SymbolConstructor' && (symbol.flags & SymbolFlags.Property) !== 0)
    return 'Symbol.' + symbol.name;
  return symbolToString(c, symbol);
}

/** A property's name in an object type: as an identifier, a number, or a string quoted as declared. */
function propertyNameText(c: Checker, prop: Symbol): string {
  const declarationName = prop.valueDeclaration !== undefined ? getName(prop.valueDeclaration) : undefined;
  if (declarationName !== undefined && declarationName.kind === SyntaxKind.PrivateIdentifier)
    return getText(declarationName);
  const declarations = prop.declarations;
  const stringNamed = declarations.length !== 0 && declarations.every((d) => isStringNamed(c, d));
  const singleQuote = declarations.length !== 0 && declarations.every(isSingleQuotedStringNamed);
  const isMethod = (prop.flags & SymbolFlags.Method) !== 0;
  const nameType = c.symbolLinks(prop).nameType;
  if (nameType !== undefined) {
    if ((nameType.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral)) !== 0) {
      const name =
        (nameType.flags & TypeFlags.StringLiteral) !== 0
          ? (nameType as LiteralType).stringValue
          : numberText((nameType as LiteralType).numberValue);
      if (!isIdentifierText(name) && (stringNamed || !isNumericLiteralName(name)))
        return quoteString(name, singleQuote);
      if (isNumericLiteralName(name) && name.charCodeAt(0) === 0x2d) return '[-' + name.substring(1) + ']';
      return identifierOrLiteralName(name, singleQuote, stringNamed, isMethod);
    }
    if ((nameType.flags & TypeFlags.UniqueESSymbol) !== 0 && nameType.symbol !== undefined)
      return '[' + uniqueSymbolNameText(c, nameType.symbol) + ']';
  }
  const name = prop.name;
  if (name.charCodeAt(0) === 0xfffe) return internalNameText(prop);
  return identifierOrLiteralName(name, singleQuote, stringNamed, isMethod);
}

function identifierOrLiteralName(name: string, singleQuote: boolean, stringNamed: boolean, isMethod: boolean): string {
  if (isMethod && name === 'new') return quoteString(name, singleQuote);
  if (isIdentifierText(name)) return name;
  if (!stringNamed && isNumericLiteralName(name) && Number(name) >= 0) return name;
  return quoteString(name, singleQuote);
}

function isStringNamed(c: Checker, d: Node): boolean {
  const name = getNameOfDeclaration(d);
  if (name === undefined) return false;
  if (name.kind === SyntaxKind.ComputedPropertyName || name.kind === SyntaxKind.ElementAccessExpression) {
    const nameType = getSymbol(d) !== undefined ? c.symbolLinks(getSymbol(d)!).nameType : undefined;
    return nameType !== undefined && (nameType.flags & TypeFlags.StringLike) !== 0;
  }
  return name.kind === SyntaxKind.StringLiteral;
}

function isSingleQuotedStringNamed(d: Node): boolean {
  const name = getNameOfDeclaration(d);
  return (
    name !== undefined &&
    name.kind === SyntaxKind.StringLiteral &&
    ((name as StringLiteral).tokenFlags & TokenFlags.SingleQuote) !== 0
  );
}

function isNumericName(name: string): boolean {
  return name.length !== 0 && String(Number(name)) === name && Number(name) >= 0;
}

// ---- Precedence of printed types

const enum Precedence {
  Lowest = 0,
  Conditional = 1,
  Union = 2,
  Intersection = 3,
  TypeOperator = 4,
  Postfix = 5,
}

/** The precedence of a printed type's outermost form. */
function typeTextPrecedence(text: string): Precedence {
  let depth = 0;
  let inString = 0;
  let sawUnion = false;
  let sawIntersection = false;
  let sawArrow = false;
  let sawConditional = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString !== 0) {
      if (ch === 0x5c) i++;
      else if (ch === inString) inString = 0;
      continue;
    }
    if (ch === 0x22 || ch === 0x27 || ch === 0x60) {
      inString = ch;
      continue;
    }
    if (ch === 0x28 || ch === 0x5b || ch === 0x7b || ch === 0x3c) depth++;
    else if (ch === 0x29 || ch === 0x5d || ch === 0x7d || (ch === 0x3e && text.charCodeAt(i - 1) !== 0x3d)) depth--;
    else if (depth === 0) {
      if (ch === 0x7c && text.charCodeAt(i - 1) === 0x20) sawUnion = true;
      else if (ch === 0x26 && text.charCodeAt(i - 1) === 0x20) sawIntersection = true;
      else if (ch === 0x3d && text.charCodeAt(i + 1) === 0x3e) sawArrow = true;
      else if (ch === 0x3f && text.charCodeAt(i - 1) === 0x20 && text.charCodeAt(i + 1) === 0x20) sawConditional = true;
    }
  }
  if (sawArrow || sawConditional) return Precedence.Lowest;
  if (sawUnion) return Precedence.Union;
  if (sawIntersection) return Precedence.Intersection;
  if (
    text.startsWith('keyof ') ||
    text.startsWith('readonly ') ||
    text.startsWith('unique ') ||
    text.startsWith('typeof ') ||
    text.startsWith('new ') ||
    text.startsWith('abstract new ')
  )
    return text.startsWith('typeof ')
      ? Precedence.Postfix
      : text.startsWith('new ') || text.startsWith('abstract ')
        ? Precedence.Lowest
        : Precedence.TypeOperator;
  if (text.startsWith('infer ')) return Precedence.TypeOperator;
  return Precedence.Postfix;
}

function parenthesizeForArray(text: string): string {
  return typeTextPrecedence(text) < Precedence.Postfix ? '(' + text + ')' : text;
}

// ---- Literals

export function quoteString(s: string, singleQuote = false): string {
  // Unescaped runs are copied as slices, which keeps surrogate pairs whole in native builds.
  const quote = singleQuote ? "'" : '"';
  let result = quote;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const escape = stringEscape(s.charCodeAt(i), singleQuote);
    if (escape === '') continue;
    result += s.slice(start, i) + escape;
    start = i + 1;
  }
  return result + s.slice(start) + quote;
}

/** The escape sequence of a code unit in a quoted string, or '' if it needs none. */
function stringEscape(ch: number, singleQuote: boolean): string {
  switch (ch) {
    case 0x22:
      return singleQuote ? '' : '\\"';
    case 0x27:
      return singleQuote ? "\\'" : '';
    case 0x5c:
      return '\\\\';
    case 0x0a:
      return '\\n';
    case 0x0d:
      return '\\r';
    case 0x09:
      return '\\t';
    case 0x08:
      return '\\b';
    case 0x0b:
      return '\\v';
    case 0x0c:
      return '\\f';
    case 0x2028:
      return '\\u2028';
    case 0x2029:
      return '\\u2029';
    case 0x85:
      return '\\u0085';
  }
  return ch < 0x20 ? '\\u' + ch.toString(16).toUpperCase().padStart(4, '0') : '';
}

function escapeTemplate(s: string): string {
  let result = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    let escape = '';
    if (ch === 0x60) escape = '\\`';
    else if (ch === 0x5c) escape = '\\\\';
    else if (ch === 0x24 && s.charCodeAt(i + 1) === 0x7b) escape = '\\$';
    else if (ch === 0x0a) escape = '\\n';
    else if (ch === 0x0d) escape = '\\r';
    else if (ch === 0x09) escape = '\\t';
    if (escape === '') continue;
    result += s.slice(start, i) + escape;
    start = i + 1;
  }
  return result + s.slice(start);
}

export function numberText(n: number): string {
  return String(n);
}

// ---- Union formatting

/** Union constituents as printed: enum and boolean literal runs collapse, null and undefined go last. */
export function formatUnionTypes(c: Checker, types: readonly Type[], expandingEnum: boolean): Type[] {
  const result: Type[] = [];
  let flags = 0;
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    flags |= t.flags;
    if ((t.flags & TypeFlags.Nullable) !== 0) continue;
    if ((t.flags & TypeFlags.BooleanLiteral) !== 0 || (!expandingEnum && (t.flags & TypeFlags.EnumLike) !== 0)) {
      const baseType = (t.flags & TypeFlags.BooleanLiteral) !== 0 ? c.booleanType : getBaseTypeOfEnumLikeType(c, t);
      if ((baseType.flags & TypeFlags.Union) !== 0) {
        const baseTypes = typesOf(baseType);
        const count = baseTypes.length;
        if (
          i + count <= types.length &&
          getRegularTypeOfLiteralType(c, types[i + count - 1]!) ===
            getRegularTypeOfLiteralType(c, baseTypes[count - 1]!)
        ) {
          result.push(baseType);
          i += count - 1;
          continue;
        }
      }
    }
    result.push(t);
  }
  if ((flags & TypeFlags.Null) !== 0) result.push(c.nullType);
  if ((flags & TypeFlags.Undefined) !== 0) result.push(c.undefinedType);
  return result;
}

// ---- Entry points

export function typeToString(c: Checker, t: Type, enclosingDeclaration?: Node, flags?: number): string {
  if (c.serializationLevel >= 100) return '?';
  const noTruncation = c.compilerOptions.noErrorTruncation === true || ((flags ?? 0) & 1) !== 0;
  // Without explicit flags, unique symbols print as such, like tsgo's typeToString.
  const printer = new TypePrinter(c, flags ?? PrintFlags.AllowUniqueESSymbolType, noTruncation, enclosingDeclaration);
  c.serializationLevel++;
  const result = printer.type(t);
  c.serializationLevel--;
  const maxLength = noTruncation ? 2000000 : defaultMaximumTruncationLength * 2;
  if (result.length >= maxLength) return result.substring(0, maxLength - 3) + '...';
  return result;
}

export function symbolToString(c: Checker, symbol: Symbol): string {
  const printer = new TypePrinter(c, 0, true);
  if (
    (symbol.flags & (SymbolFlags.Property | SymbolFlags.Method | SymbolFlags.Accessor | SymbolFlags.EnumMember)) !==
      0 &&
    (symbol.flags & SymbolFlags.EnumMember) === 0
  )
    return memberNameText(c, symbol);
  if ((symbol.flags & SymbolFlags.EnumMember) !== 0) {
    const parent = getParentOfSymbol(c, symbol);
    return (
      (parent !== undefined ? printer.symbolChainText(parent, SymbolFlags.Value) + '.' : '') + memberNameText(c, symbol)
    );
  }
  return printer.symbolChainText(symbol, SymbolFlags.All);
}

/** A member's name as written in its first named declaration, else from its name type or symbol name. */
function memberNameText(c: Checker, symbol: Symbol): string {
  for (const d of symbol.declarations) {
    const name = getNameOfDeclaration(d);
    if (name === undefined) continue;
    const literalNameType = c.symbolLinks(symbol).nameType;
    if (
      name.kind !== SyntaxKind.ComputedPropertyName ||
      (symbol.checkFlags & CheckFlags.Late) !== 0 ||
      literalNameType === undefined ||
      (literalNameType.flags & TypeFlags.StringOrNumberLiteral) === 0
    )
      return declarationNameToString(getSourceFileOfNode(name), name);
    break;
  }
  const nameType = c.symbolLinks(symbol).nameType;
  if (nameType !== undefined && (nameType.flags & TypeFlags.UniqueESSymbol) !== 0 && nameType.symbol !== undefined)
    return '[' + symbolToString(c, nameType.symbol) + ']';
  const name = symbol.name;
  if (name.charCodeAt(0) === 0xfffe) return internalNameText(symbol);
  if (isIdentifierText(name) || isNumericName(name)) return name;
  return quoteString(name);
}

export function signatureToString(c: Checker, signature: Signature): string {
  const printer = new TypePrinter(c, 0, false);
  const isConstructor = (signature.flags & SignatureFlags.Construct) !== 0;
  return printer.signature(signature, isConstructor ? SyntaxKind.ConstructSignature : SyntaxKind.CallSignature, '');
}

export function typePredicateToString(c: Checker, predicate: TypePredicate): string {
  return new TypePrinter(c, 0, false).typePredicate(predicate);
}

import {
  getTrueTypeFromConditionalType as getTrueTypeLazy,
  getFalseTypeFromConditionalType as getFalseTypeLazy,
} from './checker-type-operators.js';

export type { IntrinsicType, TupleType, InterfaceType };
export { getCombinedModifierFlags, ModifierFlags };
