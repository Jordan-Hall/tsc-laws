// Calls, `new` and tagged templates: signature selection, argument checks and arity errors.
//
// Overload resolution without inference: non-generic candidates are chosen by arity and argument
// assignability; generic candidates by arity, with their type parameters instantiated to `any`.
import { getArguments as getNodeArguments } from './ast.js';
import {
  type CallExpression,
  type NewExpression,
  type Node,
  type ParameterDeclaration,
  type TaggedTemplateExpression,
  getName,
  getParameters,
  TemplateExpression,
  getExpression,
  getText,
} from './ast.js';
import { isExpressionOfOptionalChainRoot, isOptionalChain, isOutermostOptionalChain } from './binder-utilities.js';
import { Diagnostic, Diagnostics } from './diagnostics.js';
import { skipTrivia } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { CheckMode, type Signature, SignatureKind, type Type, TypeFlags } from './checker-types.js';
import { createPromiseType } from './checker-globals.js';
import { isErrorType } from './checker-type-factory.js';
import { getApparentType, getSignaturesOfType } from './checker-members.js';
import {
  getMinArgumentCount,
  getParameterCount,
  getReturnTypeOfSignature,
  getSignatureInstantiation,
  hasEffectiveRestParameter,
  tryGetTypeAtPosition,
} from './checker-signatures.js';
import { addOptionalTypeMarker, getOptionalType, removeOptionalTypeMarker } from './checker-symbol-types.js';
import { checkTypeAssignableTo, isTypeAssignableTo } from './relations.js';
import { getNonNullableType } from './checker-flow.js';
import { checkExpression, checkNonNullType } from './checker-expressions.js';
import { isContextSensitive } from './checker-functions.js';
import { getSourceFileOfNode } from './binder-utilities.js';

/** The type of an optional chain's expression with the chain's `undefined` removed. */
export function getOptionalExpressionType(c: Checker, exprType: Type, expression: Node): Type {
  if (isExpressionOfOptionalChainRoot(expression)) return getNonNullableType(c, exprType);
  if (isOptionalChain(expression)) return removeOptionalTypeMarker(c, exprType);
  return exprType;
}

export function propagateOptionalTypeMarker(c: Checker, t: Type, node: Node, wasOptional: boolean): Type {
  if (!wasOptional) return t;
  return isOutermostOptionalChain(node) ? getOptionalType(c, t, false) : addOptionalTypeMarker(c, t);
}

function getArguments(node: Node): Node[] {
  if (node.kind === SyntaxKind.TaggedTemplateExpression) return [];
  const args = getNodeArguments(node);
  return args !== undefined ? args.nodes : [];
}

