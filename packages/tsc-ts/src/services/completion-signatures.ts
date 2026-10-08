// The candidate signatures of a call, for string literal completions in its arguments.
import { getExpression, getTagName, type Node, TaggedTemplateExpression } from '../compiler/ast.js';
import type { Checker } from '../compiler/checker.js';
import { reorderCandidates } from '../compiler/checker-calls.js';
import { getTypeOfExpression } from '../compiler/checker-expressions.js';
import { getApparentType, getSignaturesOfType } from '../compiler/checker-members.js';
import { type Signature, SignatureKind } from '../compiler/checker-types.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';

/** The signatures overload resolution would consider for `call`, in resolution order. */
export function getResolvedSignatureWithCandidates(c: Checker, call: Node): Signature[] {
  let callee: Node | undefined;
  let kind = SignatureKind.Call;
  switch (call.kind) {
    case SyntaxKind.CallExpression:
      callee = getExpression(call);
      break;
    case SyntaxKind.NewExpression:
      callee = getExpression(call);
      kind = SignatureKind.Construct;
      break;
    case SyntaxKind.TaggedTemplateExpression:
      callee = (call as TaggedTemplateExpression).tag;
      break;
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
      callee = getTagName(call);
      break;
  }
  if (callee === undefined || callee.kind === SyntaxKind.SuperKeyword) return [];
  const t = getApparentType(c, getTypeOfExpression(c, callee));
  return reorderCandidates(c, getSignaturesOfType(c, t, kind), 0);
}
