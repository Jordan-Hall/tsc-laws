// Classes and interfaces.
import {
  type HeritageClause,
  type InterfaceDeclaration,
  ModifierFlags,
  type Node,
  NodeFlags,
  NodeVisitor,
  type PropertyAccessExpression,
  type PropertyDeclaration,
  getBody,
  getName,
  getStatements,
  getExpression,
  getTypeArguments,
  getHeritageClauses,
  getMembers,
  getText,
  getTypeParameters,
} from './ast.js';
import {
  declarationNameToString,
  findConstructorDeclaration,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isStatic,
} from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import { type InterfaceType, type Type, TypeFlags } from './checker-types.js';
import { typesOf } from './checker-type-factory.js';
import { getBaseConstructorTypeOfClass, getBaseTypes, getDeclaredTypeOfSymbol } from './checker-declared-types.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { getIndexInfosOfType } from './checker-members.js';
import { checkSourceElement, checkTypeNodeIfPresent, checkNodeDeferred } from './checker-source-file.js';
import {
  checkVariableLikeDeclaration,
  checkTypeParameter,
  checkExportsOnMergedDeclarations,
} from './checker-declarations.js';
import { checkFunctionLikeBody } from './checker-functions.js';
import { checkExpression } from './checker-expressions.js';

export function checkClassDeclaration(c: Checker, node: Node): void {
  checkClassLikeDeclaration(c, node);
}

export function checkClassExpression(c: Checker, node: Node): Type {
  checkNodeDeferred(c, node);
  const symbol = getSymbolOfDeclaration(c, node);
  return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.anyType;
}

export function checkClassLikeDeferred(c: Checker, node: Node): void {
  checkClassLikeDeclaration(c, node);
}

function checkClassLikeDeclaration(c: Checker, node: Node): void {
  if (node.kind === SyntaxKind.ClassDeclaration) checkExportsOnMergedDeclarations(c, node);
  const typeParameters = getTypeParameters(node);
  if (typeParameters !== undefined) for (const tp of typeParameters.nodes) checkTypeParameter(c, tp);
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) {
    const t = getDeclaredTypeOfSymbol(c, symbol) as InterfaceType;
    getTypeOfSymbol(c, symbol);
    if ((t.flags & TypeFlags.Object) !== 0) {
      getBaseConstructorTypeOfClass(c, t);
      getBaseTypes(c, t);
    }
  }
  const heritageClauses = getHeritageClauses(node);
  if (heritageClauses !== undefined) checkHeritageClauses(c, heritageClauses.nodes, true);
  for (const member of getMembers(node)!.nodes) checkClassMember(c, member);
  checkPropertyInitialization(c, node);
}

function checkHeritageClauses(c: Checker, clauses: Node[], isClass: boolean): void {
  for (const clause of clauses) {
    for (const t of (clause as HeritageClause).types.nodes) {
      const args = getTypeArguments(t);
      if (args !== undefined) for (const a of args.nodes) checkSourceElement(c, a);
      if (!isClass || (clause as HeritageClause).token === SyntaxKind.ImplementsKeyword) checkSourceElement(c, t);
    }
  }
}

function checkClassMember(c: Checker, member: Node): void {
  switch (member.kind) {
    case SyntaxKind.PropertyDeclaration:
      checkVariableLikeDeclaration(c, member);
      return;
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor: {
      const name = getName(member);
      if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) checkExpression(c, getExpression(name)!);
      const symbol = getSymbolOfDeclaration(c, member);
      if (symbol !== undefined && member.kind !== SyntaxKind.Constructor) getTypeOfSymbol(c, symbol);
      checkFunctionLikeBody(c, member);
      return;
    }
    case SyntaxKind.IndexSignature:
      checkSignatureDeclarationTypes(c, member);
      return;
    case SyntaxKind.ClassStaticBlockDeclaration: {
      const body = getBody(member);
      if (body !== undefined) for (const s of getStatements(body)!.nodes) checkSourceElement(c, s);
      return;
    }
  }
}

