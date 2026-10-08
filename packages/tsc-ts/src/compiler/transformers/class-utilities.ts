// Expression and class-element utilities shared by the class transforms: outer expressions,
// `super` accesses, constructor bodies, `_classThis` blocks and auto-accessor backing fields.
import {
  AsExpression,
  BinaryExpression,
  Block,
  ClassDeclaration,
  ClassExpression,
  ClassStaticBlockDeclaration,
  ElementAccessExpression,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ExpressionStatement,
  ExpressionWithTypeArguments,
  HeritageClause,
  Identifier,
  type ModifierList,
  NamedExports,
  type Node,
  NodeFlags,
  NodeList,
  NonNullExpression,
  ObjectLiteralExpression,
  ParenthesizedExpression,
  PartiallyEmittedExpression,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  PropertyDeclaration,
  SatisfiesExpression,
  SetAccessorDeclaration,
  TryStatement,
  TypeAssertion,
  CallExpression,
  ArrowFunction,
  ComputedPropertyName,
} from '../ast.js';
import { isAssignmentExpression, isClassLike } from '../binder-utilities.js';
import type { EmitContext } from '../printer/emit-context.js';
import type { NodeFactory } from '../printer/factory.js';
import { isPrologueDirective, nodeIsSynthesized, positionIsSynthesized } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';

export const enum OuterExpressionKinds {
  None = 0,
  Parentheses = 1 << 0,
  TypeAssertions = 1 << 1,
  NonNullAssertions = 1 << 2,
  PartiallyEmittedExpressions = 1 << 3,
  ExpressionsWithTypeArguments = 1 << 4,
  Satisfies = 1 << 5,
  Assertions = TypeAssertions | NonNullAssertions | Satisfies,
  All = Parentheses | Assertions | PartiallyEmittedExpressions | ExpressionsWithTypeArguments,
}

export function isOuterExpression(node: Node, kinds: OuterExpressionKinds): boolean {
  switch (node.kind) {
    case SyntaxKind.ParenthesizedExpression:
      return (kinds & OuterExpressionKinds.Parentheses) !== 0;
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.AsExpression:
      return (kinds & OuterExpressionKinds.TypeAssertions) !== 0;
    case SyntaxKind.SatisfiesExpression:
      return (kinds & (OuterExpressionKinds.ExpressionsWithTypeArguments | OuterExpressionKinds.Satisfies)) !== 0;
    case SyntaxKind.ExpressionWithTypeArguments:
      return (kinds & OuterExpressionKinds.ExpressionsWithTypeArguments) !== 0;
    case SyntaxKind.NonNullExpression:
      return (kinds & OuterExpressionKinds.NonNullAssertions) !== 0;
    case SyntaxKind.PartiallyEmittedExpression:
      return (kinds & OuterExpressionKinds.PartiallyEmittedExpressions) !== 0;
  }
  return false;
}

/** The expression inside any outer expressions of `kinds`. */
export function skipOuterExpressions(node: Node, kinds: OuterExpressionKinds): Node {
  for (;;) {
    if (!isOuterExpression(node, kinds)) return node;
    if (node instanceof ParenthesizedExpression) node = node.expression;
    else if (node instanceof AsExpression) node = node.expression;
    else if (node instanceof TypeAssertion) node = node.expression;
    else if (node instanceof SatisfiesExpression) node = node.expression;
    else if (node instanceof NonNullExpression) node = node.expression;
    else if (node instanceof PartiallyEmittedExpression) node = node.expression;
    else if (node instanceof ExpressionWithTypeArguments) node = node.expression;
    else return node;
  }
}

