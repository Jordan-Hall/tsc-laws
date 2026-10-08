// Replaces accesses of const enum members, such as `E.A`, with their values: `0 /* E.A */`.
import { type Node, NodeFlags } from '../ast.js';
import { getTextOfNodeFromSourceText } from '../ast-utilities.js';
import { getSourceFileOfNode } from '../binder-utilities.js';
import type { CompilerOptions } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { SyntaxKind } from '../syntax-kind.js';
import type { EmitResolver } from './emit-resolver.js';
import { ConstantKind } from './reference-resolver.js';
import { constantExpression } from './runtime-syntax.js';
import { Transformer } from './transformer.js';

export class ConstEnumInliner extends Transformer {
  readonly options: CompilerOptions;
  readonly resolver: EmitResolver;

  constructor(context: EmitContext, options: CompilerOptions, resolver: EmitResolver) {
    super(context);
    this.options = options;
    this.resolver = resolver;
  }

  visit(node: Node): Node | undefined {
    if (node.kind !== SyntaxKind.PropertyAccessExpression && node.kind !== SyntaxKind.ElementAccessExpression)
      return this.visitEachChild(node);
    const parseNode = this.context.parseNode(node);
    if (parseNode === undefined) return this.visitEachChild(node);
    const value = this.resolver.getConstantValue(parseNode);
    if (value.kind === ConstantKind.None) return this.visitEachChild(node);
    const replacement = constantExpression(this.factory, value);
    if (this.options.removeComments !== true) {
      const original = this.context.mostOriginal(node);
      if ((original.flags & NodeFlags.Synthesized) === 0) {
        const text = getTextOfNodeFromSourceText(getSourceFileOfNode(original).text, original);
        this.context.addSyntheticTrailingComment(
          replacement,
          SyntaxKind.MultiLineCommentTrivia,
          safeMultiLineComment(text),
          false,
        );
      }
    }
    return replacement;
  }
}

/** ` text ` with each `*` + `/` broken up so it can't end the comment. */
function safeMultiLineComment(text: string): string {
  return ' ' + text.split('*/').join('*_/') + ' ';
}
