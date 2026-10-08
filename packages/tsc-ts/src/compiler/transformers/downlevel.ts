// The transforms lowering syntax newer than the target, in the order tsgo runs them.
import type { CompilerOptions } from '../options.js';
import { ScriptTarget, getEmitScriptTarget, getUseDefineForClassFields } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { AsyncFunctions } from './async.js';
import { ClassFieldsTransformer } from './class-fields.js';
import type { EmitResolver } from './emit-resolver.js';
import { ESDecorators, shouldTransformESDecorators } from './es-decorators.js';
import { ExponentiationTransformer } from './exponentiation.js';
import { AsyncIteration } from './for-await.js';
import { LogicalAssignmentTransformer } from './logical-assignment.js';
import { NullishCoalescingTransformer } from './nullish-coalescing.js';
import { ObjectRestSpreadTransformer } from './object-rest-spread.js';
import { OptionalCatchTransformer } from './optional-catch.js';
import { OptionalChainTransformer } from './optional-chain.js';
import type { SyntaxFacts } from './syntax-facts.js';
import { TaggedTemplateTransformer } from './tagged-template.js';
import type { Transformer } from './transformer.js';
import { UsingTransformer } from './using.js';

export function addDownlevelTransformers(
  transformers: Transformer[],
  context: EmitContext,
  options: CompilerOptions,
  facts: SyntaxFacts,
  resolver: EmitResolver,
): void {
  const target = getEmitScriptTarget(options);
  // ES2022 and later: `using` declarations.
  if (target < ScriptTarget.ESNext) transformers.push(new UsingTransformer(context, facts));
  // ESNext: decorators and class fields.
  if (shouldTransformESDecorators(options)) transformers.push(new ESDecorators(context, facts));
  if (!(target >= ScriptTarget.ESNext && getUseDefineForClassFields(options)))
    transformers.push(new ClassFieldsTransformer(context, options, facts, resolver));
  if (target >= ScriptTarget.ES2021) return;
  transformers.push(new LogicalAssignmentTransformer(context, facts));
  if (target >= ScriptTarget.ES2020) return;
  transformers.push(new NullishCoalescingTransformer(context, facts));
  transformers.push(new OptionalChainTransformer(context, facts));
  if (target >= ScriptTarget.ES2019) return;
  transformers.push(new OptionalCatchTransformer(context, facts));
  if (target >= ScriptTarget.ES2018) return;
  transformers.push(new ObjectRestSpreadTransformer(context, facts));
  transformers.push(new AsyncIteration(context, facts));
  transformers.push(new TaggedTemplateTransformer(context, facts));
  if (target >= ScriptTarget.ES2017) return;
  transformers.push(new AsyncFunctions(context, facts));
  if (target >= ScriptTarget.ES2016) return;
  transformers.push(new ExponentiationTransformer(context, facts));
}
