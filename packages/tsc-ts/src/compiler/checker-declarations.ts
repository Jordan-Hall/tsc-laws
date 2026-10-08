// Declarations: variables, parameters, functions, type aliases, enums, namespaces, imports, exports.
import {
  type BindingElement,
  type EnumDeclaration,
  type ImportEqualsDeclaration,
  type ModuleDeclaration,
  type SourceFile,
  type Node,
  type NodeList,
  NodeVisitor,
  type TypeAliasDeclaration,
  type TypeParameterDeclaration,
  type TypeReferenceNode,
  type VariableDeclarationList,
  type VariableStatement,
  getExpression,
  getInitializer,
  getName,
  getType,
  getElements,
  getSymbol,
  ModifierFlags,
  NodeFlags,
  getLocalSymbol,
  getBody,
  getDotDotDotToken,
  getParameters,
  getStatements,
  getText,
} from './ast.js';
import { isExternalModuleNameRelative } from './path.js';
import { shouldPreserveConstEnums } from './options.js';
import { checkTypeNameIsReserved } from './checker-classes.js';
import { isBindingPattern } from './checker-utilities.js';
import {
  declarationNameToString,
  getNameOfDeclaration,
  getSourceFileOfNode,
  ModuleInstanceState,
  JSDeclarationKind,
  getAssignmentDeclarationKind,
  getCombinedModifierFlags,
  getCombinedNodeFlags,
  isPartOfParameterDeclaration,
  getDeclarationOfKind,
  getModifierFlags,
  getModuleInstanceState,
  getRangeOfTokenAtPosition,
  hasSyntacticModifier,
  isEntityNameExpression,
  isEnumConst,
  isExternalModule,
  isModuleAugmentationExternal,
  isVariableDeclarationInitializedToRequire,
} from './binder-utilities.js';
import { Diagnostic, type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { InternalSymbolName, type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { type Type, TypeFlags, newTypeMapper } from './checker-types.js';
import { isErrorType } from './checker-type-factory.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  computeEnumMemberValues,
  getConstraintOfTypeParameter,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  getDeclaredTypeOfTypeParameter,
  fillMissingTypeArguments,
  getMinTypeArgumentCount,
} from './checker-declared-types.js';
import {
  getDeclarationOfAliasSymbol,
  getExportsOfModule,
  getMergedSymbol,
  getSymbolFlags,
  getSymbolOfDeclaration,
  resolveAlias,
  resolveName,
} from './checker-symbols.js';
import {
  getTypeOfSymbol,
  getWidenedTypeForVariableLikeDeclaration,
  isOptionalDeclaration,
} from './checker-symbol-types.js';
import {
  checkComputedPropertyName,
  checkExpressionCached,
  checkNonNullNonVoidType,
  checkTypeAssignableToAndOptionallyElaborate,
  isInAmbientOrTypeNode,
} from './checker-expressions.js';
import { IterationUse, checkIteratedTypeOrElementType } from './checker-iteration.js';
import { isTypeAssignableTo, isTypeIdenticalTo, checkTypeAssignableTo } from './relations.js';
import { getReducedType } from './checker-members.js';
import { instantiateType } from './instantiation.js';
import { symbolToString, typeToString } from './type-printer.js';
import { checkSourceElement, checkTypeNodeIfPresent } from './checker-source-file.js';
import { checkFunctionLikeBody } from './checker-functions.js';
import { ContainerFlags, getContainerFlags } from './binder.js';
import {
  isAmbientModule,
  isFunctionLike,
  isGlobalScopeAugmentation,
  nodeIsMissing,
  nodeIsPresent,
} from './ast-utilities.js';
import { getTypeForBindingElementParent } from './checker-destructuring.js';
import { checkFunctionOrMethodSymbols } from './checker-overloads.js';
import { checkJSDocFullSignature } from './checker-jsdoc.js';
import { checkAliasSymbol } from './checker-modules.js';
import { checkDecorators } from './checker-decorators.js';

// ---- Variables and parameters

export function checkVariableStatement(c: Checker, node: Node): void {
  checkVariableDeclarationList(c, (node as VariableStatement).declarationList);
}

export function checkVariableDeclarationList(c: Checker, node: Node): void {
  for (const d of (node as VariableDeclarationList).declarations.nodes) checkVariableLikeDeclaration(c, d);
}

/** Checks a variable, parameter, property or binding element declaration. */
export function checkVariableLikeDeclaration(c: Checker, node: Node): void {
  checkDecorators(c, node);
  if (node.kind === SyntaxKind.Parameter) checkParameter(c, node);
  const typeNode = getType(node);
  checkTypeNodeIfPresent(c, typeNode);
  const name = getName(node);
  if (node.kind === SyntaxKind.PropertySignature && name !== undefined && name.kind === SyntaxKind.PrivateIdentifier)
    c.error(node, Diagnostics.Private_identifiers_are_not_allowed_outside_class_bodies);
  if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, name);
  const initializer = getInitializer(node);
  // Parameter initializers need an implementation.
  const initializerNotAllowed =
    initializer !== undefined && node.kind === SyntaxKind.Parameter && nodeIsMissing(getBody(node.parent!));
  if (
    name !== undefined &&
    (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
  ) {
    if (initializerNotAllowed)
      c.error(node, Diagnostics.A_parameter_initializer_is_only_allowed_in_a_function_or_constructor_implementation);
    else if (initializer !== undefined) checkExpressionCached(c, initializer);
    for (const element of getElements(name)!.nodes) {
      if (element.kind === SyntaxKind.OmittedExpression) continue;
      checkBindingElement(c, element as BindingElement);
    }
    if (!initializerNotAllowed) checkBindingPatternInitializer(c, node, name, initializer);
    return;
  }
  if (initializerNotAllowed) {
    c.error(node, Diagnostics.A_parameter_initializer_is_only_allowed_in_a_function_or_constructor_implementation);
    return;
  }
  if (name !== undefined && name.kind === SyntaxKind.BigIntLiteral)
    c.error(name, Diagnostics.A_bigint_literal_cannot_be_used_as_a_property_name);
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) {
    if (initializer !== undefined) checkExpressionCached(c, initializer);
    return;
  }
  // `const x = require("m")` declares an alias.
  if ((symbol.flags & SymbolFlags.Alias) !== 0 && isVariableDeclarationInitializedToRequire(node)) {
    checkAliasSymbol(c, node);
    return;
  }
  const t = getTypeOfSymbol(c, symbol);
  if (
    node.kind !== SyntaxKind.PropertyDeclaration &&
    node.kind !== SyntaxKind.PropertySignature &&
    node.kind !== SyntaxKind.Parameter
  ) {
    checkExportsOnMergedDeclarations(c, node);
    if (node.kind === SyntaxKind.VariableDeclaration) checkVarDeclaredNamesNotShadowed(c, node, symbol);
  }
  if (node === symbol.valueDeclaration) {
    if (initializer !== undefined) {
      const initType = checkExpressionCached(c, initializer);
      if (typeNode !== undefined && !isErrorType(c, t))
        checkTypeAssignableToAndOptionallyElaborate(c, initType, t, node, initializer);
    }
    if (
      name !== undefined &&
      symbol.declarations.length > 1 &&
      symbol.declarations.some((d) => d !== node && isVariableLike(d) && !areDeclarationFlagsIdentical(d, node))
    )
      reportNonIdenticalModifiers(c, name);
    return;
  }
  if (
    name !== undefined &&
    symbol.valueDeclaration !== undefined &&
    !areDeclarationFlagsIdentical(node, symbol.valueDeclaration)
  )
    reportNonIdenticalModifiers(c, name);
  // A redeclaration: types must be identical.
  const declarationType = getWidenedTypeForVariableLikeDeclaration(c, node, false);
  if (
    !isErrorType(c, t) &&
    !isErrorType(c, declarationType) &&
    !isTypeIdenticalTo(c, t, declarationType) &&
    (symbol.flags & SymbolFlags.Assignment) === 0
  )
    errorNextVariableOrPropertyDeclarationMustHaveSameType(c, symbol.valueDeclaration, t, node, declarationType);
  if (initializer !== undefined) {
    const initType = checkExpressionCached(c, initializer);
    if (!isErrorType(c, declarationType))
      checkTypeAssignableToAndOptionallyElaborate(c, initType, declarationType, node, initializer);
  }
}

