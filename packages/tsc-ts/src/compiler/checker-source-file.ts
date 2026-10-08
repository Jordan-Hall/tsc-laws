// File-level checking: `checkSourceFile`, the statement/declaration dispatch and deferred checks.
//
// Extension points, by syntactic area:
// - statements: checker-statements.ts (`checkBlock`, `checkIfStatement`, ...)
// - declarations: checker-declarations.ts (variables, functions, aliases, enums, namespaces)
// - imports and exports: checker-modules.ts
// - classes and interfaces: checker-classes.ts
// - expressions: checker-expressions.ts (`checkExpression`), calls in checker-calls.ts
// - JSX: checker-jsx.ts
// - grammar: checker-grammar.ts (checks the parser leaves to the checker)
// - type nodes: `checkTypeNode` below
import { resolveUntypedCall } from './checker-calls.js';
import {
  type ImportTypeNode,
  type MappedTypeNode,
  type JSDoc,
  type Node,
  type NodeList,
  NodeVisitor,
  type SourceFile,
  getComment,
  getName,
  getNodeId,
  getStatements,
  getType,
  getTypeParameters,
  type HeritageClause,
  getHeritageClauses,
} from './ast.js';
import { SyntaxKind } from './syntax-kind.js';
import { isExternalOrCommonJSModule } from './binder-utilities.js';
import type { Checker } from './checker.js';
import { type MappedType, NodeCheckFlags } from './checker-types.js';
import { getConstraintTypeFromMappedType, getNameTypeFromMappedType } from './checker-type-operators.js';
import { checkTypeAssignableTo } from './relations.js';
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
  checkExternalModuleExports,
  checkFunctionDeclaration,
  checkModuleDeclaration,
  checkTypeAliasDeclaration,
  checkTypeArgumentConstraintsOfReference,
  checkTypeParameter,
  checkTypeParameters,
  checkVariableStatement,
  checkVariableLikeDeclaration,
  checkUnusedRenamedBindingElements,
} from './checker-declarations.js';
import {
  checkExportAssignment,
  checkExportDeclaration,
  checkImportDeclaration,
  checkImportEqualsDeclaration,
  resolveJSDocMemberName,
} from './checker-modules.js';
import {
  checkAccessorDeclaration,
  checkClassDeclaration,
  checkClassLikeDeferred,
  checkInterfaceDeclaration,
} from './checker-classes.js';
import { checkJsxElementDeferred } from './checker-jsx.js';
import { checkAssertionDeferred } from './checker-expressions.js';
import { checkFunctionLikeBody } from './checker-functions.js';
import { produceDeferredIterationErrors } from './checker-iteration.js';
import { checkFunctionOrMethodSymbols } from './checker-overloads.js';
import { checkTypeLiteralMembers } from './checker-heritage.js';
import { checkGrammarSourceFile } from './checker-grammar.js';
import { Diagnostics } from './diagnostic-messages.js';
import { getTypeOfSymbol, reportImplicitAny } from './checker-symbol-types.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';

