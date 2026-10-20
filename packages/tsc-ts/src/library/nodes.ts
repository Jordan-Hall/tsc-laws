// Node functions of tsc-ts's public API, with TypeScript 7's behavior.

import {
  getModifiers as compilerGetModifiers,
  type Node as CompilerNode,
  type ModifierList as CompilerModifierList,
  type NodeList as CompilerNodeList,
  NodeVisitor,
  type SourceFile as CompilerSourceFile,
} from '../compiler/ast.js';
import { getTokenPosOfNode } from '../compiler/astnav.js';
import {
  getCombinedModifierFlags as compilerModifierFlags,
  getCombinedNodeFlags as compilerNodeFlags,
  getSourceFileOfNode as compilerSourceFileOfNode,
} from '../compiler/binder-utilities.js';
import { getJSDoc as compilerGetJSDoc } from '../compiler/parser.js';
import { computeLineOfPosition, tokenToString as compilerTokenToString } from '../compiler/scanner.js';
import { SyntaxKind as CompilerSyntaxKind } from '../compiler/syntax-kind.js';
import type { JSDoc, LineAndCharacter, ModifierList, Node, NodeList, SourceFile } from './ast.js';
import type { ModifierFlags, NodeFlags, SyntaxKind } from './enums.generated.js';
import type { Diagnostic } from './types.js';

const compilerNode = (node: Node): CompilerNode => node as unknown as CompilerNode;

/** Visits the children of a node; stops at the first callback that answers a truthy value. */
class CallbackVisitor extends NodeVisitor {
  result: unknown = undefined;

  constructor(
    private readonly cbNode: (node: Node) => unknown,
    private readonly cbNodes: ((nodes: NodeList) => unknown) | undefined,
  ) {
    super();
  }

  visitNode(node: CompilerNode): boolean {
    const result = this.cbNode(node as unknown as Node);
    if (!result) return false;
    this.result = result;
    return true;
  }

  visitList(list: CompilerNodeList): boolean {
    if (this.cbNodes === undefined) return super.visitList(list);
    const result = this.cbNodes(list as unknown as NodeList);
    if (!result) return false;
    this.result = result;
    return true;
  }

  visitModifiers(list: CompilerModifierList): boolean {
    return this.visitList(list);
  }
}

/**
 * Calls `cbNode` for each child of `node`, in source order, or `cbNodes` for each list of children when it
 * is given; returns the first truthy value a callback answers. JSDoc is not visited (`getJSDoc`).
 */
export function forEachChild<T>(
  node: Node,
  cbNode: (node: Node) => T | undefined,
  cbNodes?: (nodes: NodeList) => T | undefined,
): T | undefined {
  const visitor = new CallbackVisitor(cbNode, cbNodes);
  compilerNode(node).forEachChild(visitor);
  return visitor.result as T | undefined;
}

/** Collects the children of a node, in source order. */
class ChildCollector extends NodeVisitor {
  readonly children: CompilerNode[] = [];

  visitNode(node: CompilerNode): boolean {
    this.children.push(node);
    return false;
  }
}

/**
 * Visits `root` and its descendants in preorder, with `depth` the number of levels below `root`, without
 * recursion. The callback may answer 'skip' to leave a node's children unvisited, or 'stop' to end the walk.
 */
export function walkPreorder(root: Node, cb: (node: Node, depth: number) => void | 'skip' | 'stop'): void {
  const stack: CompilerNode[] = [compilerNode(root)];
  const depths: number[] = [0];
  const collector = new ChildCollector();
  // Declared outside the loop: scriptc compiles the node's conversion to the public Node from a variable there.
  let node: CompilerNode;
  while (stack.length > 0) {
    node = stack.pop()!;
    const depth = depths.pop()!;
    const verdict = cb(node as unknown as Node, depth);
    if (verdict === 'stop') return;
    if (verdict === 'skip') continue;
    collector.children.length = 0;
    node.forEachChild(collector);
    const children = collector.children;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]!);
      depths.push(depth + 1);
    }
  }
}

/**
 * The start of the first token of `node`, after its leading trivia; with `includeJSDoc`, the start of its
 * first JSDoc comment where it has one.
 */
export function tokenStartOfNode(node: Node, includeJSDoc = false): number {
  const file = compilerSourceFileOfNode(compilerNode(node));
  return getTokenPosOfNode(compilerNode(node), file, includeJSDoc);
}

/** The source file `node` is in: the root of its parents. */
export function getSourceFileOfNode(node: Node): SourceFile {
  let current = node;
  while (current.parent !== undefined) current = current.parent;
  return current as SourceFile;
}

/**
 * The text of `node` in its source file, from the start of its first token (`tokenStartOfNode`) to its end:
 * TypeScript's `node.getText()`.
 */
