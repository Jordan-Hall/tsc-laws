// Overloads: consecutive declarations, implementations and modifier agreement of functions, methods and
// constructors.
import {
  ModifierFlags,
  type Node,
  NodeFlags,
  type SourceFile,
  getBody,
  getLocalSymbol,
  getMembers,
  getName,
  getStatements,
  getText,
} from './ast.js';
import {
  declarationNameToString,
  getNameOfDeclaration,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isClassLike,
  isPropertyNameLiteral,
  isStatic,
} from './binder-utilities.js';
import { nodeIsMissing, nodeIsPresent } from './ast-utilities.js';
import { type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import type { Signature } from './checker-types.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';
import { isOptionalDeclaration } from './checker-symbol-types.js';
import {
  getErasedSignature,
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
  getSignaturesOfSymbol,
} from './checker-signatures.js';
import { checkComputedPropertyName } from './checker-expressions.js';
import { hasDynamicName, hasLateBindableName } from './checker-utilities.js';
import { isSignatureAssignableTo, isTypeIdenticalTo, isTypeRelatedTo } from './relations.js';
import { getEffectiveDeclarationFlags } from './checker-declarations.js';

/** Checks the overloads of a function or method declaration's local and export symbols. */
export function checkFunctionOrMethodSymbols(c: Checker, node: Node): void {
  if (hasDynamicName(node) && !hasLateBindableName(c, node)) return;
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  // Redeclared functions in JavaScript aren't duplicates.
  if ((node.flags & NodeFlags.JavaScriptFile) === 0)
    checkFunctionOrConstructorSymbol(c, getLocalSymbol(node) ?? symbol);
  // The export symbol: modifiers must agree across exported declarations.
  if (symbol.parent !== undefined) checkFunctionOrConstructorSymbol(c, symbol);
}

/** Checks a function, method or constructor symbol's overloads and implementations, once. */
export function checkFunctionOrConstructorSymbol(c: Checker, symbol: Symbol): void {
  const links = c.symbolLinks(symbol);
  if (links.functionOrConstructorChecked) return;
  links.functionOrConstructorChecked = true;
  new OverloadChecker(c, symbol).check();
}

/** Modifiers all overloads must agree on. */
function flagsToCheck(): ModifierFlags {
  return (
    ModifierFlags.Export |
    ModifierFlags.Ambient |
    ModifierFlags.Private |
    ModifierFlags.Protected |
    ModifierFlags.Abstract
  );
}

class OverloadChecker {
  readonly c: Checker;
  readonly symbol: Symbol;
  readonly isConstructor: boolean;

  constructor(c: Checker, symbol: Symbol) {
    this.c = c;
    this.symbol = symbol;
    this.isConstructor = (symbol.flags & SymbolFlags.Constructor) !== 0;
  }

  check(): void {
    const c = this.c;
    const declarations = this.symbol.declarations;
    let someNodeFlags = ModifierFlags.None;
    let allNodeFlags = flagsToCheck();
    let someHaveQuestionToken = false;
    let allHaveQuestionToken = true;
    let hasOverloads = false;
    let bodyDeclaration: Node | undefined = undefined;
    let lastSeenNonAmbientDeclaration: Node | undefined = undefined;
    let previousDeclaration: Node | undefined = undefined;
    let duplicateFunctionDeclaration = false;
    let multipleConstructorImplementation = false;
    let hasNonAmbientClass = false;
    const functionDeclarations: Node[] = [];
    for (const node of declarations) {
      const inAmbientContext = (node.flags & NodeFlags.Ambient) !== 0;
      const parent = node.parent;
      const inAmbientContextOrInterface =
        inAmbientContext ||
        (parent !== undefined &&
          (parent.kind === SyntaxKind.InterfaceDeclaration || parent.kind === SyntaxKind.TypeLiteral));
      // Only non-ambient declarations must be consecutive.
      if (inAmbientContextOrInterface) previousDeclaration = undefined;
      if (isClassLike(node) && !inAmbientContext) hasNonAmbientClass = true;
      if (
        node.kind !== SyntaxKind.FunctionDeclaration &&
        node.kind !== SyntaxKind.MethodDeclaration &&
        node.kind !== SyntaxKind.MethodSignature &&
        node.kind !== SyntaxKind.Constructor
      )
        continue;
      functionDeclarations.push(node);
      const currentNodeFlags = getEffectiveDeclarationFlags(node, flagsToCheck());
      someNodeFlags |= currentNodeFlags;
      allNodeFlags &= currentNodeFlags;
      const optional = isOptionalDeclaration(node);
      someHaveQuestionToken = someHaveQuestionToken || optional;
      allHaveQuestionToken = allHaveQuestionToken && optional;
      const bodyIsPresent = nodeIsPresent(getBody(node));
      if (bodyIsPresent && bodyDeclaration !== undefined) {
        if (this.isConstructor) multipleConstructorImplementation = true;
        else duplicateFunctionDeclaration = true;
      } else if (
        previousDeclaration !== undefined &&
        previousDeclaration.parent === node.parent &&
        previousDeclaration.end !== node.pos &&
        (previousDeclaration.flags & NodeFlags.Reparsed) === 0
      )
        this.reportImplementationExpectedError(previousDeclaration);
      if (bodyIsPresent) {
        if (bodyDeclaration === undefined) bodyDeclaration = node;
      } else hasOverloads = true;
      previousDeclaration = node;
      if (!inAmbientContextOrInterface) lastSeenNonAmbientDeclaration = node;
    }
    if (multipleConstructorImplementation)
      for (const d of functionDeclarations)
        c.error(d, Diagnostics.Multiple_constructor_implementations_are_not_allowed);
    if (duplicateFunctionDeclaration)
      for (const d of functionDeclarations)
        c.error(getNameOfDeclaration(d) ?? d, Diagnostics.Duplicate_function_implementation);
    if (
      hasNonAmbientClass &&
      !this.isConstructor &&
      (this.symbol.flags & SymbolFlags.Function) !== 0 &&
      declarations.length !== 0
    )
      this.reportClassMergedWithFunction();
    // Abstract methods need no implementation.
    if (
      lastSeenNonAmbientDeclaration !== undefined &&
      getBody(lastSeenNonAmbientDeclaration) === undefined &&
      !hasSyntacticModifier(lastSeenNonAmbientDeclaration, ModifierFlags.Abstract) &&
      !isOptionalDeclaration(lastSeenNonAmbientDeclaration)
    )
      this.reportImplementationExpectedError(lastSeenNonAmbientDeclaration);
    if (!hasOverloads) return;
    this.checkFlagAgreement(declarations, bodyDeclaration, someNodeFlags, allNodeFlags);
    if (someHaveQuestionToken !== allHaveQuestionToken) {
      const canonical = isOptionalDeclaration(getCanonicalOverload(declarations, bodyDeclaration));
      for (const d of declarations)
        if (isOptionalDeclaration(d) !== canonical)
          c.error(getNameOfDeclaration(d), Diagnostics.Overload_signatures_must_all_be_optional_or_required);
    }
    if (bodyDeclaration === undefined) return;
    const bodySignature = getSignatureFromDeclaration(c, bodyDeclaration);
    for (const signature of getSignaturesOfSymbol(c, this.symbol)) {
      if (isImplementationCompatibleWithOverload(c, bodySignature, signature)) continue;
      c.error(
        signature.declaration,
        Diagnostics.This_overload_signature_is_not_compatible_with_its_implementation_signature,
      ).addRelatedInfo(
        createDiagnosticForNode(bodyDeclaration, Diagnostics.The_implementation_signature_is_declared_here, []),
      );
      break;
    }
  }

  reportClassMergedWithFunction(): void {
    const c = this.c;
    const classes: Node[] = [];
    for (const d of this.symbol.declarations) if (d.kind === SyntaxKind.ClassDeclaration) classes.push(d);
    for (const d of this.symbol.declarations) {
      let message: DiagnosticMessage;
      if (d.kind === SyntaxKind.ClassDeclaration)
        message = Diagnostics.Class_declaration_cannot_implement_overload_list_for_0;
      else if (d.kind === SyntaxKind.FunctionDeclaration)
        message = Diagnostics.Function_with_bodies_can_only_merge_with_classes_that_are_ambient;
      else continue;
      const err = c.error(getNameOfDeclaration(d) ?? d, message, this.symbol.name);
      for (const r of classes)
        err.addRelatedInfo(
          createDiagnosticForNode(r, Diagnostics.Consider_adding_a_declare_modifier_to_this_class, []),
        );
    }
  }

  checkFlagAgreement(
    overloads: Node[],
    implementation: Node | undefined,
    someOverloadFlags: ModifierFlags,
    allOverloadFlags: ModifierFlags,
  ): void {
    // Only flags some, but not all, overloads have can deviate.
    if ((someOverloadFlags ^ allOverloadFlags) === 0) return;
    const c = this.c;
    const canonicalFlags = getEffectiveDeclarationFlags(
      getCanonicalOverload(overloads, implementation),
      flagsToCheck(),
    );
    // Overloads in different files need not agree on `export` and `declare`.
    const files: SourceFile[] = [];
    for (const o of overloads) {
      const file = getSourceFileOfNode(o);
      if (!files.includes(file)) files.push(file);
    }
    for (const file of files) {
      const inFile: Node[] = [];
      for (const o of overloads) if (getSourceFileOfNode(o) === file) inFile.push(o);
      const canonicalFlagsForFile = getEffectiveDeclarationFlags(
        getCanonicalOverload(inFile, implementation),
        flagsToCheck(),
      );
      for (const o of inFile) {
        const flags = getEffectiveDeclarationFlags(o, flagsToCheck());
        const deviation = flags ^ canonicalFlags;
        const deviationInFile = flags ^ canonicalFlagsForFile;
        if ((deviationInFile & ModifierFlags.Export) !== 0)
          c.error(getNameOfDeclaration(o), Diagnostics.Overload_signatures_must_all_be_exported_or_non_exported);
        else if ((deviationInFile & ModifierFlags.Ambient) !== 0)
          c.error(getNameOfDeclaration(o), Diagnostics.Overload_signatures_must_all_be_ambient_or_non_ambient);
        else if ((deviation & (ModifierFlags.Private | ModifierFlags.Protected)) !== 0)
          c.error(
            getNameOfDeclaration(o) ?? o,
            Diagnostics.Overload_signatures_must_all_be_public_private_or_protected,
          );
        else if ((deviation & ModifierFlags.Abstract) !== 0)
          c.error(getNameOfDeclaration(o), Diagnostics.Overload_signatures_must_all_be_abstract_or_non_abstract);
      }
    }
  }

  reportImplementationExpectedError(node: Node): void {
    const c = this.c;
    const name = getName(node);
    if (name !== undefined && nodeIsMissing(name)) return;
    const subsequentNode = getNextSibling(node);
    // Unparsable nodes may sit between overloads; only an adjacent node counts.
    if (subsequentNode !== undefined && subsequentNode.pos === node.end && subsequentNode.kind === node.kind) {
      const subsequentName = getName(subsequentNode);
      const errorNode = subsequentName ?? subsequentNode;
      if (name !== undefined && subsequentName !== undefined && isSameMemberName(c, name, subsequentName)) {
        // Mixed static and instance members; other conflicts are reported by the binder.
        if (
          (node.kind === SyntaxKind.MethodDeclaration || node.kind === SyntaxKind.MethodSignature) &&
          isStatic(node) !== isStatic(subsequentNode)
        )
          c.error(
            errorNode,
            isStatic(node)
              ? Diagnostics.Function_overload_must_be_static
              : Diagnostics.Function_overload_must_not_be_static,
          );
        return;
      }
      if (nodeIsPresent(getBody(subsequentNode))) {
        c.error(
          errorNode,
          Diagnostics.Function_implementation_name_must_be_0,
          declarationNameToString(getSourceFileOfNode(node), name),
        );
        return;
      }
    }
    const errorNode = name ?? node;
    if (this.isConstructor) c.error(errorNode, Diagnostics.Constructor_implementation_is_missing);
    else if (hasSyntacticModifier(node, ModifierFlags.Abstract))
      c.error(errorNode, Diagnostics.All_declarations_of_an_abstract_method_must_be_consecutive);
    else
      c.error(errorNode, Diagnostics.Function_implementation_is_missing_or_not_immediately_following_the_declaration);
  }
}

/**
 * The declaration whose flags overloads must agree with: the implementation when it shares the first
 * overload's container (so overloads from other files aren't reported), else the first overload.
 */
function getCanonicalOverload(overloads: Node[], implementation: Node | undefined): Node {
  return implementation !== undefined && implementation.parent === overloads[0].parent ? implementation : overloads[0];
}

function getNextSibling(node: Node): Node | undefined {
  const parent = node.parent!;
  const list = getStatements(parent) ?? getMembers(parent);
  if (list === undefined) return undefined;
  const index = list.nodes.indexOf(node);
  return index >= 0 && index + 1 < list.nodes.length ? list.nodes[index + 1] : undefined;
}

function isSameMemberName(c: Checker, name: Node, other: Node): boolean {
  if (name.kind === SyntaxKind.PrivateIdentifier && other.kind === SyntaxKind.PrivateIdentifier)
    return getText(name) === getText(other);
  if (name.kind === SyntaxKind.ComputedPropertyName && other.kind === SyntaxKind.ComputedPropertyName)
    return isTypeIdenticalTo(c, checkComputedPropertyName(c, name), checkComputedPropertyName(c, other));
  return isPropertyNameLiteral(name) && isPropertyNameLiteral(other) && getText(name) === getText(other);
}

function isImplementationCompatibleWithOverload(c: Checker, implementation: Signature, overload: Signature): boolean {
  const erasedSource = getErasedSignature(c, implementation);
  const erasedTarget = getErasedSignature(c, overload);
  // The return types must be related in either direction.
  const sourceReturnType = getReturnTypeOfSignature(c, erasedSource);
  const targetReturnType = getReturnTypeOfSignature(c, erasedTarget);
  if (
    targetReturnType === c.voidType ||
    isTypeRelatedTo(c, targetReturnType, sourceReturnType, c.assignableRelation) ||
    isTypeRelatedTo(c, sourceReturnType, targetReturnType, c.assignableRelation)
  )
    return isSignatureAssignableTo(c, erasedSource, erasedTarget, true);
  return false;
}