/** Checks the initializer of a binding pattern, and that a pattern without names destructures a valid type. */
function checkBindingPatternInitializer(c: Checker, node: Node, name: Node, initializer: Node | undefined): void {
  if (isInAmbientOrTypeNode(node)) return;
  // A for-in initializer is already an error.
  const needCheckInitializer = initializer !== undefined && node.parent!.parent!.kind !== SyntaxKind.ForInStatement;
  const needCheckWidenedType = !getElements(name)!.nodes.some((e) => getName(e) !== undefined);
  if (!needCheckInitializer && !needCheckWidenedType) return;
  const widenedType = getWidenedTypeForVariableLikeDeclaration(c, node, false);
  if (needCheckInitializer) {
    const initializerType = checkExpressionCached(c, initializer!);
    if (c.strictNullChecks && needCheckWidenedType) checkNonNullNonVoidType(c, initializerType, node);
    else
      checkTypeAssignableToAndOptionallyElaborate(
        c,
        initializerType,
        getWidenedTypeForVariableLikeDeclaration(c, node, false),
        node,
        initializer,
      );
  }
  if (needCheckWidenedType) {
    if (name.kind === SyntaxKind.ArrayBindingPattern)
      checkIteratedTypeOrElementType(c, IterationUse.Destructuring, widenedType, c.undefinedType, node);
    else if (c.strictNullChecks) checkNonNullNonVoidType(c, widenedType, node);
  }
}

/**
 * Reports a `var` that would hoist past a `let` or `const` of the same name declared in an inner
 * scope: the initializer would write to the block-scoped variable.
 */
