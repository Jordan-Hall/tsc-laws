// Error elaboration: assignability errors reported on the innermost part of an expression (an
// object literal property, an array literal element or an arrow function's returned expression).
import {
  type ArrowFunction,
  type BinaryExpression,
  type Node,
  type PropertyAssignment,
  getElements,
  getExpression,
  getName,
  getParameters,
  getProperties,
  getType,
} from './ast.js';
import { getSourceFileOfNode } from './binder-utilities.js';
import { type Diagnostic, type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import { SymbolFlags } from './symbol.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { AccessFlags, SignatureKind, type Type, TypeFlags } from './checker-types.js';
import { getNumberLiteralType, getUnionType, isTupleType, typesOf } from './checker-type-factory.js';
import {
  getApplicableIndexInfo,
  getPropertyOfType,
  getSignaturesOfType,
  getTypeOfPropertyOfType,
} from './checker-members.js';
import { getReturnTypeOfSignature, getSingleCallSignature } from './checker-signatures.js';
import { removeMissingType } from './checker-symbol-types.js';
import {
  getIndexedAccessTypeOrUndefined,
  getLiteralTypeFromProperty,
  getPropertyNameFromIndex,
} from './checker-type-operators.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName } from './checker-utilities.js';
import { type Relation, checkTypeRelatedTo, getBestMatchingTypeForElaboration, isTypeRelatedTo } from './relations.js';
import { checkExpressionEx, checkExpressionForMutableLocationEx, isConstTypeReference } from './checker-expressions.js';
import { popContextualType, pushContextualType } from './checker-contextual.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';
import { createPromiseType } from './checker-iteration.js';
import { FunctionFlags, getFunctionFlags } from './checker-utilities.js';
import { typeToString } from './type-printer.js';
import { CheckMode } from './checker-types.js';
import { elaborateJsxComponents } from './checker-jsx.js';

/** Checks that `source` relates to `target`, elaborating into `expr` when possible. */
export function checkTypeRelatedToAndOptionallyElaborate(
  c: Checker,
  source: Type,
  target: Type,
  relation: Relation,
  errorNode: Node | undefined,
  expr: Node | undefined,
  headMessage: DiagnosticMessage | undefined,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  if (isTypeRelatedTo(c, source, target, relation)) return true;
  if (errorNode !== undefined && !elaborateError(c, expr, source, target, relation, headMessage, diagnosticOutput))
    return checkTypeRelatedTo(c, source, target, relation, errorNode, headMessage, diagnosticOutput);
  return false;
}

function reportDiagnostic(c: Checker, diagnostic: Diagnostic, output: Diagnostic[] | undefined): void {
  if (output !== undefined) output.push(diagnostic);
  else c.addDiagnostic(diagnostic);
}

export function elaborateError(
  c: Checker,
  node: Node | undefined,
  source: Type,
  target: Type,
  relation: Relation,
  headMessage: DiagnosticMessage | undefined,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  if (node === undefined || isOrHasGenericConditional(target)) return false;
  if (
    elaborateDidYouMeanToCallOrConstruct(
      c,
      node,
      source,
      target,
      relation,
      SignatureKind.Construct,
      headMessage,
      diagnosticOutput,
    ) ||
    elaborateDidYouMeanToCallOrConstruct(
      c,
      node,
      source,
      target,
      relation,
      SignatureKind.Call,
      headMessage,
      diagnosticOutput,
    )
  )
    return true;
  switch (node.kind) {
    case SyntaxKind.AsExpression:
      if (!isConstAssertion(node)) break;
      return elaborateError(c, getExpression(node), source, target, relation, headMessage, diagnosticOutput);
    case SyntaxKind.JsxExpression:
    case SyntaxKind.ParenthesizedExpression:
      return elaborateError(c, getExpression(node), source, target, relation, headMessage, diagnosticOutput);
    case SyntaxKind.BinaryExpression: {
      const binary = node as BinaryExpression;
      const op = binary.operatorToken.kind;
      if (op === SyntaxKind.EqualsToken || op === SyntaxKind.CommaToken)
        return elaborateError(c, binary.right, source, target, relation, headMessage, diagnosticOutput);
      break;
    }
    case SyntaxKind.ObjectLiteralExpression:
      return elaborateObjectLiteral(c, node, source, target, relation, diagnosticOutput);
    case SyntaxKind.ArrayLiteralExpression:
      return elaborateArrayLiteral(c, node, source, target, relation, diagnosticOutput);
    case SyntaxKind.ArrowFunction:
      return elaborateArrowFunction(c, node as ArrowFunction, source, target, relation, diagnosticOutput);
    case SyntaxKind.JsxAttributes:
      return elaborateJsxComponents(c, node, source, target, relation, diagnosticOutput);
  }
  return false;
}

function isConstAssertion(node: Node): boolean {
  const typeNode = getType(node);
  return typeNode !== undefined && isConstTypeReference(typeNode);
}

function isOrHasGenericConditional(t: Type): boolean {
  return (
    (t.flags & TypeFlags.Conditional) !== 0 ||
    ((t.flags & TypeFlags.Intersection) !== 0 && typesOf(t).some(isOrHasGenericConditional))
  );
}

function elaborateDidYouMeanToCallOrConstruct(
  c: Checker,
  node: Node,
  source: Type,
  target: Type,
  relation: Relation,
  kind: SignatureKind,
  headMessage: DiagnosticMessage | undefined,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  const callable = getSignaturesOfType(c, source, kind).some((s) => {
    const returnType = getReturnTypeOfSignature(c, s);
    return (
      (returnType.flags & (TypeFlags.Any | TypeFlags.Never)) === 0 &&
      checkTypeRelatedTo(c, returnType, target, relation, undefined, undefined, undefined)
    );
  });
  if (!callable) return false;
  const diagnostics: Diagnostic[] = [];
  if (checkTypeRelatedTo(c, source, target, relation, node, headMessage, diagnostics)) return false;
  const diagnostic = diagnostics[0]!;
  diagnostic.addRelatedInfo(
    createDiagnosticForNode(
      node,
      kind === SignatureKind.Construct
        ? Diagnostics.Did_you_mean_to_use_new_with_this_expression
        : Diagnostics.Did_you_mean_to_call_this_expression,
      [],
    ),
  );
  reportDiagnostic(c, diagnostic, diagnosticOutput);
  return true;
}

function elaborateObjectLiteral(
  c: Checker,
  node: Node,
  source: Type,
  target: Type,
  relation: Relation,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  if ((target.flags & (TypeFlags.Primitive | TypeFlags.Never)) !== 0) return false;
  let reportedError = false;
  for (const prop of getProperties(node)!.nodes) {
    if (prop.kind === SyntaxKind.SpreadAssignment) continue;
    const symbol = getSymbolOfDeclaration(c, prop);
    if (symbol === undefined) continue;
    const nameType = getLiteralTypeFromProperty(c, symbol, TypeFlags.StringOrNumberLiteralOrUnique, false);
    if ((nameType.flags & TypeFlags.Never) !== 0) continue;
    switch (prop.kind) {
      case SyntaxKind.SetAccessor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.ShorthandPropertyAssignment:
        reportedError =
          elaborateElement(
            c,
            source,
            target,
            relation,
            getName(prop)!,
            undefined,
            nameType,
            undefined,
            undefined,
            [],
            diagnosticOutput,
          ) || reportedError;
        break;
      case SyntaxKind.PropertyAssignment: {
        const name = getName(prop)!;
        const message = isComputedNonLiteralName(name)
          ? Diagnostics.Type_of_computed_property_s_value_is_0_which_is_not_assignable_to_type_1
          : undefined;
        reportedError =
          elaborateElement(
            c,
            source,
            target,
            relation,
            name,
            (prop as PropertyAssignment).initializer,
            nameType,
            message,
            undefined,
            [],
            diagnosticOutput,
          ) || reportedError;
        break;
      }
    }
  }
  return reportedError;
}

function isComputedNonLiteralName(name: Node): boolean {
  if (name.kind !== SyntaxKind.ComputedPropertyName) return false;
  const expression = getExpression(name)!;
  return expression.kind !== SyntaxKind.StringLiteral && expression.kind !== SyntaxKind.NumericLiteral;
}

function isTupleLikeType(c: Checker, t: Type): boolean {
  return isTupleType(t) || getPropertyOfType(c, t, '0') !== undefined;
}

function elaborateArrayLiteral(
  c: Checker,
  node: Node,
  source: Type,
  target: Type,
  relation: Relation,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  if ((target.flags & (TypeFlags.Primitive | TypeFlags.Never)) !== 0) return false;
  if (!isTupleLikeType(c, source)) {
    pushContextualType(c, node, target, false);
    source = checkExpressionEx(c, node, CheckMode.Contextual | CheckMode.ForceTuple);
    popContextualType(c);
    if (!isTupleLikeType(c, source)) return false;
  }
  let reportedError = false;
  const elements = getElements(node)!.nodes;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!;
    if (
      element.kind === SyntaxKind.OmittedExpression ||
      (isTupleLikeType(c, target) && getPropertyOfType(c, target, String(i)) === undefined)
    )
      continue;
    const checkNode = getEffectiveCheckNode(element);
    reportedError =
      elaborateElement(
        c,
        source,
        target,
        relation,
        checkNode,
        checkNode,
        getNumberLiteralType(c, i),
        undefined,
        undefined,
        [],
        diagnosticOutput,
      ) || reportedError;
  }
  return reportedError;
}

