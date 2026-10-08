// File-level checking: `checkSourceFile`, the statement/declaration dispatch and deferred checks.
//
// Extension points, by syntactic area:
// - statements: checker-statements.ts (`checkBlock`, `checkIfStatement`, ...)
// - declarations: checker-declarations.ts (variables, functions, aliases, enums, modules, imports)
// - classes and interfaces: checker-classes.ts
// - expressions: checker-expressions.ts (`checkExpression`), calls in checker-calls.ts
// - JSX: checker-jsx.ts
// - grammar: checker-grammar.ts (checks the parser leaves to the checker)
// - type nodes: `checkTypeNode` below
import { type Node, NodeVisitor, type SourceFile, getNodeId, getStatements, getTypeArguments, getType } from './ast.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import { NodeCheckFlags } from './checker-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  checkBlock,
  checkDoStatement,
  checkExpressionStatement,
  checkForInStatement,
  checkForOfStatement,
  checkForStatement,
  checkIfStatement,
  checkLabeledStatement,
  checkReturnStatement,
  checkSwitchStatement,
  checkThrowStatement,
  checkTryStatement,
  checkWhileStatement,
} from './checker-statements.js';
import {
  checkEnumDeclaration,
  checkExportAssignment,
  checkExportDeclaration,
  checkFunctionDeclaration,
  checkImportDeclaration,
  checkImportEqualsDeclaration,
  checkModuleDeclaration,
  checkTypeAliasDeclaration,
  checkTypeArgumentConstraintsOfReference,
  checkTypeParameter,
  checkVariableStatement,
  checkVariableLikeDeclaration,
} from './checker-declarations.js';
import { checkClassDeclaration, checkInterfaceDeclaration, checkClassLikeDeferred } from './checker-classes.js';
import { checkFunctionLikeBody } from './checker-functions.js';
import { checkGrammarSourceFile } from './checker-grammar.js';
import { Diagnostics } from './diagnostic-messages.js';
import { reportImplicitAny } from './checker-symbol-types.js';

/** Checks `file` once; diagnostics accumulate in the checker. */
export function checkSourceFile(c: Checker, file: SourceFile): void {
  const links = c.nodeLinks(file);
  if ((links.flags & NodeCheckFlags.TypeChecked) !== 0) return;
  links.flags |= NodeCheckFlags.TypeChecked;
  if (c.host.isSourceFileDefaultLibrary(file)) return;
  checkGrammarSourceFile(c, file);
  for (const statement of getStatements(file)!.nodes) checkSourceElement(c, statement);
  checkDeferredNodes(c);
}

/** Checks a statement, declaration, class member or type node. */
export function checkSourceElement(c: Checker, node: Node | undefined): void {
  if (node === undefined) return;
  const saveCurrentNode = c.currentNode;
  c.currentNode = node;
  checkSourceElementWorker(c, node);
  c.currentNode = saveCurrentNode;
}

function checkSourceElementWorker(c: Checker, node: Node): void {
  switch (node.kind) {
    // Statements
    case SyntaxKind.Block:
    case SyntaxKind.ModuleBlock:
      checkBlock(c, node);
      return;
    case SyntaxKind.EmptyStatement:
    case SyntaxKind.DebuggerStatement:
    case SyntaxKind.BreakStatement:
    case SyntaxKind.ContinueStatement:
      return;
    case SyntaxKind.VariableStatement:
      checkVariableStatement(c, node);
      return;
    case SyntaxKind.ExpressionStatement:
      checkExpressionStatement(c, node);
      return;
    case SyntaxKind.IfStatement:
      checkIfStatement(c, node);
      return;
    case SyntaxKind.DoStatement:
      checkDoStatement(c, node);
      return;
    case SyntaxKind.WhileStatement:
      checkWhileStatement(c, node);
      return;
    case SyntaxKind.ForStatement:
      checkForStatement(c, node);
      return;
    case SyntaxKind.ForInStatement:
      checkForInStatement(c, node);
      return;
    case SyntaxKind.ForOfStatement:
      checkForOfStatement(c, node);
      return;
    case SyntaxKind.ReturnStatement:
      checkReturnStatement(c, node);
      return;
    case SyntaxKind.SwitchStatement:
      checkSwitchStatement(c, node);
      return;
    case SyntaxKind.LabeledStatement:
      checkLabeledStatement(c, node);
      return;
    case SyntaxKind.ThrowStatement:
      checkThrowStatement(c, node);
      return;
    case SyntaxKind.TryStatement:
      checkTryStatement(c, node);
      return;
    case SyntaxKind.WithStatement:
      return;
    // Declarations
    case SyntaxKind.FunctionDeclaration:
      checkFunctionDeclaration(c, node);
      return;
    case SyntaxKind.ClassDeclaration:
      checkClassDeclaration(c, node);
      return;
    case SyntaxKind.InterfaceDeclaration:
      checkInterfaceDeclaration(c, node);
      return;
    case SyntaxKind.TypeAliasDeclaration:
      checkTypeAliasDeclaration(c, node);
      return;
    case SyntaxKind.EnumDeclaration:
      checkEnumDeclaration(c, node);
      return;
    case SyntaxKind.ModuleDeclaration:
      checkModuleDeclaration(c, node);
      return;
    case SyntaxKind.ImportDeclaration:
      checkImportDeclaration(c, node);
      return;
    case SyntaxKind.ImportEqualsDeclaration:
      checkImportEqualsDeclaration(c, node);
      return;
    case SyntaxKind.ExportDeclaration:
      checkExportDeclaration(c, node);
      return;
    case SyntaxKind.ExportAssignment:
      checkExportAssignment(c, node);
      return;
    case SyntaxKind.NamespaceExportDeclaration:
    case SyntaxKind.MissingDeclaration:
      return;
    case SyntaxKind.TypeParameter:
      checkTypeParameter(c, node);
      return;
  }
  checkTypeNode(c, node);
}