function checkVarDeclaredNamesNotShadowed(c: Checker, node: Node, symbol: Symbol): void {
  if ((getCombinedNodeFlags(node) & NodeFlags.BlockScoped) !== 0 || isPartOfParameterDeclaration(node)) return;
  const name = getName(node);
  if ((symbol.flags & SymbolFlags.FunctionScopedVariable) === 0 || name === undefined) return;
  if (name.kind !== SyntaxKind.Identifier) return;
  const local = resolveName(c, node, getText(name), SymbolFlags.Variable, undefined, false, false);
  if (local === undefined || local === symbol || (local.flags & SymbolFlags.BlockScopedVariable) === 0) return;
  const declaration = local.valueDeclaration;
  if (declaration === undefined || (getCombinedNodeFlags(declaration) & NodeFlags.BlockScoped) === 0) return;
  let list: Node | undefined = declaration;
  while (list !== undefined && list.kind !== SyntaxKind.VariableDeclarationList) list = list.parent;
  const statement = list?.parent;
  const container =
    statement !== undefined && statement.kind === SyntaxKind.VariableStatement ? statement.parent : undefined;
  // Block-scoped variables of the function, module or file scope share it with hoisted `var`s.
  const namesShareScope =
    container !== undefined &&
    ((container.kind === SyntaxKind.Block && isFunctionLike(container.parent)) ||
      container.kind === SyntaxKind.ModuleBlock ||
      container.kind === SyntaxKind.ModuleDeclaration ||
      container.kind === SyntaxKind.SourceFile);
  if (namesShareScope) return;
  const localName = symbolToString(c, local);
  c.error(
    node,
    Diagnostics.Cannot_initialize_outer_scoped_variable_0_in_the_same_scope_as_block_scoped_declaration_1,
    localName,
    localName,
  );
}

/** Parameter properties, `this` parameters and rest parameter types. */
function checkParameter(c: Checker, node: Node): void {
  const fn = node.parent!;
  const name = getName(node);
  const paramName = name !== undefined && name.kind === SyntaxKind.Identifier ? getText(name) : '';
  if (hasSyntacticModifier(node, ModifierFlags.ParameterPropertyModifier)) {
    if (c.compilerOptions.erasableSyntaxOnly === true && (node.flags & NodeFlags.Ambient) === 0)
      c.error(node, Diagnostics.This_syntax_is_not_allowed_when_erasableSyntaxOnly_is_enabled);
    if (fn.kind !== SyntaxKind.Constructor || !nodeIsPresent(getBody(fn)))
      c.error(node, Diagnostics.A_parameter_property_is_only_allowed_in_a_constructor_implementation);
    if (fn.kind === SyntaxKind.Constructor && paramName === 'constructor')
      c.error(name, Diagnostics.X_constructor_cannot_be_used_as_a_parameter_property_name);
  }
  if (
    getInitializer(node) === undefined &&
    isOptionalDeclaration(node) &&
    isBindingPattern(name) &&
    getBody(fn) !== undefined
  )
    c.error(node, Diagnostics.A_binding_pattern_parameter_cannot_be_optional_in_an_implementation_signature);
  if (paramName === 'this' || paramName === 'new') {
    if (getParameters(fn)!.nodes.indexOf(node) !== 0)
      c.error(node, Diagnostics.A_0_parameter_must_be_the_first_parameter, paramName);
    if (
      fn.kind === SyntaxKind.Constructor ||
      fn.kind === SyntaxKind.ConstructSignature ||
      fn.kind === SyntaxKind.ConstructorType
    )
      c.error(node, Diagnostics.A_constructor_cannot_have_a_this_parameter);
    if (fn.kind === SyntaxKind.ArrowFunction) c.error(node, Diagnostics.An_arrow_function_cannot_have_a_this_parameter);
    if (fn.kind === SyntaxKind.GetAccessor || fn.kind === SyntaxKind.SetAccessor)
      c.error(node, Diagnostics.X_get_and_set_accessors_cannot_declare_this_parameters);
  }
  // Binding patterns in rest parameters are a grammar error. Generic rest types are skipped: the
  // implied `any[]` constraints of `infer` positions aren't computed yet.
  if (getDotDotDotToken(node) !== undefined && !isBindingPattern(name)) {
    const symbol = getSymbolOfDeclaration(c, node);
    const t = symbol !== undefined ? getReducedType(c, getTypeOfSymbol(c, symbol)) : undefined;
    if (
      t !== undefined &&
      (t.flags & TypeFlags.Instantiable) === 0 &&
      !isTypeAssignableTo(c, t, c.anyReadonlyArrayType)
    )
      c.error(node, Diagnostics.A_rest_parameter_must_be_of_an_array_type);
  }
}

function isVariableLike(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.BindingElement:
    case SyntaxKind.EnumMember:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.VariableDeclaration:
      return true;
  }
  return false;
}

function areDeclarationFlagsIdentical(left: Node, right: Node): boolean {
  // Parameters and variables may differ in optionality.
  if (
    (left.kind === SyntaxKind.Parameter && right.kind === SyntaxKind.VariableDeclaration) ||
    (left.kind === SyntaxKind.VariableDeclaration && right.kind === SyntaxKind.Parameter)
  )
    return true;
  if (isOptionalDeclaration(left) !== isOptionalDeclaration(right)) return false;
  const interestingFlags =
    ModifierFlags.Private |
    ModifierFlags.Protected |
    ModifierFlags.Async |
    ModifierFlags.Abstract |
    ModifierFlags.Readonly |
    ModifierFlags.Static;
  return (getModifierFlags(left) & interestingFlags) === (getModifierFlags(right) & interestingFlags);
}

