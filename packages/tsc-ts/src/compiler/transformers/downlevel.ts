// The transforms lowering syntax newer than the target, in the order tsgo runs them.
import type { CompilerOptions } from '../options.js';
import { ScriptTarget, getEmitScriptTarget, getUseDefineForClassFields } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { SyntaxKind } from '../syntax-kind.js';
import { AsyncFunctions } from './async.js';
import { ESDecorators, shouldTransformESDecorators } from './es-decorators.js';
import { AsyncIteration } from './for-await.js';
import { PendingLowering } from './pending.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { type Node, SourceFile } from '../ast.js';
import { EmitFlags } from '../printer/emit-flags.js';
import type { Transformer } from './transformer.js';

export function addDownlevelTransformers(
  transformers: Transformer[],
  context: EmitContext,
  options: CompilerOptions,
  facts: SyntaxFacts,
): void {
  const target = getEmitScriptTarget(options);
  const useDefine = getUseDefineForClassFields(options);
  // ES2022 and later: `using` declarations.
  if (target < ScriptTarget.ESNext)
    transformers.push(
      new PendingLowering(
        context,
        facts,
        SubtreeFacts.ContainsUsing,
        [SyntaxKind.VariableDeclarationList],
        '`using` declarations',
      ),
    );
  // ESNext: decorators and class fields.
  if (shouldTransformESDecorators(options)) transformers.push(new ESDecorators(context, facts));
  if (target >= ScriptTarget.ES2022 && target < ScriptTarget.ESNext && useDefine)
    transformers.push(new PendingClassElements(context, facts));
  else if (!(target >= ScriptTarget.ESNext && useDefine))
    transformers.push(
      new PendingLowering(
        context,
        facts,
        SubtreeFacts.ContainsClassFields,
        [SyntaxKind.ClassDeclaration, SyntaxKind.ClassExpression, SyntaxKind.PrivateIdentifier],
        'Class fields',
      ),
    );
  if (target >= ScriptTarget.ES2021) return;
  transformers.push(
    new PendingLowering(
      context,
      facts,
      SubtreeFacts.ContainsLogicalAssignments,
      [SyntaxKind.BinaryExpression],
      'Logical assignments',
    ),
  );
  if (target >= ScriptTarget.ES2020) return;
  transformers.push(
    new PendingLowering(
      context,
      facts,
      SubtreeFacts.ContainsNullishCoalescing | SubtreeFacts.ContainsOptionalChaining,
      [SyntaxKind.QuestionQuestionToken, SyntaxKind.QuestionDotToken],
      'Optional chains',
    ),
  );
  if (target >= ScriptTarget.ES2019) return;
  transformers.push(
    new PendingLowering(
      context,
      facts,
      SubtreeFacts.ContainsMissingCatchClauseVariable,
      [SyntaxKind.CatchClause],
      'Optional catch bindings',
    ),
  );
  if (target >= ScriptTarget.ES2018) return;
  transformers.push(
    new PendingLowering(
      context,
      facts,
      SubtreeFacts.ContainsESObjectRestOrSpread,
      [SyntaxKind.SpreadAssignment, SyntaxKind.ObjectBindingPattern],
      'Object rest and spread',
    ),
  );
  transformers.push(new AsyncIteration(context, facts));
  transformers.push(
    new PendingLowering(
      context,
      facts,
      SubtreeFacts.ContainsInvalidTemplateEscape,
      [SyntaxKind.TaggedTemplateExpression],
      'Tagged templates',
    ),
  );
  if (target >= ScriptTarget.ES2017) return;
  transformers.push(new AsyncFunctions(context, facts));
  if (target >= ScriptTarget.ES2016) return;
  transformers.push(
    new PendingLowering(
      context,
      facts,
      SubtreeFacts.ContainsExponentiationOperator,
      [SyntaxKind.AsteriskAsteriskToken, SyntaxKind.AsteriskAsteriskEqualsToken],
      'Exponentiation',
    ),
  );
}

/**
 * Stands in for the class fields transform from ES2022 with define semantics, where it lowers
 * only `accessor` fields and the static private elements of classes with standard decorators.
 */
class PendingClassElements extends PendingLowering {
  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context, facts, SubtreeFacts.ContainsClassFields, [SyntaxKind.AccessorKeyword], 'Auto-accessors');
  }

  visit(node: Node): Node | undefined {
    if (
      node instanceof SourceFile &&
      (this.context.getEmitFlags(node) & EmitFlags.TransformPrivateStaticElements) !== 0
    )
      return this.unsupportedNode(node, 'Static private elements of decorated classes');
    return super.visit(node);
  }
}