/** `inner` wrapped again in the outer expressions of `outer`, except synthesized parentheses. */
export function restoreOuterExpressions(
  context: EmitContext,
  outer: Node | undefined,
  inner: Node,
  kinds: OuterExpressionKinds,
): Node {
  if (outer === undefined || !isOuterExpression(outer, kinds) || isIgnorableParen(context, outer)) return inner;
  const factory = context.factory;
  if (outer instanceof ParenthesizedExpression)
    return factory.updateParenthesizedExpression(
      outer,
      restoreOuterExpressions(context, outer.expression, inner, OuterExpressionKinds.All),
    );
  if (outer instanceof TypeAssertion)
    return factory.updateTypeAssertion(
      outer,
      outer.type,
      restoreOuterExpressions(context, outer.expression, inner, OuterExpressionKinds.All),
    );
  if (outer instanceof AsExpression)
    return factory.updateAsExpression(
      outer,
      restoreOuterExpressions(context, outer.expression, inner, OuterExpressionKinds.All),
      outer.type,
    );
  if (outer instanceof SatisfiesExpression)
    return factory.updateSatisfiesExpression(
      outer,
      restoreOuterExpressions(context, outer.expression, inner, OuterExpressionKinds.All),
      outer.type,
    );
  if (outer instanceof NonNullExpression)
    return factory.updateNonNullExpression(
      outer,
      restoreOuterExpressions(context, outer.expression, inner, OuterExpressionKinds.All),
      outer.flags,
    );
  if (outer instanceof ExpressionWithTypeArguments)
    return factory.updateExpressionWithTypeArguments(
      outer,
      restoreOuterExpressions(context, outer.expression, inner, OuterExpressionKinds.All),
      outer.typeArguments,
    );
  if (outer instanceof PartiallyEmittedExpression)
    return factory.updatePartiallyEmittedExpression(
      outer,
      restoreOuterExpressions(context, outer.expression, inner, OuterExpressionKinds.All),
    );
  return inner;
}

function isIgnorableParen(context: EmitContext, node: Node): boolean {
  return (
    node instanceof ParenthesizedExpression &&
    nodeIsSynthesized(node) &&
    (positionIsSynthesized(context.sourceMapPos(node)) || positionIsSynthesized(context.sourceMapEnd(node))) &&
    (positionIsSynthesized(context.commentPos(node)) || positionIsSynthesized(context.commentEnd(node)))
  );
}

/** `super.x` or `super[x]` */
export function isSuperProperty(node: Node): boolean {
  if (node instanceof PropertyAccessExpression) return node.expression.kind === SyntaxKind.SuperKeyword;
  if (node instanceof ElementAccessExpression) return node.expression.kind === SyntaxKind.SuperKeyword;
  return false;
}

export function isCompoundAssignment(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstCompoundAssignment && kind <= SyntaxKind.LastCompoundAssignment;
}

/** `+` for `+=`, and so on. */
export function getNonAssignmentOperatorForCompoundAssignment(kind: SyntaxKind): SyntaxKind {
  switch (kind) {
    case SyntaxKind.PlusEqualsToken:
      return SyntaxKind.PlusToken;
    case SyntaxKind.MinusEqualsToken:
      return SyntaxKind.MinusToken;
    case SyntaxKind.AsteriskEqualsToken:
      return SyntaxKind.AsteriskToken;
    case SyntaxKind.AsteriskAsteriskEqualsToken:
      return SyntaxKind.AsteriskAsteriskToken;
    case SyntaxKind.SlashEqualsToken:
      return SyntaxKind.SlashToken;
    case SyntaxKind.PercentEqualsToken:
      return SyntaxKind.PercentToken;
    case SyntaxKind.LessThanLessThanEqualsToken:
      return SyntaxKind.LessThanLessThanToken;
    case SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return SyntaxKind.GreaterThanGreaterThanToken;
    case SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
    case SyntaxKind.AmpersandEqualsToken:
      return SyntaxKind.AmpersandToken;
    case SyntaxKind.BarEqualsToken:
      return SyntaxKind.BarToken;
    case SyntaxKind.CaretEqualsToken:
      return SyntaxKind.CaretToken;
    case SyntaxKind.BarBarEqualsToken:
      return SyntaxKind.BarBarToken;
    case SyntaxKind.AmpersandAmpersandEqualsToken:
      return SyntaxKind.AmpersandAmpersandToken;
    case SyntaxKind.QuestionQuestionEqualsToken:
      return SyntaxKind.QuestionQuestionToken;
  }
  return kind;
}

