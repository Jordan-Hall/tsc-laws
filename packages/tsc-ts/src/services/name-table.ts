// The names used in a source file, with the position of each name used once.
import {
  ElementAccessExpression,
  getTagName,
  getText,
  type Node,
  NodeVisitor,
  type SourceFile,
} from '../compiler/ast.js';
import { getJSDoc } from '../compiler/parser.js';
import { isDeclarationName } from '../compiler/checker-services.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';

const tables = new Map<SourceFile, Map<string, number>>();

/** Each name in `file` with its position, or -1 for names used more than once. */
export function getNameTable(file: SourceFile): Map<string, number> {
  let table = tables.get(file);
  if (table === undefined) {
    if (tables.size > 16) tables.clear();
    table = new Map<string, number>();
    file.forEachChild(new NameCollector(file, table));
    tables.set(file, table);
  }
  return table;
}

class NameCollector extends NodeVisitor {
  constructor(
    readonly file: SourceFile,
    readonly table: Map<string, number>,
  ) {
    super();
  }

  visitNode(node: Node): boolean {
    if (isName(node)) {
      const text = getText(node);
      this.table.set(text, this.table.has(text) ? -1 : node.pos);
    }
    node.forEachChild(this);
    for (const jsDoc of getJSDoc(this.file, node)) jsDoc.forEachChild(this);
    return false;
  }
}

function isName(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Identifier:
      return !isTagName(node) && getText(node) !== '';
    case SyntaxKind.PrivateIdentifier:
      return true;
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return literalIsName(node);
  }
  return false;
}

function isTagName(node: Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    parent.kind >= SyntaxKind.FirstJSDocTagNode &&
    parent.kind <= SyntaxKind.LastJSDocTagNode &&
    getTagName(parent) === node
  );
}

function literalIsName(node: Node): boolean {
  const parent = node.parent!;
  return (
    isDeclarationName(node) ||
    parent.kind === SyntaxKind.ExternalModuleReference ||
    (parent instanceof ElementAccessExpression && parent.argumentExpression === node) ||
    (parent.kind === SyntaxKind.ComputedPropertyName && parent.parent !== undefined && isDeclarationName(parent))
  );
}