function checkSignatureDeclarationTypes(c: Checker, node: Node): void {
  checkTypeNodeIfPresent(c, node);
}

// ---- Strict property initialization

function checkPropertyInitialization(c: Checker, node: Node): void {
  if (!c.strictNullChecks || !c.strictPropertyInitialization || (node.flags & NodeFlags.Ambient) !== 0) return;
  const constructor = findConstructorDeclaration(node);
  for (const member of getMembers(node)!.nodes) {
    if (member.kind !== SyntaxKind.PropertyDeclaration) continue;
    if (
      hasSyntacticModifier(member, ModifierFlags.Ambient) ||
      hasSyntacticModifier(member, ModifierFlags.Abstract) ||
      isStatic(member)
    )
      continue;
    const prop = member as PropertyDeclaration;
    if (prop.initializer !== undefined || prop.postfixToken !== undefined) continue;
    const propName = prop.name;
    if (
      propName.kind !== SyntaxKind.Identifier &&
      propName.kind !== SyntaxKind.PrivateIdentifier &&
      propName.kind !== SyntaxKind.ComputedPropertyName
    )
      continue;
    const symbol = getSymbolOfDeclaration(c, member);
    if (symbol === undefined) continue;
    const t = getTypeOfSymbol(c, symbol);
    if ((t.flags & TypeFlags.AnyOrUnknown) !== 0 || containsUndefinedType(c, t)) continue;
    if (
      constructor !== undefined &&
      (propName.kind === SyntaxKind.ComputedPropertyName ||
        isAssignedInConstructor(constructor, getTextOfMemberName(propName)))
    )
      continue;
    c.error(
      propName,
      Diagnostics.Property_0_has_no_initializer_and_is_not_definitely_assigned_in_the_constructor,
      declarationNameToString(getSourceFileOfNode(propName), propName),
    );
  }
}

function containsUndefinedType(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Union) !== 0) {
    for (const u of typesOf(t)) if ((u.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0) return true;
    return false;
  }
  return (t.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0;
}

function getTextOfMemberName(name: Node): string {
  return getText(name);
}

/** Whether the constructor assigns `this.name` anywhere (an approximation of definite assignment). */
function isAssignedInConstructor(constructor: Node, name: string): boolean {
  const body = getBody(constructor);
  if (body === undefined) return true;
  const finder = new ThisAssignmentFinder(name);
  body.forEachChild(finder);
  return finder.found;
}

class ThisAssignmentFinder extends NodeVisitor {
  readonly name: string;
  found = false;

  constructor(name: string) {
    super();
    this.name = name;
  }

  visitNode(node: Node): boolean {
    if (node.kind === SyntaxKind.PropertyAccessExpression) {
      const access = node as PropertyAccessExpression;
      if (
        access.expression.kind === SyntaxKind.ThisKeyword &&
        access.name.kind === SyntaxKind.Identifier &&
        getText(access.name) === this.name
      ) {
        this.found = true;
        return true;
      }
    }
    // Any call through `this` may initialize it.
    if (node.kind === SyntaxKind.CallExpression) {
      const callee = getExpression(node)!;
      if (
        callee.kind === SyntaxKind.PropertyAccessExpression &&
        (callee as PropertyAccessExpression).expression.kind === SyntaxKind.ThisKeyword
      ) {
        this.found = true;
        return true;
      }
    }
    return node.forEachChild(this);
  }
}

// ---- Interfaces

export function checkInterfaceDeclaration(c: Checker, node: Node): void {
  const decl = node as InterfaceDeclaration;
  checkExportsOnMergedDeclarations(c, node);
  if (decl.typeParameters !== undefined) for (const tp of decl.typeParameters.nodes) checkTypeParameter(c, tp);
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) {
    const t = getDeclaredTypeOfSymbol(c, symbol);
    getBaseTypes(c, t);
    getIndexInfosOfType(c, t);
  }
  if (decl.heritageClauses !== undefined) checkHeritageClauses(c, decl.heritageClauses.nodes, false);
  for (const member of decl.members.nodes) {
    checkTypeNodeIfPresent(c, member);
  }
}
