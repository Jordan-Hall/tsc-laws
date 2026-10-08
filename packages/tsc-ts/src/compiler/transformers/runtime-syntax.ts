// TypeScript syntax with runtime behavior: parameter properties, enums and namespaces.
// Parameter properties are transformed; enums, instantiated namespaces and `import =` are not yet.
import {
  Block,
  CatchClause,
  PrivateIdentifier,
  getBody,
  getName,
  getParameters,
  ClassDeclaration,
  ClassExpression,
  ConstructorDeclaration,
  EnumDeclaration,
  ExpressionStatement,
  Identifier,
  KeywordExpression,
  ModifierFlags,
  ModuleDeclaration,
  type Node,
  NodeList,
  ParameterDeclaration,
  PropertyAccessExpression,
  PropertyDeclaration,
  TryStatement,
  NodeFlags,
  CallExpression,
  ParenthesizedExpression,
} from '../ast.js';
import { type CompilerOptions, shouldPreserveConstEnums } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags } from '../printer/emit-flags.js';
import { isPrologueDirective } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { type TypeScriptFacts } from './subtree-facts.js';
import { Transformer } from './transformer.js';
import {
  hasDecorators,
  hasSyntacticModifier,
  isInstantiatedModule,
  isParameterPropertyDeclaration,
} from './utilities.js';

export class RuntimeSyntax extends Transformer {
  readonly options: CompilerOptions;
  readonly facts: TypeScriptFacts;

