// Lowers `a ?? b` to `a !== null && a !== void 0 ? a : b` (ES2020).
import { BinaryExpression, type Node } from '../ast.js';
import type { EmitContext } from '../printer/emit-context.js';
import { SyntaxKind } from '../syntax-kind.js';
import { isSimpleCopiableExpression } from './destructuring.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';

export class NullishCoalescingTransformer extends Transformer {
  readonly facts: SyntaxFacts;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsNullishCoalescing)) return node;
    if (node instanceof BinaryExpression && node.operatorToken.kind === SyntaxKind.QuestionQuestionToken) {
      const factory = this.factory;
      let left = this.visitNode(node.left)!;
      let right = left;
      if (!isSimpleCopiableExpression(left)) {
        right = this.context.addVariableDeclaration(factory.createTempVariable(0));
        left = factory.createAssignment(right, left);
      }
      return factory.createConditionalExpression(
        factory.createNotNullCondition(left, right, false),
        right,
        this.visitNode(node.right)!,
      );
    }
    return this.visitEachChild(node);
  }
}
