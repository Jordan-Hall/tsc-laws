// Stands in for a lowering that isn't implemented yet: files using the syntax are reported as
// unsupported rather than emitted untransformed.
import type { Node } from '../ast.js';
import type { EmitContext } from '../printer/emit-context.js';
import type { SyntaxKind } from '../syntax-kind.js';
import type { SubtreeFacts, SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';

export class PendingLowering extends Transformer {
  readonly facts: SyntaxFacts;
  /** Subtrees without these facts are skipped. */
  readonly mask: SubtreeFacts;
  /** Nodes of these kinds need the lowering. */
  readonly kinds: readonly SyntaxKind[];
  readonly what: string;

  constructor(
    context: EmitContext,
    facts: SyntaxFacts,
    mask: SubtreeFacts,
    kinds: readonly SyntaxKind[],
    what: string,
  ) {
    super(context);
    this.facts = facts;
    this.mask = mask;
    this.kinds = kinds;
    this.what = what;
  }

  visit(node: Node): Node | undefined {
    if (this.unsupported !== '' || !this.facts.has(node, this.mask)) return node;
    if (this.kinds.indexOf(node.kind) >= 0) return this.unsupportedNode(node, this.what);
    return this.visitEachChild(node);
  }
}