  constructor(context: EmitContext, options: CompilerOptions, facts: TypeScriptFacts) {
    super(context);
    this.options = options;
    this.facts = facts;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.containsTypeScript(node)) return node;
    switch (node.kind) {
      case SyntaxKind.PublicKeyword:
      case SyntaxKind.PrivateKeyword:
      case SyntaxKind.ProtectedKeyword:
      case SyntaxKind.ReadonlyKeyword:
      case SyntaxKind.OverrideKeyword:
        return undefined;
      case SyntaxKind.EnumDeclaration:
        if (node instanceof EnumDeclaration) {
          if (hasSyntacticModifier(node, ModifierFlags.Const) && !shouldPreserveConstEnums(this.options))
            return this.notEmitted(node);
          return this.unsupportedNode(node, 'enum declarations');
        }
        break;
      case SyntaxKind.ModuleDeclaration:
        if (node instanceof ModuleDeclaration) {
          const parseNode = this.context.parseNode(node);
          if (
            parseNode instanceof ModuleDeclaration &&
            !isInstantiatedModule(parseNode as ModuleDeclaration, shouldPreserveConstEnums(this.options))
          )
            return this.notEmitted(node);
          return this.unsupportedNode(node, 'namespace declarations');
        }
        break;
      case SyntaxKind.ImportEqualsDeclaration:
        return this.unsupportedNode(node, 'import = declarations');
      case SyntaxKind.ClassDeclaration:
        if (node instanceof ClassDeclaration)
          return this.factory.updateClassDeclaration(
            node,
            this.visitModifiers(node.modifiers),
            node.name !== undefined || !childIsDecorated(this.options.experimentalDecorators === true, node.members)
              ? node.name
              : this.factory.createGeneratedNameForNode(node, 0, '', ''),
            undefined,
            this.visitNodes(node.heritageClauses),
            this.classMembers(node.members),
          );
        break;
      case SyntaxKind.ClassExpression:
        if (node instanceof ClassExpression)
          return this.factory.updateClassExpression(
            node,
            this.visitModifiers(node.modifiers),
            node.name,
            undefined,
            this.visitNodes(node.heritageClauses),
            this.classMembers(node.members),
          );
        break;
      case SyntaxKind.Constructor:
        if (node instanceof ConstructorDeclaration) return this.visitConstructor(node);
        break;
    }
    return this.visitEachChild(node);
  }

  /** The visited members, with a field declaration for each parameter property first. */
  private classMembers(members: NodeList): NodeList {
    const visited = this.visitNodes(members)!;
    const properties = parameterProperties(members);
    if (properties.length === 0) return visited;
    const fields: Node[] = [];
    for (let i = 0; i < properties.length; i++) {
      const name = properties[i].name;
      if (!(name instanceof Identifier)) continue;
      const field = this.factory.created(
        new PropertyDeclaration(undefined, this.factory.cloneIdentifier(name), undefined, undefined, undefined),
      );
      this.context.setOriginal(field, properties[i]);
      fields.push(field);
    }
    if (fields.length === 0) return visited;
    return new NodeList(members.pos, members.end, fields.concat(visited.nodes));
  }

  private visitConstructor(node: ConstructorDeclaration): Node {
    const modifiers = this.visitModifiers(node.modifiers);
    const parameters = this.visitParameters(node.parameters)!;
    const body = node.body;
    const visitedBody =
      body instanceof Block && parameterPropertiesOf(node).length > 0
        ? this.visitConstructorBody(body as Block, node)
        : this.visitFunctionBody(body);
    return this.factory.updateConstructorDeclaration(
      node,
      modifiers,
      undefined,
      parameters,
      undefined,
      undefined,
      visitedBody,
    );
  }

  private visitConstructorBody(body: Block, constructor: ConstructorDeclaration): Node {
    const factory = this.factory;
    const context = this.context;
    context.startVariableEnvironment();
    const nodes = body.statements.nodes;
    let prologueEnd = 0;
    while (prologueEnd < nodes.length && isPrologueDirective(nodes[prologueEnd])) prologueEnd++;
    const statements: Node[] = nodes.slice(0, prologueEnd);
    const rest = nodes.slice(prologueEnd);
    const assignments: Node[] = [];
    const properties = parameterPropertiesOf(constructor);
    for (let i = 0; i < properties.length; i++) {
      const name = properties[i].name;
      if (!(name instanceof Identifier)) continue;
      const propertyName = factory.cloneIdentifier(name);
      propertyName.parent = name.parent;
      context.addEmitFlags(propertyName, EmitFlags.NoComments | EmitFlags.NoSourceMap);
      const localName = factory.cloneIdentifier(name);
      localName.parent = name.parent;
      context.addEmitFlags(localName, EmitFlags.NoComments);
      const assignment = factory.createExpressionStatement(
        factory.createAssignment(
          factory.created(
            new PropertyAccessExpression(
              factory.created(new KeywordExpression(SyntaxKind.ThisKeyword)),
              undefined,
              propertyName,
              NodeFlags.None,
            ),
          ),
          localName,
        ),
      );
      context.setOriginal(assignment, properties[i]);
      context.addEmitFlags(assignment, EmitFlags.StartOnNewLine);
      assignments.push(assignment);
    }
    const superPath = findSuperStatementIndexPath(rest);
    if (superPath.length > 0) appendAll(statements, this.withInitializersAfterSuper(rest, superPath, 0, assignments));
    else {
      appendAll(statements, assignments);
      appendAll(statements, this.visitArray(rest));
    }
    const merged = context.mergeEnvironment(statements, context.endVariableEnvironment());
    const updated = factory.created(new Block(new NodeList(body.statements.pos, body.statements.end, merged), true));
    context.setOriginal(updated, body);
    updated.pos = body.pos;
    updated.end = body.end;
    return updated;
  }

  private withInitializersAfterSuper(
    statements: Node[],
    superPath: number[],
    depth: number,
    initializers: Node[],
  ): Node[] {
    const index = superPath[depth] | 0;
    const result = this.visitArray(statements.slice(0, index));
    const superStatement: Node | undefined = statements[index];
    if (superStatement === undefined) return result;
    if (superStatement instanceof TryStatement) {
      const tryStatement = superStatement;
      const tryBlock = tryStatement.tryBlock;
      const inner = this.withInitializersAfterSuper(tryBlock.statements.nodes, superPath, depth + 1, initializers);
      const visitedCatch = this.visitNode(tryStatement.catchClause);
      const visitedFinally = this.visitNode(tryStatement.finallyBlock);
      const updated: Node | undefined = this.factory.updateTryStatement(
        tryStatement,
        this.factory.updateBlock(
          tryBlock,
          new NodeList(tryBlock.statements.pos, tryBlock.statements.end, inner),
          tryBlock.multiLine,
        ),
        visitedCatch instanceof CatchClause ? (visitedCatch as CatchClause) : undefined,
        visitedFinally instanceof Block ? (visitedFinally as Block) : undefined,
      );
      if (updated !== undefined) result.push(updated);
    } else {
      appendAll(result, this.visitArray([superStatement]));
      appendAll(result, initializers);
    }
    appendAll(result, this.visitArray(statements.slice(index + 1)));
    return result;
  }
}