export function checkCallExpression(c: Checker, node: Node, _checkMode: CheckMode): Type {
  const call = node as CallExpression;
  const callee = call.expression;
  if (callee.kind === SyntaxKind.SuperKeyword) {
    checkArgumentsUntyped(c, call.arguments.nodes);
    return c.voidType;
  }
  if (callee.kind === SyntaxKind.ImportKeyword) {
    checkArgumentsUntyped(c, call.arguments.nodes);
    const specifier = call.arguments.nodes.length > 0 ? call.arguments.nodes[0] : undefined;
    if (
      specifier !== undefined &&
      (specifier.kind === SyntaxKind.StringLiteral || specifier.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
    )
      resolveExternalModuleName(c, node, specifier, false);
    return createPromiseType(c, c.anyType);
  }
  let funcType = checkExpression(c, callee);
  let wasOptional = false;
  if (isOptionalChain(node)) {
    const nonOptional = getOptionalExpressionType(c, funcType, callee);
    wasOptional = nonOptional !== funcType;
    funcType = nonOptional;
  } else funcType = checkNonNullType(c, funcType, callee);
  const returnType = resolveAndCheckCall(c, node, funcType, SignatureKind.Call);
  return propagateOptionalTypeMarker(c, returnType, node, wasOptional);
}

export function checkNewExpression(c: Checker, node: Node, _checkMode: CheckMode): Type {
  const expr = node as NewExpression;
  const funcType = checkNonNullType(c, checkExpression(c, expr.expression), expr.expression);
  return resolveAndCheckCall(c, node, funcType, SignatureKind.Construct);
}

export function checkTaggedTemplateExpression(c: Checker, node: Node, _checkMode: CheckMode): Type {
  const tagged = node as TaggedTemplateExpression;
  const tagType = checkExpression(c, tagged.tag);
  const template = tagged.template;
  if (template.kind === SyntaxKind.TemplateExpression)
    for (const span of (template as TemplateExpression).templateSpans.nodes) checkExpression(c, getExpression(span)!);
  if (isErrorType(c, tagType) || (tagType.flags & TypeFlags.Any) !== 0) return tagType;
  const signatures = getSignaturesOfType(c, getApparentType(c, tagType), SignatureKind.Call);
  if (signatures.length !== 1) return c.anyType;
  return getReturnTypeOfResolvedSignature(c, signatures[0]);
}

function checkArgumentsUntyped(c: Checker, args: Node[]): void {
  for (const arg of args) checkExpression(c, arg);
}

function resolveAndCheckCall(c: Checker, node: Node, funcType: Type, kind: SignatureKind): Type {
  const args = getArguments(node);
  if (isErrorType(c, funcType)) {
    checkArgumentsUntyped(c, args);
    return c.errorType;
  }
  const apparentType = getApparentType(c, funcType);
  if (isErrorType(c, apparentType)) {
    checkArgumentsUntyped(c, args);
    return c.errorType;
  }
  if ((funcType.flags & TypeFlags.Any) !== 0 || (apparentType.flags & TypeFlags.Any) !== 0) {
    checkArgumentsUntyped(c, args);
    return c.anyType;
  }
  const signatures = getSignaturesOfType(c, apparentType, kind);
  if (signatures.length === 0) {
    if (kind === SignatureKind.Call) {
      if (
        isTypeAssignableTo(c, funcType, c.globalFunctionType) &&
        getSignaturesOfType(c, apparentType, SignatureKind.Construct).length === 0
      ) {
        checkArgumentsUntyped(c, args);
        return c.anyType;
      }
    } else if (getSignaturesOfType(c, apparentType, SignatureKind.Call).length > 0) {
      checkArgumentsUntyped(c, args);
      return c.anyType;
    }
    checkArgumentsUntyped(c, args);
    reportInvocationError(c, node, apparentType, kind);
    return c.errorType;
  }
  const signature = chooseSignature(c, node, signatures, args);
  const links = c.nodeLinks(node);
  if (signature === undefined) {
    links.resolvedSignature = c.unknownSignature;
    checkArgumentsUntyped(c, args);
    return c.anyType;
  }
  links.resolvedSignature = signature;
  if (args.some((a) => a.kind === SyntaxKind.SpreadElement)) {
    checkArgumentsUntyped(c, args);
    return getReturnTypeOfResolvedSignature(c, signature);
  }
  if (
    args.length < getMinArgumentCount(c, signature) ||
    (!hasEffectiveRestParameter(c, signature) && args.length > getParameterCount(c, signature))
  ) {
    checkArgumentsUntyped(c, args);
    c.addDiagnostic(getArgumentArityError(c, node, signatures, args));
    return getReturnTypeOfResolvedSignature(c, signature);
  }
  checkArgumentTypes(c, signature, args, true);
  return getReturnTypeOfResolvedSignature(c, signature);
}

function reportInvocationError(c: Checker, node: Node, apparentType: Type, kind: SignatureKind): void {
  const errorTarget =
    node.kind === SyntaxKind.TaggedTemplateExpression ? (node as TaggedTemplateExpression).tag : getExpression(node)!;
  if (kind === SignatureKind.Call && getSignaturesOfType(c, apparentType, SignatureKind.Construct).length > 0) {
    c.error(
      node,
      Diagnostics.Value_of_type_0_is_not_callable_Did_you_mean_to_include_new,
      typeToStringLazy(c, apparentType),
    );
    return;
  }
  c.error(
    errorTarget,
    kind === SignatureKind.Call
      ? Diagnostics.This_expression_is_not_callable
      : Diagnostics.This_expression_is_not_constructable,
  );
}

function typeToStringLazy(c: Checker, t: Type): string {
  return typeToString(c, t);
}

function isGenericSignature(sig: Signature): boolean {
  return sig.typeParameters !== undefined && sig.typeParameters.length > 0;
}

function hasCorrectArity(c: Checker, sig: Signature, args: Node[]): boolean {
  if (args.some((a) => a.kind === SyntaxKind.SpreadElement)) return true;
  return (
    args.length >= getMinArgumentCount(c, sig) &&
    (hasEffectiveRestParameter(c, sig) || args.length <= getParameterCount(c, sig))
  );
}

function chooseSignature(c: Checker, node: Node, signatures: Signature[], args: Node[]): Signature | undefined {
  if (signatures.length === 1) return instantiateForCall(c, signatures[0]);
  const candidates: Signature[] = [];
  for (const sig of signatures) if (hasCorrectArity(c, sig, args)) candidates.push(sig);
  if (candidates.length === 0) {
    // The arity error is reported against all signatures.
    c.addDiagnostic(getArgumentArityError(c, node, signatures, args));
    c.nodeLinks(node).resolvedSignature = c.unknownSignature;
    return undefined;
  }
  if (candidates.length === 1) return instantiateForCall(c, candidates[0]);
  if (args.some((a) => isContextSensitive(c, a))) return undefined;
  for (const sig of candidates) {
    const instantiated = instantiateForCall(c, sig);
    c.nodeLinks(node).resolvedSignature = instantiated;
    if (checkArgumentTypes(c, instantiated, args, false)) return instantiated;
  }
  return undefined;
}

function instantiateForCall(c: Checker, sig: Signature): Signature {
  if (!isGenericSignature(sig)) return sig;
  const typeParameters = sig.typeParameters!;
  const anys: Type[] = [];
  for (let i = 0; i < typeParameters.length; i++) anys.push(c.anyType);
  return getSignatureInstantiation(c, sig, anys, false);
}

function getReturnTypeOfResolvedSignature(c: Checker, sig: Signature): Type {
  return getReturnTypeOfSignature(c, instantiateForCall(c, sig));
}

/** The signature argument contextual types come from while `call` is checked. */
export function resolveCallSignatureForContext(c: Checker, call: Node): Signature | undefined {
  const links = c.nodeLinks(call);
  const resolved = links.resolvedSignature;
  if (resolved !== undefined) return resolved === c.unknownSignature ? undefined : resolved;
  return undefined;
}

function checkArgumentTypes(c: Checker, sig: Signature, args: Node[], reportErrors: boolean): boolean {
  let ok = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.kind === SyntaxKind.OmittedExpression) continue;
    const paramType = tryGetTypeAtPosition(c, sig, i);
    const argType = checkExpression(c, arg);
    if (paramType === undefined) continue;
    if (reportErrors) {
      if (
        !checkTypeAssignableTo(
          c,
          argType,
          paramType,
          arg,
          Diagnostics.Argument_of_type_0_is_not_assignable_to_parameter_of_type_1,
        )
      )
        ok = false;
    } else if (!isTypeAssignableTo(c, argType, paramType)) return false;
  }
  return ok;
}