export function getTextOfNode(node: Node): string {
  const file = compilerSourceFileOfNode(compilerNode(node));
  return file.text.substring(getTokenPosOfNode(compilerNode(node), file, false), node.end);
}

/** The JSDoc comments of `node`, as the JSDoc nodes TypeScript 7 attaches to it (parsed on first use). */
export function getJSDoc(node: Node): readonly JSDoc[] {
  const file = compilerSourceFileOfNode(compilerNode(node));
  return compilerGetJSDoc(file, compilerNode(node)) as unknown as readonly JSDoc[];
}

/** The modifiers of a declaration, decorators included, as TypeScript 7 keeps them. */
export function getModifiers(node: Node): ModifierList | undefined {
  return compilerGetModifiers(compilerNode(node)) as unknown as ModifierList | undefined;
}

/** Whether a node of this kind can have modifiers (TypeScript 7's CanHaveModifiers). */
export function canHaveModifiers(node: Node): boolean {
  switch (compilerNode(node).kind) {
    case CompilerSyntaxKind.TypeParameter:
    case CompilerSyntaxKind.Parameter:
    case CompilerSyntaxKind.PropertySignature:
    case CompilerSyntaxKind.PropertyDeclaration:
    case CompilerSyntaxKind.MethodSignature:
    case CompilerSyntaxKind.MethodDeclaration:
    case CompilerSyntaxKind.Constructor:
    case CompilerSyntaxKind.GetAccessor:
    case CompilerSyntaxKind.SetAccessor:
    case CompilerSyntaxKind.IndexSignature:
    case CompilerSyntaxKind.ConstructorType:
    case CompilerSyntaxKind.FunctionExpression:
    case CompilerSyntaxKind.ArrowFunction:
    case CompilerSyntaxKind.ClassExpression:
    case CompilerSyntaxKind.VariableStatement:
    case CompilerSyntaxKind.FunctionDeclaration:
    case CompilerSyntaxKind.ClassDeclaration:
    case CompilerSyntaxKind.InterfaceDeclaration:
    case CompilerSyntaxKind.TypeAliasDeclaration:
    case CompilerSyntaxKind.EnumDeclaration:
    case CompilerSyntaxKind.ModuleDeclaration:
    case CompilerSyntaxKind.ImportEqualsDeclaration:
    case CompilerSyntaxKind.ImportDeclaration:
    case CompilerSyntaxKind.JSImportDeclaration:
    case CompilerSyntaxKind.ExportAssignment:
    case CompilerSyntaxKind.ExportDeclaration:
      return true;
  }
  return false;
}

/**
 * The modifier flags of a declaration with those of the declarations it is part of: for a binding element,
 * of the declaration of its outermost pattern; for a variable declaration, of its list and statement.
 */
export function getCombinedModifierFlags(node: Node): ModifierFlags {
  return compilerModifierFlags(compilerNode(node)) as number as ModifierFlags;
}

/** The node flags of a declaration with those of the declarations it is part of, as getCombinedModifierFlags. */
export function getCombinedNodeFlags(node: Node): NodeFlags {
  return compilerNodeFlags(compilerNode(node)) as number as NodeFlags;
}

/** The UTF-16 offset at which each line of the file starts. */
export function getLineStarts(file: SourceFile): readonly number[] {
  return (file as unknown as CompilerSourceFile).lineStarts();
}

/** The 0-based line and character of a UTF-16 position in the file. */
export function getLineAndCharacterOfPosition(file: SourceFile, position: number): LineAndCharacter {
  const lineStarts = getLineStarts(file);
  const line = computeLineOfPosition(lineStarts, position);
  return { line, character: position - lineStarts[line]! };
}

/** The UTF-16 position of a 0-based line and character in the file. */
export function getPositionOfLineAndCharacter(file: SourceFile, line: number, character: number): number {
  return getLineStarts(file)[line]! + character;
}

/** The text of a punctuation or keyword token kind, or undefined for other kinds. */
export function tokenToString(kind: SyntaxKind): string | undefined {
  const text = compilerTokenToString(kind as number as CompilerSyntaxKind);
  return text === '' ? undefined : text;
}

/**
 * A diagnostic's text with its chain of messages, each on its own line, indented two spaces per level of
 * the chain, as TypeScript prints them.
 */
export function flattenDiagnosticMessageText(
  diagnostic: Diagnostic | string | undefined,
  newLine: string,
  indent = 0,
): string {
  if (diagnostic === undefined) return '';
  if (typeof diagnostic === 'string') return diagnostic;
  let result = '';
  if (indent > 0) {
    result += newLine;
    for (let i = 0; i < indent; i++) result += '  ';
  }
  result += diagnostic.text;
  for (const child of diagnostic.messageChain) result += flattenDiagnosticMessageText(child, newLine, indent + 1);
  return result;
}
