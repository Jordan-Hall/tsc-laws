// `law` declarations: what the checker requires of them. The runner (`tslaws`) executes and proves them; these rules
// keep a law a specification that the runner can load and generate inputs for.
import { Diagnostics } from './diagnostics.js';
import { FunctionDeclaration, Identifier, ModifierFlags, NodeFlags, ParameterDeclaration, type Node } from './ast.js';
import { getReturnTypeOfSignature, getSignatureFromDeclaration } from './checker-signatures.js';
import { getAwaitedType } from './checker-iteration.js';
import { getUnionType } from './checker-type-factory.js';
import { isTypeAssignableTo } from './relations.js';
import { type Checker } from './checker.js';
import { SyntaxKind } from './syntax-kind.js';
import { typeToString } from './type-printer.js';

export function isLaw(node: Node | undefined): node is FunctionDeclaration {
  return node instanceof FunctionDeclaration && (node.flags & NodeFlags.Law) !== 0;
}

/** Whether `node` sits inside a law, where calling another law is allowed. */
function insideLaw(node: Node): boolean {
  for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (isLaw(current)) return true;
  }
  return false;
}

export function checkLawDeclaration(c: Checker, node: Node): void {
  if (!isLaw(node)) return;
  const modifiers = node.modifiers?.modifierFlags ?? 0;
  if ((modifiers & ModifierFlags.Export) === 0) c.error(node.name ?? node, Diagnostics.A_law_must_be_exported_so_tslaws_can_load_it);
  if ((modifiers & ModifierFlags.Default) !== 0 || node.asteriskToken !== undefined)
    c.error(node.name ?? node, Diagnostics.A_law_cannot_be_a_generator_or_a_default_export);
  for (const parameter of node.parameters.nodes) {
    if (!(parameter instanceof ParameterDeclaration)) continue;
    if (!(parameter.name instanceof Identifier)) c.error(parameter.name, Diagnostics.A_law_parameter_must_be_a_plain_identifier);
    else if (parameter.type === undefined)
      c.error(parameter.name, Diagnostics.Parameter_0_of_a_law_needs_a_type_annotation_so_inputs_can_be_generated, parameter.name.text);
  }
  // A law may be async, so that it can wait for a browser to settle: it then returns a promise of the same.
  let returnType = getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, node));
  const shown = returnType;
  if ((modifiers & ModifierFlags.Async) !== 0) returnType = getAwaitedType(c, returnType) ?? returnType;
  if (!isTypeAssignableTo(c, returnType, getUnionType(c, [c.booleanType, c.voidType])))
    c.error(node.type ?? node.name ?? node, Diagnostics.A_law_must_return_boolean_or_void_not_0, typeToString(c, shown));
}

/** A law is a specification: code outside a law must not call it. */
export function checkLawCall(c: Checker, call: Node, declaration: Node | undefined): void {
  if (!isLaw(declaration) || insideLaw(call)) return;
  if (call.kind !== SyntaxKind.CallExpression) return;
  c.error(call, Diagnostics._0_is_a_law_and_only_another_law_can_call_it, declaration.name?.text ?? 'law');
}
