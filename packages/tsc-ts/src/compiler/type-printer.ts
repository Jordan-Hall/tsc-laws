// Printing types, symbols, signatures and type predicates as text, as tsgo does: the node builder
// writes their nodes and the printer prints them.
import type { Node } from './ast.js';
import type { Checker } from './checker.js';
import { getBaseTypeOfEnumLikeType, getRegularTypeOfLiteralType, typesOf } from './checker-type-factory.js';
import { type Signature, SignatureFlags, type Type, TypeFlags, type TypePredicate } from './checker-types.js';
import { NodeBuilder, typeToStringFromTypeNode } from './node-builder.js';
import { symbolToExpression } from './node-builder-names.js';
import { newPseudoChecker } from './node-builder-pseudo.js';
import { Printer, PrinterOptions } from './printer/printer.js';
import { TextWriter } from './printer/text-writer.js';
import { type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { NodeBuilderFlags, NodeBuilderInternalFlags } from './transformers/declarations-resolver.js';

/** Prints `node` on one line without comments. */
function printSingleLine(b: NodeBuilder, node: Node, neverAsciiEscape: boolean): string {
  const options = new PrinterOptions();
  options.removeComments = true;
  options.neverAsciiEscape = neverAsciiEscape;
  options.newLine = '';
  const writer = new TextWriter('', 0);
  new Printer(options, b.context).write(node, undefined, writer, undefined);
  return writer.getText();
}

/** `t` as text; `flags` are `TypeFormatFlags`. */
export function typeToString(c: Checker, t: Type, enclosingDeclaration?: Node, flags?: number): string {
  // Without explicit flags, unique symbols print as such and aliases from other scopes are used.
  const formatFlags =
    flags ?? NodeBuilderFlags.AllowUniqueESSymbolType | NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope;
  return typeToStringFromTypeNode(c, t, enclosingDeclaration, formatFlags) ?? '';
}

/** `symbol` as text: the expression naming it. */
export function symbolToString(c: Checker, symbol: Symbol): string {
  const b = new NodeBuilder(c, undefined, NodeBuilderFlags.IgnoreErrors, NodeBuilderInternalFlags.None, undefined);
  return printSingleLine(b, symbolToExpression(b, symbol, SymbolFlags.All), false);
}

/** `signature` as text: a call or construct signature without its trailing semicolon. */
export function signatureToString(c: Checker, signature: Signature): string {
  const kind =
    (signature.flags & SignatureFlags.Construct) !== 0 ? SyntaxKind.ConstructSignature : SyntaxKind.CallSignature;
  const b = new NodeBuilder(
    c,
    undefined,
    NodeBuilderFlags.IgnoreErrors | NodeBuilderFlags.WriteTypeParametersInQualifiedName,
    NodeBuilderInternalFlags.None,
    undefined,
  );
  b.pseudo = newPseudoChecker(c);
  const text = printSingleLine(b, b.signatureToSignatureDeclaration(signature, kind, undefined), true);
  return text.endsWith(';') ? text.substring(0, text.length - 1) : text;
}

/** `predicate` as text, like `x is T`. */
export function typePredicateToString(c: Checker, predicate: TypePredicate): string {
  const b = new NodeBuilder(
    c,
    undefined,
    NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope |
      NodeBuilderFlags.IgnoreErrors |
      NodeBuilderFlags.WriteTypeParametersInQualifiedName,
    NodeBuilderInternalFlags.None,
    undefined,
  );
  b.pseudo = newPseudoChecker(c);
  return printSingleLine(b, b.typePredicateToTypePredicateNode(predicate), false);
}

/** Union constituents as printed: enum and boolean literal runs collapse, null and undefined go last. */
export function formatUnionTypes(c: Checker, types: readonly Type[], expandingEnum: boolean): Type[] {
  const result: Type[] = [];
  let flags = 0;
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    flags |= t.flags;
    if ((t.flags & TypeFlags.Nullable) !== 0) continue;
    if ((t.flags & TypeFlags.BooleanLiteral) !== 0 || (!expandingEnum && (t.flags & TypeFlags.EnumLike) !== 0)) {
      const baseType = (t.flags & TypeFlags.BooleanLiteral) !== 0 ? c.booleanType : getBaseTypeOfEnumLikeType(c, t);
      if ((baseType.flags & TypeFlags.Union) !== 0) {
        const baseTypes = typesOf(baseType);
        const count = baseTypes.length;
        if (
          i + count <= types.length &&
          getRegularTypeOfLiteralType(c, types[i + count - 1]!) ===
            getRegularTypeOfLiteralType(c, baseTypes[count - 1]!)
        ) {
          result.push(baseType);
          i += count - 1;
          continue;
        }
      }
    }
    result.push(t);
  }
  if ((flags & TypeFlags.Null) !== 0) result.push(c.nullType);
  if ((flags & TypeFlags.Undefined) !== 0) result.push(c.undefinedType);
  return result;
}