function reportNonIdenticalModifiers(c: Checker, name: Node): void {
  c.error(
    name,
    Diagnostics.All_declarations_of_0_must_have_identical_modifiers,
    declarationNameToString(getSourceFileOfNode(name), name),
  );
}

function checkBindingElement(c: Checker, element: BindingElement): void {
  if (element.propertyName !== undefined && element.propertyName.kind === SyntaxKind.ComputedPropertyName)
    checkComputedPropertyName(c, element.propertyName);
  // Like tsgo, the parent type is computed here (for accessibility checks) as well as for the symbol.
  getTypeForBindingElementParent(c, element.parent!.parent!);
  const name = element.name;
  if (
    name !== undefined &&
    (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
  ) {
    for (const e of getElements(name)!.nodes)
      if (e.kind !== SyntaxKind.OmittedExpression) checkBindingElement(c, e as BindingElement);
  } else {
    const symbol = getSymbolOfDeclaration(c, element);
    if (
      symbol !== undefined &&
      (symbol.flags & SymbolFlags.Alias) !== 0 &&
      isVariableDeclarationInitializedToRequire(element)
    ) {
      checkAliasSymbol(c, element);
      return;
    }
    if (symbol !== undefined) {
      getTypeOfSymbol(c, symbol);
      checkExportsOnMergedDeclarations(c, element);
    }
  }
  if (element.initializer !== undefined) checkExpressionCached(c, element.initializer);
}

function errorNextVariableOrPropertyDeclarationMustHaveSameType(
  c: Checker,
  firstDeclaration: Node | undefined,
  firstType: Type,
  nextDeclaration: Node,
  nextType: Type,
): void {
  const nextDeclarationName = getNameOfDeclaration(nextDeclaration);
  const message =
    nextDeclaration.kind === SyntaxKind.PropertyDeclaration || nextDeclaration.kind === SyntaxKind.PropertySignature
      ? Diagnostics.Subsequent_property_declarations_must_have_the_same_type_Property_0_must_be_of_type_1_but_here_has_type_2
      : Diagnostics.Subsequent_variable_declarations_must_have_the_same_type_Variable_0_must_be_of_type_1_but_here_has_type_2;
  const declName = declarationNameToString(getSourceFileOfNode(nextDeclaration), nextDeclarationName);
  const err = c.error(nextDeclarationName, message, declName, typeToString(c, firstType), typeToString(c, nextType));
  if (firstDeclaration !== undefined)
    err.addRelatedInfo(
      createDiagnosticForNode(
        getNameOfDeclaration(firstDeclaration) ?? firstDeclaration,
        Diagnostics.X_0_was_also_declared_here,
        [declName],
      ),
    );
}

// ---- Functions

export function checkFunctionDeclaration(c: Checker, node: Node): void {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) getTypeOfSymbol(c, symbol);
  checkFunctionLikeBody(c, node);
  checkJSDocFullSignature(c, node);
  checkFunctionOrMethodSymbols(c, node);
}

// ---- Types

export function checkTypeParameter(c: Checker, node: Node): void {
  const tp = node as TypeParameterDeclaration;
  checkTypeNodeIfPresent(c, tp.constraint);
  checkTypeNodeIfPresent(c, tp.defaultType);
  const symbol = getSymbol(node);
  if (symbol === undefined) return;
  const typeParameter = getDeclaredTypeOfTypeParameter(c, symbol);
  getConstraintOfTypeParameter(c, typeParameter);
  if (tp.defaultType !== undefined) {
    const constraint = getConstraintOfTypeParameter(c, typeParameter);
    const defaultType = getTypeFromTypeNode(c, tp.defaultType);
    if (constraint !== undefined && !isErrorType(c, defaultType))
      checkTypeAssignableTo(
        c,
        defaultType,
        instantiateTypeWithSelf(c, constraint),
        tp.defaultType,
        Diagnostics.Type_0_does_not_satisfy_the_constraint_1,
      );
  }
}

/** Checks a type parameter list: each parameter, default ordering and duplicate names. */
export function checkTypeParameters(c: Checker, list: NodeList | undefined): void {
  if (list === undefined) return;
  const typeParameters = list.nodes;
  let seenDefault = false;
  for (let i = 0; i < typeParameters.length; i++) {
    const node = typeParameters[i] as TypeParameterDeclaration;
    checkTypeParameter(c, node);
    if (node.defaultType !== undefined) {
      seenDefault = true;
      const finder = new LaterTypeParameterReferenceFinder(c, typeParameters, i);
      finder.visitNode(node.defaultType);
    } else if (seenDefault) c.error(node, Diagnostics.Required_type_parameters_may_not_follow_optional_type_parameters);
    for (let j = 0; j < i; j++)
      if (getSymbol(typeParameters[j]) === getSymbol(node))
        c.error(
          node.name,
          Diagnostics.Duplicate_identifier_0,
          declarationNameToString(getSourceFileOfNode(node), node.name),
        );
  }
}

/** Reports references in a type parameter default to the parameter itself or later ones. */
class LaterTypeParameterReferenceFinder extends NodeVisitor {
  readonly c: Checker;
  readonly typeParameters: Node[];
  readonly index: number;

