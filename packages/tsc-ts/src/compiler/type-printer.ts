// Printing types, symbols and signatures as text, like tsgo's node builder followed by its
// printer: the text diagnostics embed.
import {
  ModifierFlags,
  type Node,
  getName,
  getSymbol,
  type BindingElement,
  getDotDotDotToken,
  getElements,
  getInitializer,
  getParameters,
  getQuestionToken,
  getText,
} from './ast.js';
import {
  declarationNameToString,
  getCombinedModifierFlags,
  getNameOfDeclaration,
  getSourceFileOfNode,
} from './binder-utilities.js';
import { isIdentifierText } from './scanner.js';
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
  type UnionType,
} from './checker-types.js';
import {
  getRegularTypeOfLiteralType,
  getTypeArguments,
  getBaseTypeOfEnumLikeType,
  typesOf,
  filterType,
} from './checker-type-factory.js';
import { getParentOfSymbol } from './checker-symbols.js';
import {
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  getConstraintOfTypeParameter,
  getDefaultFromTypeParameter,
} from './checker-declared-types.js';
import {
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

const defaultMaximumTruncationLength = 160;

const enum PrintFlags {
  None = 0,
  WriteArrayAsGenericType = 1 << 1,
  UseFullyQualifiedType = 1 << 6,
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

  constructor(c: Checker, flags: number, noTruncation: boolean) {
    this.c = c;
    this.flags = flags;
    this.noTruncation = noTruncation;
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
    if (
      (flags & TypeFlags.TypeParameter) !== 0 ||
      ((flags & TypeFlags.Object) !== 0 && (objectFlags & ObjectFlags.ClassOrInterface) !== 0)
    ) {
      if (t.symbol !== undefined) return this.symbolReference(t.symbol, SymbolFlags.Type);
      return '?';
    }
    let u = t;
    if ((flags & TypeFlags.Union) !== 0 && (t as UnionType).origin !== undefined) u = (t as UnionType).origin!;
    if ((u.flags & (TypeFlags.Union | TypeFlags.Intersection)) !== 0) {
      const types = (u.flags & TypeFlags.Union) !== 0 ? formatUnionTypes(c, typesOf(u), expandingEnum) : typesOf(u);
      if (types.length === 1) return this.type(types[0]);
      const parts = this.typeList(
        types,
        true,
        (u.flags & TypeFlags.Union) !== 0 ? Precedence.Union : Precedence.Intersection,
      );
      return parts.join((u.flags & TypeFlags.Union) !== 0 ? ' | ' : ' & ');
    }
    if ((flags & TypeFlags.Object) !== 0 && (objectFlags & (ObjectFlags.Anonymous | ObjectFlags.Mapped)) !== 0)
      return this.anonymousType(t as ObjectType);
    if ((flags & TypeFlags.Index) !== 0) {
      this.approximateLength += 6;
      return 'keyof ' + this.typeAt((t as IndexType).target, Precedence.TypeOperator);
    }
    if ((flags & TypeFlags.TemplateLiteral) !== 0) {
      const template = t as TemplateLiteralType;
      let text = '`' + escapeTemplate(template.texts[0]);
      for (let i = 0; i < template.types.length; i++)
        text += '${' + this.type(template.types[i]) + '}' + escapeTemplate(template.texts[i + 1]);
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
          this.typeAt(types[0], precedence),
          '... ' + (types.length - 2) + ' more ...',
          this.typeAt(types[types.length - 1], precedence),
        ];
    }
    const result: string[] = [];
    for (let i = 0; i < types.length; i++) {
      const displayIndex = i + 1;
      if (this.checkTruncationLength() && displayIndex + 2 < types.length - 1) {
        result.push('... ' + (types.length - displayIndex) + ' more ...');
        result.push(this.typeAt(types[types.length - 1], precedence));
        break;
      }
      this.approximateLength += 2;
      result.push(this.typeAt(types[i], precedence));
    }
    if ((this.flags & PrintFlags.UseFullyQualifiedType) === 0) this.qualifyCollidingNames(types, result, precedence);
    return result;
  }

  /** Reprints plain names that occur more than once for different types, like `Foo.Yep | Bar.Yep`. */
  qualifyCollidingNames(types: readonly Type[], result: string[], precedence: Precedence): void {
    // Only entries printed one-to-one; truncation markers aren't types.
    if (result.length !== types.length) return;
    for (let i = 0; i < result.length; i++) {
      if (!isIdentifierText(result[i])) continue;
      let collides = false;
      for (let j = 0; j < result.length; j++)
        if (j !== i && result[j] === result[i] && !typesAreSameReference(types[i], types[j])) collides = true;
      if (!collides) continue;
      const saveFlags = this.flags;
      this.flags |= PrintFlags.UseFullyQualifiedType;
      const name = result[i];
      for (let j = i; j < result.length; j++) if (result[j] === name) result[j] = this.typeAt(types[j], precedence);
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
      return this.typeAt(typeArguments[0], Precedence.Postfix) + '[]';
    return this.symbolReference(symbol, SymbolFlags.Type) + this.typeArguments(typeArguments);
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
        return (target === c.globalArrayType ? 'Array' : 'ReadonlyArray') + '<' + this.type(typeArguments[0]) + '>';
      const element = this.typeAt(typeArguments[0], Precedence.Postfix) + '[]';
      return target === c.globalArrayType ? element : 'readonly ' + element;
    }
    if ((target.objectFlags & ObjectFlags.Tuple) !== 0) {
      const tuple = target as TupleType;
      const arity = tuple.typeParameters().length;
      const parts: string[] = [];
      const elementTypes: Type[] = [];
      for (let i = 0; i < arity; i++)
        elementTypes.push(
          removeMissingType(c, typeArguments[i], (tuple.elementInfos[i].flags & ElementFlags.Optional) !== 0),
        );
      const texts = elementTypes.length === 0 ? [] : this.typeList(elementTypes, false, Precedence.Lowest);
      for (let i = 0; i < texts.length; i++) {
        if (i >= tuple.elementInfos.length) {
          parts.push(texts[i]);
          continue;
        }
        const info = tuple.elementInfos[i];
        const flags = info.flags;
        let text = texts[i];
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
      const parent = getParentSymbolOfTypeParameter(c, outer[i]);
      do i++;
      while (i < outer.length && getParentSymbolOfTypeParameter(c, outer[i]) === parent);
      let same = true;
      for (let j = start; j < i; j++) if (outer[j] !== typeArguments[j]) same = false;
      if (!same && parent !== undefined)
        prefix =
          this.symbolReference(parent, SymbolFlags.Type) + this.typeArguments(typeArguments.slice(start, i)) + '.';
    }
    const typeParameterCount = Math.min(generic.typeParameters().length, typeArguments.length);
    const args = typeArguments.length > 0 ? typeArguments.slice(i, typeParameterCount) : [];
    if (prefix !== '') return prefix + t.symbol!.name + this.typeArguments(args);
    return this.symbolReference(t.symbol!, SymbolFlags.Type) + this.typeArguments(args);
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
          !isClassExpression(symbol)
        )
          return 'typeof ' + this.symbolReference(symbol, SymbolFlags.Value);
        if (
          (symbol.flags & (SymbolFlags.Enum | SymbolFlags.ValueModule)) !== 0 &&
          (t.objectFlags & ObjectFlags.Anonymous) !== 0
        )
          return 'typeof ' + this.symbolReference(symbol, SymbolFlags.Value);
      }
      if (this.visited.has(t.id)) {
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
      if (calls.length === 1 && constructs.length === 0) return this.signature(calls[0], SyntaxKind.FunctionType, '');
      if (constructs.length === 1 && calls.length === 0)
        return this.signature(constructs[0], SyntaxKind.ConstructorType, '');
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
        this.property(properties[properties.length - 1], result);
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
    const readonly = isReadonlySymbol(c, prop) ? 'readonly ' : '';
    if (readonly !== '') this.approximateLength += 9;
    result.push(readonly + name + optional + ': ' + this.type(propertyType) + ';');
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
    const extendsText = this.typeAt(t.extendsType, Precedence.Conditional + 1);
    const trueText = this.type(getTrueTypeLazy(c, t));
    const falseText = this.type(getFalseTypeLazy(c, t));
    this.approximateLength += 15;
    return checkText + ' extends ' + extendsText + ' ? ' + trueText + ' : ' + falseText;
  }

  // ---- Signatures

  signature(s: Signature, kind: SyntaxKind, name: string): string {
    const c = this.c;
    this.approximateLength += 3;
    let typeParameters = '';
    if (s.typeParameters.length !== 0)
      typeParameters = '<' + s.typeParameters.map((tp) => this.typeParameterDeclaration(tp)).join(', ') + '>';
    const params: string[] = [];
    if (s.thisParameter !== undefined) params.push('this: ' + this.type(getTypeOfSymbol(c, s.thisParameter)));
    for (let i = 0; i < s.parameters.length; i++)
      params.push(this.parameter(s.parameters[i], i === s.parameters.length - 1 && s.hasRestParameter()));
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
    return this.type(getReturnTypeOfSignature(c, s));
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
    this.approximateLength += name.length + 3;
    if (rest && t === c.anyType) t = c.anyArrayType;
    return (rest ? '...' : '') + name + (optional ? '?' : '') + ': ' + this.type(t);
  }

  typeParameterDeclaration(tp: Type): string {
    const c = this.c;
    let text = tp.symbol?.name ?? 'T';
    const constraint = getConstraintOfTypeParameter(c, tp);
    if (constraint !== undefined) text += ' extends ' + this.type(constraint);
    const defaultType = getDefaultFromTypeParameter(c, tp);
    if (defaultType !== undefined) text += ' = ' + this.type(defaultType);
    return text;
  }

  // ---- Symbols

  /** The (qualified) name of a symbol as a type or value reference. */
  symbolReference(symbol: Symbol, meaning: SymbolFlags): string {
    const name = this.symbolChainText(symbol, meaning);
    this.approximateLength += name.length;
    return name;
  }

  symbolChainText(symbol: Symbol, meaning: SymbolFlags): string {
    const c = this.c;
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

function symbolNameForChain(symbol: Symbol): string {
  const name = symbol.name;
  if (name === InternalSymbolName.Default) return 'default';
  if (name.charCodeAt(0) === 0xfffe) return internalNameText(symbol);
  return name;
}

function internalNameText(symbol: Symbol): string {
  const name = symbol.name;
  if (name === InternalSymbolName.Class || name === InternalSymbolName.Function) {
    // Anonymous class or function expressions print their variable's name or `(Anonymous …)`.
    const d = symbol.valueDeclaration;
    if (d !== undefined && d.parent !== undefined && d.parent.kind === SyntaxKind.VariableDeclaration) {
      const n = getName(d.parent);
      if (n !== undefined && n.kind === SyntaxKind.Identifier) return getText(n);
    }
    return name === InternalSymbolName.Class ? '(Anonymous class)' : '(Anonymous function)';
  }
  if (name === InternalSymbolName.Type || name === InternalSymbolName.Object) return '__type';
  if (name.startsWith('￾@')) {
    // A unique symbol name: `[Symbol.iterator]` style for well-known symbols.
    const at = name.indexOf('@', 2);
    return '[' + name.substring(2, at < 0 ? name.length : at) + ']';
  }
  // Private names are `#<class id>@#name`.
  if (name.startsWith('￾#')) return name.substring(name.indexOf('@') + 1);
  return '__' + name.substring(1);
}

function isClassExpression(symbol: Symbol): boolean {
  const d = symbol.valueDeclaration;
  return d !== undefined && d.kind === SyntaxKind.ClassExpression;
}

function getTypeAliasForTypeLiteral(c: Checker, t: Type): Symbol | undefined {
  const symbol = t.symbol;
  if (symbol === undefined || (symbol.flags & SymbolFlags.TypeLiteral) === 0 || symbol.declarations.length === 0)
    return undefined;
  let node = symbol.declarations[0].parent;
  while (node !== undefined && node.kind === SyntaxKind.ParenthesizedType) node = node.parent;
  if (node !== undefined && node.kind === SyntaxKind.TypeAliasDeclaration) return getSymbol(node);
  return undefined;
}

function getParentSymbolOfTypeParameter(c: Checker, tp: Type): Symbol | undefined {
  const symbol = tp.symbol;
  if (symbol === undefined || symbol.declarations.length === 0) return undefined;
  const container = symbol.declarations[0].parent;
  if (container === undefined) return undefined;
  const s = getSymbol(container);
  return s;
}

function parameterNameOfIndexSignature(declaration: Node): string {
  const params = getParameters(declaration)!.nodes;
  if (params.length === 0) return 'x';
  const name = getName(params[0]);
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
    if (shape.propertyName !== undefined) text = getText(shape.propertyName) + ': ' + text;
    parts.push(text);
  }
  return node.kind === SyntaxKind.ObjectBindingPattern
    ? parts.length === 0
      ? '{}'
      : '{ ' + parts.join(', ') + ' }'
    : '[' + parts.join(', ') + ']';
}

function propertyNameText(c: Checker, prop: Symbol): string {
  const nameType = c.symbolLinks(prop).nameType;
  if (nameType !== undefined) {
    if ((nameType.flags & TypeFlags.StringLiteral) !== 0) {
      const s = (nameType as LiteralType).stringValue;
      return isIdentifierText(s) ? s : quoteString(s);
    }
    if ((nameType.flags & TypeFlags.NumberLiteral) !== 0) return numberText((nameType as LiteralType).numberValue);
    if ((nameType.flags & TypeFlags.UniqueESSymbol) !== 0 && nameType.symbol !== undefined)
      return '[' + nameType.symbol.name + ']';
  }
  const name = prop.name;
  if (name.charCodeAt(0) === 0xfffe) return internalNameText(prop);
  if (isIdentifierText(name)) return name;
  if (isNumericName(name)) return name;
  return quoteString(name);
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

export function quoteString(s: string): string {
  let result = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    switch (ch) {
      case 0x22:
        result += '\\"';
        break;
      case 0x5c:
        result += '\\\\';
        break;
      case 0x0a:
        result += '\\n';
        break;
      case 0x0d:
        result += '\\r';
        break;
      case 0x09:
        result += '\\t';
        break;
      case 0x08:
        result += '\\b';
        break;
      case 0x0b:
        result += '\\v';
        break;
      case 0x0c:
        result += '\\f';
        break;
      case 0x2028:
        result += '\\u2028';
        break;
      case 0x2029:
        result += '\\u2029';
        break;
      case 0x85:
        result += '\\u0085';
        break;
      default:
        if (ch < 0x20) result += '\\u' + ch.toString(16).toUpperCase().padStart(4, '0');
        else result += String.fromCharCode(ch);
    }
  }
  return result + '"';
}

function escapeTemplate(s: string): string {
  let result = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x60) result += '\\`';
    else if (ch === 0x5c) result += '\\\\';
    else if (ch === 0x24 && s.charCodeAt(i + 1) === 0x7b) result += '\\$';
    else if (ch === 0x0a) result += '\\n';
    else if (ch === 0x0d) result += '\\r';
    else if (ch === 0x09) result += '\\t';
    else result += String.fromCharCode(ch);
  }
  return result;
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
    const t = types[i];
    flags |= t.flags;
    if ((t.flags & TypeFlags.Nullable) !== 0) continue;
    if ((t.flags & TypeFlags.BooleanLiteral) !== 0 || (!expandingEnum && (t.flags & TypeFlags.EnumLike) !== 0)) {
      const baseType = (t.flags & TypeFlags.BooleanLiteral) !== 0 ? c.booleanType : getBaseTypeOfEnumLikeType(c, t);
      if ((baseType.flags & TypeFlags.Union) !== 0) {
        const baseTypes = typesOf(baseType);
        const count = baseTypes.length;
        if (
          i + count <= types.length &&
          getRegularTypeOfLiteralType(c, types[i + count - 1]) === getRegularTypeOfLiteralType(c, baseTypes[count - 1])
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
  const printer = new TypePrinter(c, flags ?? 0, noTruncation);
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
