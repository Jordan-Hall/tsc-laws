// Module specifiers as module transforms write them.
import { type Node, StringLiteral } from '../ast.js';
import { getExternalModuleName } from '../ast-utilities.js';
import type { CompilerOptions } from '../options.js';
import { getOutputExtension } from '../output-paths.js';
import { changeExtension, hasTSFileExtension, isDeclarationFileName, pathIsRelative } from '../path.js';
import type { EmitContext } from '../printer/emit-context.js';
import { TokenFlags } from '../types.js';

/** The module name of an import, export or `import()` as written in output, or undefined. */
export function getExternalModuleNameLiteral(context: EmitContext, node: Node): StringLiteral | undefined {
  const name = getExternalModuleName(node);
  if (!(name instanceof StringLiteral)) return undefined;
  return context.factory.createStringLiteral(name.text, TokenFlags.None);
}

/** The arguments of the `require` call for an import: its rewritten module name. */
export function createRequireCallArguments(context: EmitContext, node: Node, options: CompilerOptions): Node[] {
  const name = getExternalModuleNameLiteral(context, node);
  return name === undefined ? [] : [rewriteModuleSpecifier(context, name, options)];
}

/** With `rewriteRelativeImportExtensions`, `./a.ts` becomes `./a.js`. */
export function rewriteModuleSpecifier(context: EmitContext, node: Node, options: CompilerOptions): Node {
  if (!(node instanceof StringLiteral) || !shouldRewriteModuleSpecifier(node.text, options)) return node;
  const text = node.text;
  const updatedText = changeExtension(text, getOutputExtension(text, options.jsx));
  if (updatedText === text) return node;
  const updated = context.factory.createStringLiteral(updatedText, node.tokenFlags);
  context.setOriginal(updated, node);
  context.assignCommentAndSourceMapRanges(updated, node);
  return updated;
}

function shouldRewriteModuleSpecifier(specifier: string, options: CompilerOptions): boolean {
  return (
    options.rewriteRelativeImportExtensions === true &&
    pathIsRelative(specifier) &&
    !isDeclarationFileName(specifier) &&
    hasTSFileExtension(specifier)
  );
}