  constructor(c: Checker, typeParameters: Node[], index: number) {
    super();
    this.c = c;
    this.typeParameters = typeParameters;
    this.index = index;
  }

  visitNode(node: Node): boolean {
    if (node.kind === SyntaxKind.TypeReference) {
      const t = getTypeFromTypeNode(this.c, node);
      if ((t.flags & TypeFlags.TypeParameter) !== 0)
        for (let i = this.index; i < this.typeParameters.length; i++)
          if (t.symbol === getSymbolOfDeclaration(this.c, this.typeParameters[i]))
            this.c.error(
              node,
              Diagnostics.Type_parameter_defaults_can_only_reference_previously_declared_type_parameters,
            );
    }
    return node.forEachChild(this);
  }
}

function instantiateTypeWithSelf(_c: Checker, t: Type): Type {
  return t;
}

export function checkTypeAliasDeclaration(c: Checker, node: Node): void {
  const alias = node as TypeAliasDeclaration;
  const typeParameters = alias.typeParameters;
  checkTypeParameters(c, typeParameters);
  checkTypeNameIsReserved(c, alias.name, Diagnostics.Type_alias_name_cannot_be_0);
  checkExportsOnMergedDeclarations(c, node);
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) getDeclaredTypeOfSymbol(c, symbol);
  if (alias.type.kind !== SyntaxKind.IntrinsicKeyword) checkSourceElement(c, alias.type);
}