/** The number of leading prologue directives. */
export function countPrologueDirectives(statements: Node[]): number {
  for (let i = 0; i < statements.length; i++) if (!isPrologueDirective(statements[i])) return i;
  return statements.length;
}

/** The `super()` call of an expression statement, if it is one. */
export function getSuperCallFromStatement(statement: Node): Node | undefined {
  if (!(statement instanceof ExpressionStatement)) return undefined;
  let expression = statement.expression;
  while (expression instanceof ParenthesizedExpression) expression = expression.expression;
  return expression instanceof CallExpression && expression.expression.kind === SyntaxKind.SuperKeyword
    ? expression
    : undefined;
}

/** Indices leading to the statement with the `super()` call, descending into `try` blocks; empty if none. */
export function findSuperStatementIndexPath(statements: Node[], start: number): number[] {
  const path: number[] = [];
  if (!findSuperStatementIndexPathWorker(statements, start, path)) return [];
  return path.reverse();
}

function findSuperStatementIndexPathWorker(statements: Node[], start: number, path: number[]): boolean {
  for (let i = start; i < statements.length; i++) {
    const statement = statements[i];
    if (getSuperCallFromStatement(statement) !== undefined) {
      path.push(i);
      return true;
    }
    if (
      statement instanceof TryStatement &&
      findSuperStatementIndexPathWorker(statement.tryBlock.statements.nodes, 0, path)
    ) {
      path.push(i);
      return true;
    }
  }
  return false;
}

/** The `extends` or `implements` clause of a class. */
export function getHeritageClause(clauses: NodeList | undefined, kind: SyntaxKind): HeritageClause | undefined {
  if (clauses === undefined) return undefined;
  for (let i = 0; i < clauses.nodes.length; i++) {
    const clause = clauses.nodes[i];
    if (clause instanceof HeritageClause && clause.token === kind) return clause;
  }
  return undefined;
}

/** The single `_classThis = this` assignment block recorded with `setClassThis`. */
export function isClassThisAssignmentBlock(context: EmitContext, node: Node): boolean {
  if (!(node instanceof ClassStaticBlockDeclaration)) return false;
  const statements = node.body.statements.nodes;
  if (statements.length !== 1) return false;
  const statement = statements[0];
  if (!(statement instanceof ExpressionStatement)) return false;
  const expression = statement.expression;
  if (!(expression instanceof BinaryExpression) || !isAssignmentExpression(expression, true)) return false;
  return (
    expression.left instanceof Identifier &&
    context.getClassThis(node) === expression.left &&
    expression.right.kind === SyntaxKind.ThisKeyword
  );
}

/** Whether a class has a `_classThis = this` block. */
export function classHasClassThisAssignment(context: EmitContext, members: NodeList): boolean {
  for (let i = 0; i < members.nodes.length; i++) if (isClassThisAssignmentBlock(context, members.nodes[i])) return true;
  return false;
}

/** The members of a class declaration or expression. */
export function getClassMembers(node: Node): NodeList {
  if (node instanceof ClassDeclaration) return (node as ClassDeclaration).members;
  if (node instanceof ClassExpression) return (node as ClassExpression).members;
  throw new Error('Expected a class');
}

/** The heritage clauses of a class declaration or expression. */
export function getClassHeritageClauses(node: Node): NodeList | undefined {
  if (node instanceof ClassDeclaration) return (node as ClassDeclaration).heritageClauses;
  if (node instanceof ClassExpression) return (node as ClassExpression).heritageClauses;
  return undefined;
}

/** The name of a class declaration or expression. */
export function getClassName(node: Node): Identifier | undefined {
  if (node instanceof ClassDeclaration) return (node as ClassDeclaration).name;
  if (node instanceof ClassExpression) return (node as ClassExpression).name;
  return undefined;
}