function getEffectiveCheckNode(argument: Node): Node {
  let node = argument;
  while (node.kind === SyntaxKind.ParenthesizedExpression || node.kind === SyntaxKind.SatisfiesExpression)
    node = getExpression(node)!;
  return node;
}

/**
 * Elaborates the element `nameType` of `source` against `target`, reporting at `prop`. With `customMessage`,
 * that message is reported instead of the relation error.
 */
export function elaborateElement(
  c: Checker,
  source: Type,
  target: Type,
  relation: Relation,
  prop: Node,
  next: Node | undefined,
  nameType: Type,
  errorMessage: DiagnosticMessage | undefined,
  customMessage: DiagnosticMessage | undefined,
  customArgs: string[],
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  let targetPropType = getBestMatchIndexedAccessTypeOrUndefined(c, source, target, nameType);
  // Don't elaborate on indexes on generic variables.
  if (targetPropType === undefined || (targetPropType.flags & TypeFlags.IndexedAccess) !== 0) return false;
  let sourcePropType = getIndexedAccessTypeOrUndefined(c, source, nameType, AccessFlags.None);
  if (
    sourcePropType === undefined ||
    checkTypeRelatedTo(c, sourcePropType, targetPropType, relation, undefined, undefined, undefined)
  )
    return false;
  if (
    next !== undefined &&
    elaborateError(c, next, sourcePropType, targetPropType, relation, undefined, diagnosticOutput)
  )
    return true;
  // The property couldn't elaborate, so the error goes on the property itself, with the expression's type.
  const diagnostics: Diagnostic[] = [];
  const specificSource =
    next !== undefined ? checkExpressionForMutableLocationWithContextualType(c, next, sourcePropType) : sourcePropType;
  if (customMessage !== undefined) diagnostics.push(createDiagnosticForNode(prop, customMessage, customArgs));
  else {
    const propName = getPropertyNameFromIndex(nameType);
    const targetProperty = propName !== undefined ? getPropertyOfType(c, target, propName) : undefined;
    const sourceProperty = propName !== undefined ? getPropertyOfType(c, source, propName) : undefined;
    const targetIsOptional = targetProperty !== undefined && (targetProperty.flags & SymbolFlags.Optional) !== 0;
    const sourceIsOptional = sourceProperty !== undefined && (sourceProperty.flags & SymbolFlags.Optional) !== 0;
    targetPropType = removeMissingType(c, targetPropType, targetIsOptional);
    sourcePropType = removeMissingType(c, sourcePropType, targetIsOptional && sourceIsOptional);
    const result = checkTypeRelatedTo(c, specificSource, targetPropType, relation, prop, errorMessage, diagnostics);
    // When the expression type doesn't fail, the property type still must.
    if (result && specificSource !== sourcePropType)
      checkTypeRelatedTo(c, sourcePropType, targetPropType, relation, prop, errorMessage, diagnostics);
  }
  if (diagnostics.length === 0) return false;
  const diagnostic = diagnostics[0]!;
  let propertyName = '';
  let targetProp = undefined;
  if (isTypeUsableAsPropertyName(nameType)) {
    propertyName = getPropertyNameFromType(nameType);
    targetProp = getPropertyOfType(c, target, propertyName);
  }
  let issuedElaboration = false;
  if (targetProp === undefined) {
    const indexInfo = getApplicableIndexInfo(c, target, nameType);
    if (
      indexInfo !== undefined &&
      indexInfo.declaration !== undefined &&
      !c.host.isSourceFileDefaultLibrary(getSourceFileOfNode(indexInfo.declaration))
    ) {
      issuedElaboration = true;
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(
          indexInfo.declaration,
          Diagnostics.The_expected_type_comes_from_this_index_signature,
          [],
        ),
      );
    }
  }
  if (
    !issuedElaboration &&
    ((targetProp !== undefined && targetProp.declarations.length !== 0) ||
      (target.symbol !== undefined && target.symbol.declarations.length !== 0))
  ) {
    const targetNode =
      targetProp !== undefined && targetProp.declarations.length !== 0
        ? targetProp.declarations[0]!
        : target.symbol!.declarations[0]!;
    if (propertyName === '' || (nameType.flags & TypeFlags.UniqueESSymbol) !== 0)
      propertyName = typeToString(c, nameType);
    if (!c.host.isSourceFileDefaultLibrary(getSourceFileOfNode(targetNode)))
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(
          targetNode,
          Diagnostics.The_expected_type_comes_from_property_0_which_is_declared_here_on_type_1,
          [propertyName, typeToString(c, target)],
        ),
      );
  }
  reportDiagnostic(c, diagnostic, diagnosticOutput);
  return true;
}