/** Checks the type arguments of a reference to a generic type against their constraints. */
export function checkTypeArgumentConstraintsOfReference(c: Checker, node: Node): void {
  const typeArgumentNodes = (node as TypeReferenceNode).typeArguments;
  if (typeArgumentNodes === undefined) return;
  const symbol = c.nodeLinks(node).resolvedSymbol;
  if (symbol === undefined || symbol === c.unknownSymbol) return;
  let typeParameters: readonly Type[] | undefined = undefined;
  if ((symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0)
    typeParameters = getDeclaredTypeOfClassOrInterface(c, getMergedSymbol(c, symbol)).localTypeParameters();
  else if ((symbol.flags & SymbolFlags.TypeAlias) !== 0) {
    getDeclaredTypeOfSymbol(c, symbol);
    typeParameters = c.symbolLinks(symbol).typeParameters;
  }
  if (typeParameters === undefined || typeParameters.length === 0) return;
  const typeArguments: Type[] = [];
  for (const n of typeArgumentNodes.nodes) {
    const t = getTypeFromTypeNode(c, n);
    if (isErrorType(c, t)) return;
    typeArguments.push(t);
  }
  if (typeArguments.length > typeParameters.length || typeArguments.length < getMinTypeArgumentCount(c, typeParameters))
    return;
  const filled = fillMissingTypeArguments(
    c,
    typeArguments,
    typeParameters,
    getMinTypeArgumentCount(c, typeParameters),
    false,
  );
  const mapper = newTypeMapper(typeParameters.slice(), filled);
  for (let i = 0; i < typeArguments.length; i++) {
    const constraint = getConstraintOfTypeParameter(c, typeParameters[i]);
    if (constraint === undefined) continue;
    checkTypeAssignableTo(
      c,
      typeArguments[i],
      instantiateType(c, constraint, mapper),
      typeArgumentNodes.nodes[i],
      Diagnostics.Type_0_does_not_satisfy_the_constraint_1,
    );
  }
}

export function checkEnumDeclaration(c: Checker, node: Node): void {
  const name = getName(node)!;
  checkTypeNameIsReserved(c, name, Diagnostics.Enum_name_cannot_be_0);
  checkExportsOnMergedDeclarations(c, node);
  for (const member of (node as EnumDeclaration).members.nodes) {
    const memberName = getName(member);
    if (memberName === undefined) continue;
    if (memberName.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, memberName);
    else if (memberName.kind === SyntaxKind.PrivateIdentifier)
      c.error(member, Diagnostics.An_enum_member_cannot_be_named_with_a_private_identifier);
  }
  if (c.compilerOptions.erasableSyntaxOnly === true && (node.flags & NodeFlags.Ambient) === 0)
    c.error(node, Diagnostics.This_syntax_is_not_allowed_when_erasableSyntaxOnly_is_enabled);
  computeEnumMemberValues(c, node);
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  const links = c.symbolLinks(symbol);
  if (links.enumChecked) return;
  links.enumChecked = true;
  if (symbol.declarations.length > 1) {
    const enumIsConst = isEnumConst(node);
    for (const d of symbol.declarations)
      if (d.kind === SyntaxKind.EnumDeclaration && isEnumConst(d) !== enumIsConst)
        c.error(getNameOfDeclaration(d), Diagnostics.Enum_declarations_must_all_be_const_or_non_const);
  }
  // Only one declaration of a merged enum may continue automatic numbering from zero.
  let seenEnumMissingInitialInitializer = false;
  for (const d of symbol.declarations) {
    if (d.kind !== SyntaxKind.EnumDeclaration) continue;
    const members = (d as EnumDeclaration).members.nodes;
    if (members.length === 0 || getInitializer(members[0]) !== undefined) continue;
    if (seenEnumMissingInitialInitializer)
      c.error(
        getName(members[0]),
        Diagnostics.In_an_enum_with_multiple_declarations_only_one_declaration_can_omit_an_initializer_for_its_first_enum_element,
      );
    else seenEnumMissingInitialInitializer = true;
  }
}

export function checkModuleDeclaration(c: Checker, node: Node): void {
  const module = node as ModuleDeclaration;
  const body = module.body;
  if (body !== undefined) checkSourceElement(c, body);
  const isGlobalAugmentation = isGlobalScopeAugmentation(node);
  const inAmbientContext = (node.flags & NodeFlags.Ambient) !== 0;
  if (isGlobalAugmentation && !inAmbientContext)
    c.error(
      module.name,
      Diagnostics.Augmentations_for_the_global_scope_should_have_declare_modifier_unless_they_appear_in_already_ambient_context,
    );
  const contextMessage = isAmbientModule(node)
    ? Diagnostics.An_ambient_module_declaration_is_only_allowed_at_the_top_level_in_a_file
    : Diagnostics.A_namespace_declaration_is_only_allowed_at_the_top_level_of_a_namespace_or_module;
  if (checkModuleElementContext(c, node, contextMessage)) return;
  if (module.name.kind === SyntaxKind.Identifier && module.keyword === SyntaxKind.ModuleKeyword)
    c.error(
      module.name,
      Diagnostics.A_namespace_declaration_should_not_be_declared_using_the_module_keyword_Please_use_the_namespace_keyword_instead,
    );
  checkExportsOnMergedDeclarations(c, node);
  const symbol = getSymbolOfDeclaration(c, node);
  // Only non-ambient instantiated namespaces.
  if (
    symbol !== undefined &&
    (symbol.flags & SymbolFlags.ValueModule) !== 0 &&
    !inAmbientContext &&
    isInstantiatedModule(node, shouldPreserveConstEnums(c.compilerOptions))
  ) {
    if (c.compilerOptions.erasableSyntaxOnly === true)
      c.error(node, Diagnostics.This_syntax_is_not_allowed_when_erasableSyntaxOnly_is_enabled);
    if (symbol.declarations.length > 1) {
      const classOrFunction = getFirstNonAmbientClassOrFunctionDeclaration(symbol);
      if (classOrFunction !== undefined) {
        if (getSourceFileOfNode(node) !== getSourceFileOfNode(classOrFunction))
          c.error(
            module.name,
            Diagnostics.A_namespace_declaration_cannot_be_in_a_different_file_from_a_class_or_function_with_which_it_is_merged,
          );
        else if (node.pos < classOrFunction.pos)
          c.error(
            module.name,
            Diagnostics.A_namespace_declaration_cannot_be_located_prior_to_a_class_or_function_with_which_it_is_merged,
          );
      }
    }
  }
  if (!isAmbientModule(node)) return;
  if (isModuleAugmentationExternal(node)) {
    // Check an augmentation's body only when it merged with its target.
    const checkBody = isGlobalAugmentation || (symbol !== undefined && (symbol.flags & SymbolFlags.Transient) !== 0);
    if (checkBody && body !== undefined && body.kind === SyntaxKind.ModuleBlock)
      for (const statement of getStatements(body)!.nodes) checkModuleAugmentationElement(c, statement);
    return;
  }
  const parent = node.parent!;
  if (isGlobalAugmentation)
    c.error(
      module.name,
      Diagnostics.Augmentations_for_the_global_scope_can_only_be_directly_nested_in_external_modules_or_ambient_module_declarations,
    );
  else if (parent.kind === SyntaxKind.SourceFile && !isExternalModule(parent as SourceFile)) {
    if (isExternalModuleNameRelative(getText(module.name)))
      c.error(module.name, Diagnostics.Ambient_module_declaration_cannot_specify_relative_module_name);
  } else c.error(module.name, Diagnostics.Ambient_modules_cannot_be_nested_in_other_modules_or_namespaces);
}

function isInstantiatedModule(node: Node, preserveConstEnums: boolean): boolean {
  const state = getModuleInstanceState(node);
  return (
    state === ModuleInstanceState.Instantiated || (preserveConstEnums && state === ModuleInstanceState.ConstEnumOnly)
  );
}

function getFirstNonAmbientClassOrFunctionDeclaration(symbol: Symbol): Node | undefined {
  for (const d of symbol.declarations)
    if (
      (d.kind === SyntaxKind.ClassDeclaration ||
        (d.kind === SyntaxKind.FunctionDeclaration && nodeIsPresent(getBody(d)))) &&
      (d.flags & NodeFlags.Ambient) === 0
    )
      return d;
  return undefined;
}

function checkModuleAugmentationElement(c: Checker, node: Node): void {
  switch (node.kind) {
    case SyntaxKind.VariableStatement:
      // Each name, rather than the whole statement.
      for (const d of (node as VariableStatement).declarationList.declarations.nodes)
        checkModuleAugmentationElement(c, d);
      return;
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.ExportDeclaration:
      grammarErrorOnFirstToken(
        c,
        node,
        Diagnostics.Exports_and_export_assignments_are_not_permitted_in_module_augmentations,
      );
      return;
    case SyntaxKind.ImportEqualsDeclaration:
      // `import a = e.x` is allowed; `import a = require("m")` isn't.
      if ((node as ImportEqualsDeclaration).moduleReference.kind !== SyntaxKind.ExternalModuleReference) return;
      grammarErrorOnFirstToken(
        c,
        node,
        Diagnostics.Imports_are_not_permitted_in_module_augmentations_Consider_moving_them_to_the_enclosing_external_module,
      );
      return;
    case SyntaxKind.ImportDeclaration:
      grammarErrorOnFirstToken(
        c,
        node,
        Diagnostics.Imports_are_not_permitted_in_module_augmentations_Consider_moving_them_to_the_enclosing_external_module,
      );
      return;
  }
}

/** Reports at the first token of `node` unless the file has syntax errors. */
function grammarErrorOnFirstToken(c: Checker, node: Node, message: DiagnosticMessage): void {
  const file = getSourceFileOfNode(node);
  if (file.diagnostics.length > 0) return;
  const span = getRangeOfTokenAtPosition(file, node.pos);
  c.addDiagnostic(new Diagnostic(file.diagnosticFile(), span.pos, span.end, message, []));
}

// ---- Imports and exports

/**
 * Reports a module element (import, export, namespace) outside a file, namespace or module body.
 * Callers stop checking the element when this returns true.
 */
function checkModuleElementContext(c: Checker, node: Node, message: DiagnosticMessage): boolean {
  const parent = node.parent!.kind;
  if (parent === SyntaxKind.SourceFile || parent === SyntaxKind.ModuleBlock || parent === SyntaxKind.ModuleDeclaration)
    return false;
  grammarErrorOnFirstToken(c, node, message);
  return true;
}

/** Reports `export =` mixed with other exports, and names exported by more than one declaration. */
export function checkExternalModuleExports(c: Checker, node: Node): void {
  const moduleSymbol = getSymbolOfDeclaration(c, node);
  if (moduleSymbol === undefined) return;
  const links = c.symbolLinks(moduleSymbol);
  if (links.exportsChecked) return;
  links.exportsChecked = true;
  const exportEquals = moduleSymbol.exports?.get(InternalSymbolName.ExportEquals);
  // `export =` conflicts with exported values, and with exported types or namespaces the target also exports.
  if (
    exportEquals !== undefined &&
    (hasExportedMembersOfKind(c, moduleSymbol, SymbolFlags.Value) || hasShadowedNamespace(c, exportEquals))
  ) {
    const declaration = getDeclarationOfAliasSymbol(exportEquals) ?? exportEquals.valueDeclaration;
    if (declaration !== undefined && !isTopLevelInExternalModuleAugmentation(declaration))
      c.error(declaration, Diagnostics.An_export_assignment_cannot_be_used_in_a_module_with_other_exported_elements);
  }
  for (const [id, symbol] of getExportsOfModule(c, moduleSymbol)) {
    // Namespaces, enums, interfaces and overloads may have several declarations.
    if (id === InternalSymbolName.ExportStar || (symbol.flags & (SymbolFlags.Namespace | SymbolFlags.Enum)) !== 0)
      continue;
    let count = 0;
    for (const d of symbol.declarations)
      if (isNotOverload(d) && !isAccessorDeclaration(d) && d.kind !== SyntaxKind.InterfaceDeclaration) count++;
    // A type alias may merge with one value.
    if ((symbol.flags & SymbolFlags.TypeAlias) !== 0 && count <= 2) continue;
    if (count <= 1) continue;
    let allExportsProperties = true;
    for (const d of symbol.declarations)
      if (getAssignmentDeclarationKind(d) !== JSDeclarationKind.ExportsProperty) allExportsProperties = false;
    if (allExportsProperties) continue;
    for (const d of symbol.declarations)
      if (isNotOverload(d)) c.error(d, Diagnostics.Cannot_redeclare_exported_variable_0, id);
  }
}

function hasExportedMembersOfKind(c: Checker, moduleSymbol: Symbol, kind: SymbolFlags): boolean {
  if (moduleSymbol.exports === undefined) return false;
  for (const [name, symbol] of moduleSymbol.exports)
    if (name !== InternalSymbolName.ExportEquals && (getSymbolFlags(c, symbol) & kind) !== 0) return true;
  return false;
}

function hasShadowedNamespace(c: Checker, symbol: Symbol): boolean {
  if ((symbol.flags & SymbolFlags.NamespaceModule) === 0 || (symbol.flags & SymbolFlags.Alias) === 0) return false;
  const target = resolveAlias(c, symbol);
  return (
    (target.flags & SymbolFlags.Namespace) !== 0 &&
    hasExportedMembersOfKind(c, target, SymbolFlags.Type | SymbolFlags.Namespace)
  );
}

function isNotOverload(node: Node): boolean {
  return (
    (node.kind !== SyntaxKind.FunctionDeclaration && node.kind !== SyntaxKind.MethodDeclaration) ||
    getBody(node) !== undefined
  );
}

function isAccessorDeclaration(node: Node): boolean {
  return node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor;
}

function isTopLevelInExternalModuleAugmentation(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined || parent.kind !== SyntaxKind.ModuleBlock) return false;
  const module = parent.parent!;
  return isAmbientModule(module) && isModuleAugmentationExternal(module);
}