/** A class declaration or expression with other members. */
export function updateClassMembers(factory: NodeFactory, node: Node, members: NodeList): Node {
  if (node instanceof ClassDeclaration) {
    const declaration = node as ClassDeclaration;
    return factory.updateClassDeclaration(
      declaration,
      declaration.modifiers,
      declaration.name,
      declaration.typeParameters,
      declaration.heritageClauses,
      members,
    );
  }
  if (node instanceof ClassExpression) {
    const expression = node as ClassExpression;
    return factory.updateClassExpression(
      expression,
      expression.modifiers,
      expression.name,
      expression.typeParameters,
      expression.heritageClauses,
      members,
    );
  }
  return node;
}

/** Prepends `static { _classThis = this; }` to a class unless it has one. */
export function injectClassThisAssignmentIfMissing(context: EmitContext, node: Node, classThis: Identifier): Node {
  if (!isClassLike(node)) return node;
  const existing = getClassMembers(node);
  if (classHasClassThisAssignment(context, existing)) return node;
  const factory = context.factory;
  const statement = factory.createExpressionStatement(
    factory.createAssignment(classThis, factory.createKeywordExpression(SyntaxKind.ThisKeyword)),
  );
  const staticBlock = factory.created(
    new ClassStaticBlockDeclaration(undefined, factory.createBlock([statement], false)),
  );
  context.setClassThis(staticBlock, classThis);
  const name = getClassName(node);
  if (name !== undefined) context.setSourceMapRange(statement, name.pos, name.end);
  const members = new NodeList(existing.pos, existing.end, [staticBlock as Node].concat(existing.nodes));
  const updated = updateClassMembers(factory, node, members);
  context.setClassThis(updated, classThis);
  return updated;
}

/** The private backing field `#x_accessor_storage` of an `accessor x` field. */
export function createAccessorPropertyBackingField(
  factory: NodeFactory,
  node: PropertyDeclaration,
  modifiers: ModifierList | undefined,
  initializer: Node | undefined,
): PropertyDeclaration {
  return factory.updatePropertyDeclaration(
    node,
    modifiers,
    factory.createGeneratedPrivateNameForNode(node.name, '', '_accessor_storage'),
    undefined,
    undefined,
    initializer,
  );
}

/** The cached `_a = expr` assignment a computed property name was transformed into, if any. */
export function findComputedPropertyNameCacheAssignment(name: ComputedPropertyName): BinaryExpression | undefined {
  let node = name.expression;
  for (;;) {
    node = skipOuterExpressions(node, OuterExpressionKinds.None);
    if (node instanceof BinaryExpression && node.operatorToken.kind === SyntaxKind.CommaToken) {
      node = node.right;
      continue;
    }
    if (node instanceof BinaryExpression && isAssignmentExpression(node, true) && node.left instanceof Identifier)
      return node;
    return undefined;
  }
}

/**
 * `(_a = expression, ++_a)` for `++x`, or `(_a = expression, _a++, _a)` for `x++`, assigning the
 * operation to `resultVariable` when given.
 */
export function expandPreOrPostfixIncrementOrDecrementExpression(
  context: EmitContext,
  node: Node,
  expression: Node,
  resultVariable: Identifier | undefined,
): Node {
  const factory = context.factory;
  const prefix = node instanceof PrefixUnaryExpression;
  let operator = SyntaxKind.Unknown;
  let operand: Node = node;
  if (node instanceof PrefixUnaryExpression) {
    operator = node.operator;
    operand = node.operand;
  } else if (node instanceof PostfixUnaryExpression) {
    operator = node.operator;
    operand = node.operand;
  }
  const temp = factory.createTempVariable(0);
  context.addVariableDeclaration(temp);
  expression = factory.createAssignment(temp, expression);
  expression.pos = operand.pos;
  expression.end = operand.end;
  let operation: Node = prefix
    ? factory.createPrefixUnaryExpression(operator, temp)
    : factory.created(new PostfixUnaryExpression(temp, operator));
  operation.pos = node.pos;
  operation.end = node.end;
  if (resultVariable !== undefined) {
    operation = factory.createAssignment(resultVariable, operation);
    operation.pos = node.pos;
    operation.end = node.end;
  }
  expression = factory.createCommaExpression(expression, operation);
  expression.pos = node.pos;
  expression.end = node.end;
  if (!prefix) {
    expression = factory.createCommaExpression(expression, temp);
    expression.pos = node.pos;
    expression.end = node.end;
  }
  return expression;
}