function appendAll(target: Node[], source: readonly Node[]): Node[] {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
  return target;
}

function parameterProperties(members: NodeList): ParameterDeclaration[] {
  const nodes = members.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const member = nodes[i];
    if (member instanceof ConstructorDeclaration) return parameterPropertiesOf(member as ConstructorDeclaration);
  }
  return [];
}

function parameterPropertiesOf(constructor: ConstructorDeclaration): ParameterDeclaration[] {
  const result: ParameterDeclaration[] = [];
  const parameters = constructor.parameters.nodes;
  for (let i = 0; i < parameters.length; i++) {
    const parameter = parameters[i];
    if (parameter instanceof ParameterDeclaration && isParameterPropertyDeclaration(parameter, constructor))
      result.push(parameter as ParameterDeclaration);
  }
  return result;
}

/** Indexes of the `super()` statement, descending into `try` blocks; empty if there is none. */
function findSuperStatementIndexPath(statements: readonly Node[]): number[] {
  const path: number[] = [];
  return findSuperStatement(statements, path) ? path : [];
}

function findSuperStatement(statements: readonly Node[], path: number[]): boolean {
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    if (isSuperCallStatement(statement)) {
      path.push(i);
      return true;
    }
    if (statement instanceof TryStatement) {
      path.push(i);
      if (findSuperStatement(statement.tryBlock.statements.nodes, path)) return true;
      path.pop();
    }
  }
  return false;
}

function isSuperCallStatement(statement: Node): boolean {
  if (!(statement instanceof ExpressionStatement)) return false;
  let expression = statement.expression;
  while (expression instanceof ParenthesizedExpression) expression = expression.expression;
  return expression instanceof CallExpression && expression.expression.kind === SyntaxKind.SuperKeyword;
}

/** Whether a class member, or a parameter of one, has decorators that apply, as tsgo's `ChildIsDecorated`. */
function childIsDecorated(legacy: boolean, members: NodeList): boolean {
  const nodes = members.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const member = nodes[i];
    if (hasDecorators(member) && memberCanBeDecorated(legacy, member)) return true;
    if (legacy && hasDecoratedParameter(member)) return true;
  }
  return false;
}

function hasDecoratedParameter(member: Node): boolean {
  if (
    member.kind !== SyntaxKind.MethodDeclaration &&
    member.kind !== SyntaxKind.SetAccessor &&
    member.kind !== SyntaxKind.Constructor
  )
    return false;
  const parameters = getParameters(member);
  if (parameters === undefined || getBody(member) === undefined) return false;
  for (let j = 0; j < parameters.nodes.length; j++) if (hasDecorators(parameters.nodes[j])) return true;
  return false;
}

function memberCanBeDecorated(legacy: boolean, member: Node): boolean {
  if (legacy && getName(member) instanceof PrivateIdentifier) return false;
  switch (member.kind) {
    case SyntaxKind.PropertyDeclaration:
      return legacy || !hasSyntacticModifier(member, ModifierFlags.Abstract | ModifierFlags.Ambient);
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.MethodDeclaration:
      return getBody(member) !== undefined;
  }
  return false;
}