// ---- Merged declarations

const enum DeclarationSpaces {
  None = 0,
  ExportValue = 1 << 0,
  ExportType = 1 << 1,
  ExportNamespace = 1 << 2,
}

/** Reports merged declarations that mix exported and local (or default-exported) declarations. */
export function checkExportsOnMergedDeclarations(c: Checker, node: Node): void {
  let symbol = getLocalSymbol(node);
  if (symbol === undefined) {
    symbol = getSymbolOfDeclaration(c, node);
    if (symbol === undefined || symbol.exportSymbol === undefined) return;
  }
  if (getDeclarationOfKind(symbol, node.kind) !== node) return;
  let exported = DeclarationSpaces.None;
  let nonExported = DeclarationSpaces.None;
  let defaultExported = DeclarationSpaces.None;
  for (const d of symbol.declarations) {
    const spaces = getDeclarationSpaces(c, d);
    const flags = getEffectiveDeclarationFlags(d, ModifierFlags.Export | ModifierFlags.Default);
    if ((flags & ModifierFlags.Export) !== 0) {
      if ((flags & ModifierFlags.Default) !== 0) defaultExported |= spaces;
      else exported |= spaces;
    } else nonExported |= spaces;
  }
  const nonDefaultExported = exported | nonExported;
  const commonForExportsAndLocals = exported & nonExported;
  const commonForDefaultAndNonDefault = defaultExported & nonDefaultExported;
  if (commonForExportsAndLocals === 0 && commonForDefaultAndNonDefault === 0) return;
  for (const d of symbol.declarations) {
    const spaces = getDeclarationSpaces(c, d);
    const name = getNameOfDeclaration(d);
    const text = declarationNameToString(getSourceFileOfNode(d), name);
    if ((spaces & commonForDefaultAndNonDefault) !== 0)
      c.error(
        name,
        Diagnostics.Merged_declaration_0_cannot_include_a_default_export_declaration_Consider_adding_a_separate_export_default_0_declaration_instead,
        text,
      );
    else if ((spaces & commonForExportsAndLocals) !== 0)
      c.error(
        name,
        Diagnostics.Individual_declarations_in_merged_declaration_0_must_be_all_exported_or_all_local,
        text,
      );
  }
}