// ---- Type nodes

/** Resolves every type reference in a type annotation, reporting unresolved names and constraint errors. */
export function checkTypeNodeIfPresent(c: Checker, node: Node | undefined): void {
  if (node !== undefined) checkTypeNode(c, node);
}

/** Implicit `any` return types of signatures without annotations. */
function checkSignatureMember(c: Checker, node: Node): void {
  if (getType(node) !== undefined || !c.noImplicitAny) return;
  if (node.kind === SyntaxKind.MethodSignature) reportImplicitAny(c, node, c.anyType);
  else if (node.kind === SyntaxKind.CallSignature)
    c.error(node, Diagnostics.Call_signature_which_lacks_return_type_annotation_implicitly_has_an_any_return_type);
  else
    c.error(node, Diagnostics.Construct_signature_which_lacks_return_type_annotation_implicitly_has_an_any_return_type);
}

function checkTypeNode(c: Checker, node: Node): void {
  switch (node.kind) {
    case SyntaxKind.MethodSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature:
      checkSignatureMember(c, node);
      break;
    case SyntaxKind.TypeReference:
      getTypeFromTypeNode(c, node);
      checkTypeArgumentConstraintsOfReference(c, node);
      break;
    case SyntaxKind.TypeQuery:
    case SyntaxKind.IndexedAccessType:
    case SyntaxKind.TypeOperator:
    case SyntaxKind.MappedType:
    case SyntaxKind.ConditionalType:
    case SyntaxKind.TupleType:
    case SyntaxKind.LiteralType:
      getTypeFromTypeNode(c, node);
      break;
  }
  if (node.kind === SyntaxKind.TypeQuery) {
    const args = getTypeArguments(node);
    if (args !== undefined) for (const a of args.nodes) checkTypeNode(c, a);
    return;
  }
  node.forEachChild(c.typeNodeVisitor);
}

/** Visits the children of a type node; owned by the checker to avoid per-node allocation. */
export class TypeNodeVisitor extends NodeVisitor {
  readonly c: Checker;

  constructor(c: Checker) {
    super();
    this.c = c;
  }

  visitNode(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.Identifier:
      case SyntaxKind.QualifiedName:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NumericLiteral:
        return false;
      case SyntaxKind.Parameter:
        checkVariableLikeDeclaration(this.c, node);
        return false;
      case SyntaxKind.MethodSignature:
      case SyntaxKind.CallSignature:
      case SyntaxKind.ConstructSignature:
        checkSignatureMember(this.c, node);
        node.forEachChild(this);
        return false;
      case SyntaxKind.PropertySignature:
      case SyntaxKind.IndexSignature:
      case SyntaxKind.FunctionType:
      case SyntaxKind.ConstructorType:
      case SyntaxKind.TypeParameter:
        node.forEachChild(this);
        return false;
    }
    if (node.kind >= SyntaxKind.FirstTypeNode && node.kind <= SyntaxKind.LastTypeNode) checkTypeNode(this.c, node);
    else if (node.kind === SyntaxKind.ExpressionWithTypeArguments) checkTypeNode(this.c, node);
    return false;
  }
}

// ---- Deferred checks

/** Queues a function expression, arrow, accessor or class expression body to check after the current statement list. */
export function checkNodeDeferred(c: Checker, node: Node): void {
  const id = getNodeId(node);
  if (c.deferredNodeIds.has(id)) return;
  c.deferredNodeIds.add(id);
  c.deferredNodes.push(node);
}

function checkDeferredNodes(c: Checker): void {
  // Deferred checks may defer more nodes.
  for (let i = 0; i < c.deferredNodes.length; i++) checkDeferredNode(c, c.deferredNodes[i]);
  c.deferredNodes.length = 0;
}

function checkDeferredNode(c: Checker, node: Node): void {
  const saveCurrentNode = c.currentNode;
  c.currentNode = node;
  switch (node.kind) {
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      checkFunctionLikeBody(c, node);
      break;
    case SyntaxKind.ClassExpression:
      checkClassLikeDeferred(c, node);
      break;
  }
  c.currentNode = saveCurrentNode;
}