export function getBestMatchIndexedAccessTypeOrUndefined(
  c: Checker,
  source: Type,
  target: Type,
  nameType: Type,
): Type | undefined {
  const idx = getIndexedAccessTypeOrUndefined(c, target, nameType, AccessFlags.None);
  if (idx !== undefined) return idx;
  if ((target.flags & TypeFlags.Union) !== 0) {
    const best = getBestMatchingTypeForElaboration(c, source, target);
    if (best !== undefined) return getIndexedAccessTypeOrUndefined(c, best, nameType, AccessFlags.None);
  }
  return undefined;
}

export function checkExpressionForMutableLocationWithContextualType(
  c: Checker,
  next: Node,
  sourcePropType: Type,
): Type {
  pushContextualType(c, next, sourcePropType, false);
  const result = checkExpressionForMutableLocationEx(c, next, CheckMode.Contextual);
  popContextualType(c);
  return result;
}

function elaborateArrowFunction(
  c: Checker,
  node: ArrowFunction,
  source: Type,
  target: Type,
  relation: Relation,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  // Blocks and functions with annotated parameters aren't elaborated.
  if (node.body.kind === SyntaxKind.Block || getParameters(node)!.nodes.some((p) => getType(p) !== undefined))
    return false;
  const sourceSig = getSingleCallSignature(c, source);
  if (sourceSig === undefined) return false;
  const targetSignatures = getSignaturesOfType(c, target, SignatureKind.Call);
  if (targetSignatures.length === 0) return false;
  const returnExpression = node.body;
  const sourceReturn = getReturnTypeOfSignature(c, sourceSig);
  const targetReturn = getUnionType(
    c,
    targetSignatures.map((s) => getReturnTypeOfSignature(c, s)),
  );
  if (checkTypeRelatedTo(c, sourceReturn, targetReturn, relation, undefined, undefined, undefined)) return false;
  if (elaborateError(c, returnExpression, sourceReturn, targetReturn, relation, undefined, diagnosticOutput))
    return true;
  const diagnostics: Diagnostic[] = [];
  checkTypeRelatedTo(c, sourceReturn, targetReturn, relation, returnExpression, undefined, diagnostics);
  if (diagnostics.length === 0) return false;
  const diagnostic = diagnostics[0]!;
  if (target.symbol !== undefined && target.symbol.declarations.length !== 0)
    diagnostic.addRelatedInfo(
      createDiagnosticForNode(
        target.symbol.declarations[0]!,
        Diagnostics.The_expected_type_comes_from_the_return_type_of_this_signature,
        [],
      ),
    );
  if (
    (getFunctionFlags(node) & FunctionFlags.Async) === 0 &&
    getTypeOfPropertyOfType(c, sourceReturn, 'then') === undefined &&
    checkTypeRelatedTo(c, createPromiseType(c, sourceReturn), targetReturn, relation, undefined, undefined, undefined)
  )
    diagnostic.addRelatedInfo(
      createDiagnosticForNode(node, Diagnostics.Did_you_mean_to_mark_this_function_as_async, []),
    );
  reportDiagnostic(c, diagnostic, diagnosticOutput);
  return true;
}