function getDeclarationSpaces(c: Checker, node: Node): DeclarationSpaces {
  switch (node.kind) {
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      return DeclarationSpaces.ExportType;
    case SyntaxKind.ModuleDeclaration:
      return isAmbientModule(node) || getModuleInstanceState(node) !== ModuleInstanceState.NonInstantiated
        ? DeclarationSpaces.ExportNamespace | DeclarationSpaces.ExportValue
        : DeclarationSpaces.ExportNamespace;
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.EnumMember:
      return DeclarationSpaces.ExportType | DeclarationSpaces.ExportValue;
    case SyntaxKind.SourceFile:
      return DeclarationSpaces.ExportType | DeclarationSpaces.ExportValue | DeclarationSpaces.ExportNamespace;
    case SyntaxKind.ExportAssignment: {
      const expression = getExpression(node)!;
      const symbol = getSymbolOfDeclaration(c, node);
      if (
        !isEntityNameExpression(expression, false) ||
        symbol === undefined ||
        (symbol.flags & SymbolFlags.Alias) === 0
      )
        return DeclarationSpaces.ExportValue;
      return getAliasDeclarationSpaces(c, node);
    }
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.ImportClause:
      return getAliasDeclarationSpaces(c, node);
    case SyntaxKind.MethodSignature:
    case SyntaxKind.PropertySignature:
      return DeclarationSpaces.ExportType;
  }
  return DeclarationSpaces.ExportValue;
}

function getAliasDeclarationSpaces(c: Checker, node: Node): DeclarationSpaces {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return DeclarationSpaces.None;
  let result = DeclarationSpaces.None;
  for (const d of resolveAlias(c, symbol).declarations) result |= getDeclarationSpaces(c, d);
  return result;
}

export function getEffectiveDeclarationFlags(node: Node, flagsToCheck: ModifierFlags): ModifierFlags {
  let flags = getCombinedModifierFlags(node);
  const parent = node.parent!;
  if (
    parent.kind !== SyntaxKind.InterfaceDeclaration &&
    parent.kind !== SyntaxKind.ClassDeclaration &&
    parent.kind !== SyntaxKind.ClassExpression &&
    (node.flags & NodeFlags.Ambient) !== 0
  ) {
    let container = node.parent;
    while (container !== undefined && (getContainerFlags(container) & ContainerFlags.IsContainer) === 0)
      container = container.parent;
    if (
      container !== undefined &&
      (container.flags & NodeFlags.ExportContext) !== 0 &&
      (flags & ModifierFlags.Ambient) === 0 &&
      !(parent.kind === SyntaxKind.ModuleBlock && isGlobalScopeAugmentation(parent.parent!))
    )
      flags |= ModifierFlags.Export;
    flags |= ModifierFlags.Ambient;
  }
  return flags & flagsToCheck;
}