/** Checks `file` once; diagnostics accumulate in the checker. */
export function checkSourceFile(c: Checker, file: SourceFile): void {
  const links = c.nodeLinks(file);
  if ((links.flags & NodeCheckFlags.TypeChecked) !== 0) return;
  links.flags |= NodeCheckFlags.TypeChecked;
  if (c.host.isSourceFileDefaultLibrary(file)) return;
  c.saveDeferredDiagnostics = true;
  for (const statement of getStatements(file)!.nodes) checkSourceElement(c, statement);
  checkDeferredNodes(c);
  if (isExternalOrCommonJSModule(file)) checkExternalModuleExports(c, file);
  if (!file.isDeclarationFile) checkUnusedRenamedBindingElements(c);
  else c.renamedBindingElementsInTypes.length = 0;
  // Grammar checks run last so the types they need are created in tsgo's order.
  checkGrammarSourceFile(c, file);
  // Expressions first checked by grammar checks may defer more nodes.
  checkDeferredNodes(c);
  c.saveDeferredDiagnostics = false;
  produceDeferredIterationErrors(c);
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
  const jsDoc = node.jsDoc;
  if (jsDoc !== undefined) for (const d of jsDoc) checkJSDocLinks(c, d);
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
    case SyntaxKind.JSTypeAliasDeclaration:
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

// ---- JSDoc

/** Resolves the names of `{@link}` tags in a JSDoc comment and its tags, which references them. */
function checkJSDocLinks(c: Checker, jsDoc: Node): void {
  checkJSDocCommentLinks(c, getComment(jsDoc));
  const tags = jsDoc.kind === SyntaxKind.JSDoc ? (jsDoc as JSDoc).tags : undefined;
  if (tags !== undefined) for (const tag of tags.nodes) checkJSDocCommentLinks(c, getComment(tag));
}

function checkJSDocCommentLinks(c: Checker, comments: NodeList | undefined): void {
  if (comments === undefined) return;
  for (const comment of comments.nodes)
    if (
      comment.kind === SyntaxKind.JSDocLink ||
      comment.kind === SyntaxKind.JSDocLinkCode ||
      comment.kind === SyntaxKind.JSDocLinkPlain
    )
      resolveJSDocMemberName(c, getName(comment));
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
  const saveCurrentNode = c.currentNode;
  c.currentNode = node;
  checkTypeNodeWorker(c, node);
  c.currentNode = saveCurrentNode;
}

function isTypeReferenceHeritageElement(node: Node): boolean {
  const clause = node.parent;
  if (clause === undefined || clause.kind !== SyntaxKind.HeritageClause) return false;
  const token = (clause as HeritageClause).token;
  if ((token === SyntaxKind.ImplementsKeyword) === (clause.parent!.kind === SyntaxKind.InterfaceDeclaration))
    return false;
  // Only the first clause of each kind counts.
  for (const other of getHeritageClauses(clause.parent!)!.nodes)
    if ((other as HeritageClause).token === token) return other === clause;
  return false;
}

function checkTypeNodeWorker(c: Checker, node: Node): void {
  switch (node.kind) {
    case SyntaxKind.MethodSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature:
      checkTypeParameters(c, getTypeParameters(node));
      checkSignatureMember(c, node);
      break;
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
      checkTypeParameters(c, getTypeParameters(node));
      break;
    case SyntaxKind.TypeReference:
      getTypeFromTypeNode(c, node);
      checkTypeArgumentConstraintsOfReference(c, node);
      break;
    case SyntaxKind.ExpressionWithTypeArguments:
      // Implemented types and interface base types are type references; class base types are
      // checked with the base constructor's type parameters.
      if (isTypeReferenceHeritageElement(node)) {
        getTypeFromTypeNode(c, node);
        checkTypeArgumentConstraintsOfReference(c, node);
      }
      break;
    case SyntaxKind.TypeQuery:
    case SyntaxKind.ImportType:
    case SyntaxKind.IndexedAccessType:
    case SyntaxKind.TypeOperator:
    case SyntaxKind.ConditionalType:
    case SyntaxKind.TupleType:
    case SyntaxKind.LiteralType:
      getTypeFromTypeNode(c, node);
      break;
  }
  // Type arguments of an import type are only resolved with its type.
  if (node.kind === SyntaxKind.ImportType) {
    checkTypeNode(c, (node as ImportTypeNode).argument);
    return;
  }
  // Type arguments of a type query are checked with its type.
  if (node.kind === SyntaxKind.TypeQuery) return;
  if (node.kind === SyntaxKind.MappedType) {
    checkMappedType(c, node as MappedTypeNode);
    return;
  }
  node.forEachChild(c.typeNodeVisitor);
  if (node.kind === SyntaxKind.MethodSignature) checkFunctionOrMethodSymbols(c, node);
  else if (node.kind === SyntaxKind.TypeLiteral) checkTypeLiteralMembers(c, node);
}

/** Checks a mapped type's parts before its type, which resolves the constraint eagerly. */
function checkMappedType(c: Checker, node: MappedTypeNode): void {
  checkTypeParameter(c, node.typeParameter);
  checkTypeNodeIfPresent(c, node.nameType);
  checkTypeNodeIfPresent(c, node.type);
  if (node.type === undefined) reportImplicitAny(c, node, c.anyType);
  if (node.members !== undefined) for (const m of node.members.nodes) checkSourceElement(c, m);
  const t = getTypeFromTypeNode(c, node) as MappedType;
  const nameType = getNameTypeFromMappedType(c, t);
  if (nameType !== undefined) checkTypeAssignableTo(c, nameType, c.stringNumberSymbolType, node.nameType, undefined);
  else
    checkTypeAssignableTo(
      c,
      getConstraintTypeFromMappedType(c, t),
      c.stringNumberSymbolType,
      node.typeParameter.constraint,
      undefined,
    );
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
        checkTypeNode(this.c, node);
        return false;
      case SyntaxKind.PropertySignature:
        checkVariableLikeDeclaration(this.c, node);
        return false;
      case SyntaxKind.IndexSignature:
        node.forEachChild(this);
        return false;
      case SyntaxKind.TypeParameter:
        // Lists of signatures are checked as a whole; `infer` and mapped type parameters alone.
        if (node.parent!.kind === SyntaxKind.InferType || node.parent!.kind === SyntaxKind.MappedType)
          checkTypeParameter(this.c, node);
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

/** Resolves the type of an object literal accessor, which reports accessors implicitly typed `any`. */
function checkObjectLiteralAccessorType(c: Checker, node: Node): void {
  if (node.parent!.kind !== SyntaxKind.ObjectLiteralExpression) return;
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) getTypeOfSymbol(c, symbol);
}

function checkDeferredNode(c: Checker, node: Node): void {
  const saveCurrentNode = c.currentNode;
  c.currentNode = node;
  switch (node.kind) {
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
      // Deferred when overload resolution fails, so that the arguments are checked once.
      resolveUntypedCall(c, node);
      break;
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
      checkFunctionLikeBody(c, node);
      break;
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      checkObjectLiteralAccessorType(c, node);
      checkFunctionLikeBody(c, node);
      if (node.parent!.kind === SyntaxKind.ObjectLiteralExpression) checkAccessorDeclaration(c, node);
      break;
    case SyntaxKind.ClassExpression:
      checkClassLikeDeferred(c, node);
      break;
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
      checkAssertionDeferred(c, node);
      break;
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
      checkJsxElementDeferred(c, node);
      break;
  }
  c.currentNode = saveCurrentNode;
}