function getArgumentArityError(c: Checker, node: Node, signatures: Signature[], args: Node[]): Diagnostic {
  let minCount = Number.MAX_SAFE_INTEGER;
  let maxCount = Number.MIN_SAFE_INTEGER;
  let maxBelow = Number.MIN_SAFE_INTEGER;
  let minAbove = Number.MAX_SAFE_INTEGER;
  let closestSignature: Signature | undefined = undefined;
  for (const sig of signatures) {
    const minParameter = getMinArgumentCount(c, sig);
    const maxParameter = getParameterCount(c, sig);
    if (minParameter < minCount) {
      minCount = minParameter;
      closestSignature = sig;
    }
    maxCount = Math.max(maxCount, maxParameter);
    if (minParameter < args.length && minParameter > maxBelow) maxBelow = minParameter;
    if (args.length < maxParameter && maxParameter < minAbove) minAbove = maxParameter;
  }
  let hasRestParameter = false;
  for (const sig of signatures) if (hasEffectiveRestParameter(c, sig)) hasRestParameter = true;
  const parameterRange = hasRestParameter
    ? String(minCount)
    : minCount < maxCount
      ? minCount + '-' + maxCount
      : String(minCount);
  const errorNode = getErrorNodeForCallNode(node);
  const message = hasRestParameter
    ? Diagnostics.Expected_at_least_0_arguments_but_got_1
    : Diagnostics.Expected_0_arguments_but_got_1;
  if (minCount < args.length && args.length < maxCount)
    return createDiagnosticForNode(
      errorNode,
      Diagnostics.No_overload_expects_0_arguments_but_overloads_do_exist_that_expect_either_1_or_2_arguments,
      [String(args.length), String(maxBelow), String(minAbove)],
    );
  if (args.length < minCount) {
    const diagnostic = createDiagnosticForNode(errorNode, message, [parameterRange, String(args.length)]);
    const declaration = closestSignature?.declaration;
    if (declaration !== undefined) {
      const params = getParameters(declaration);
      const index = args.length + (closestSignature!.thisParameter !== undefined ? 1 : 0);
      const parameter = params !== undefined && index < params.nodes.length ? params.nodes[index] : undefined;
      if (parameter !== undefined) {
        const name = getName(parameter)!;
        if (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
          diagnostic.addRelatedInfo(
            createDiagnosticForNode(
              parameter,
              Diagnostics.An_argument_matching_this_binding_pattern_was_not_provided,
              [],
            ),
          );
        else if ((parameter as ParameterDeclaration).dotDotDotToken !== undefined)
          diagnostic.addRelatedInfo(
            createDiagnosticForNode(parameter, Diagnostics.Arguments_for_the_rest_parameter_0_were_not_provided, [
              getTextOfName(name),
            ]),
          );
        else
          diagnostic.addRelatedInfo(
            createDiagnosticForNode(parameter, Diagnostics.An_argument_for_0_was_not_provided, [getTextOfName(name)]),
          );
      }
    }
    return diagnostic;
  }
  if (maxCount >= args.length)
    return createDiagnosticForNode(errorNode, message, [parameterRange, String(args.length)]);
  const file = getSourceFileOfNode(node);
  let pos = args[maxCount].pos;
  let end = args[args.length - 1].end;
  if (end === pos) end++;
  pos = skipTrivia(file.text, pos);
  if (end < pos) end = pos;
  return new Diagnostic(file.diagnosticFile(), pos, end, message, [parameterRange, String(args.length)]);
}

function getTextOfName(name: Node): string {
  return name.kind === SyntaxKind.Identifier ? getText(name) : '';
}

function getErrorNodeForCallNode(node: Node): Node {
  if (node.kind === SyntaxKind.CallExpression) {
    const callee = (node as CallExpression).expression;
    if (callee.kind === SyntaxKind.PropertyAccessExpression) return getName(callee)!;
    return callee;
  }
  return node;
}

import { typeToString } from './type-printer.js';
import { resolveExternalModuleName } from './checker-symbols.js';