/** `object.method(args)` */
export function createMethodCall(factory: NodeFactory, object: Node, method: string, args: Node[]): CallExpression {
  const flags =
    object instanceof CallExpression && (object.flags & NodeFlags.OptionalChain) !== 0
      ? NodeFlags.OptionalChain
      : NodeFlags.None;
  return factory.created(
    new CallExpression(
      factory.createPropertyAccessExpression(object, factory.createIdentifier(method)),
      undefined,
      undefined,
      factory.createNodeList(args),
      flags,
    ),
  );
}

/** `target.call(thisArg, args)` */
export function createFunctionCallCall(
  factory: NodeFactory,
  target: Node,
  thisArg: Node,
  args: Node[],
): CallExpression {
  return createMethodCall(factory, target, 'call', [thisArg].concat(args));
}

/** `target.bind(thisArg, args)` */
export function createFunctionBindCall(
  factory: NodeFactory,
  target: Node,
  thisArg: Node,
  args: Node[],
): CallExpression {
  return createMethodCall(factory, target, 'bind', [thisArg].concat(args));
}

/** `Reflect.get(target, key, receiver)` */
export function createReflectGetCall(factory: NodeFactory, target: Node, key: Node, receiver: Node): CallExpression {
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier('Reflect'), factory.createIdentifier('get')),
    [target, key, receiver],
  );
}

/** `Reflect.set(target, key, value, receiver)` */
export function createReflectSetCall(
  factory: NodeFactory,
  target: Node,
  key: Node,
  value: Node,
  receiver: Node,
): CallExpression {
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier('Reflect'), factory.createIdentifier('set')),
    [target, key, value, receiver],
  );
}

/** `(() => { statements })()` */
export function createImmediatelyInvokedArrowFunction(factory: NodeFactory, statements: Node[]): CallExpression {
  const arrow: ArrowFunction = factory.createArrowFunction([], factory.createBlock(statements, true));
  return factory.createCallExpression(factory.createParenthesizedExpression(arrow), []);
}

/** `({ set value(paramName) { expression; } }).value`, an assignment target that runs `expression`. */
export function createAssignmentTargetWrapper(factory: NodeFactory, paramName: Identifier, expression: Node): Node {
  const setter = factory.created(
    new SetAccessorDeclaration(
      undefined,
      factory.createIdentifier('value'),
      undefined,
      factory.createNodeList([factory.createParameter(paramName)]),
      undefined,
      undefined,
      factory.createBlock([factory.createExpressionStatement(expression)], false),
    ),
  );
  const literal = factory.created(new ObjectLiteralExpression(factory.createNodeList([setter]), false));
  return factory.createPropertyAccessExpression(
    factory.createParenthesizedExpression(literal),
    factory.createIdentifier('value'),
  );
}

/** `export default expression;` */
export function createExportDefault(factory: NodeFactory, expression: Node): ExportAssignment {
  return factory.created(new ExportAssignment(undefined, false, undefined, expression));
}

/** `export { name };` */
export function createExternalModuleExport(factory: NodeFactory, name: Identifier): ExportDeclaration {
  const specifier = factory.created(new ExportSpecifier(false, undefined, name));
  const exports = factory.created(new NamedExports(factory.createNodeList([specifier])));
  return factory.created(new ExportDeclaration(undefined, false, exports, undefined, undefined));
}

/** A block of statements, keeping `block`'s range and original. */
export function updateBlockStatements(context: EmitContext, block: Block, statements: Node[]): Block {
  const updated = context.factory.createBlock(statements, block.multiLine);
  context.setOriginal(updated, block);
  updated.pos = block.pos;
  updated.end = block.end;
  return updated;
}
