// Flattens destructuring assignments into assignments of each target, for exported names that
// must be assigned through `exports.x` or `ns.x`.
import {
  ArrayLiteralExpression,
  BinaryExpression,
  BindingElement,
  BindingPattern,
  ComputedPropertyName,
  ElementAccessExpression,
  Identifier,
  type Node,
  NodeFlags,
  NumericLiteral,
  ObjectLiteralExpression,
  OmittedExpression,
  ParameterDeclaration,
  PropertyAssignment,
  ShorthandPropertyAssignment,
  SpreadAssignment,
  SpreadElement,
  StringLiteral,
  VariableDeclaration,
  getName,
  NoSubstitutionTemplateLiteral,
  BigIntLiteral,
} from '../ast.js';
import { isAssignmentExpression, isDestructuringAssignment } from '../binder-utilities.js';
import { restHelper } from '../printer/helpers.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import type { VisitorHooks } from './visitor-hooks.js';

/** Creates the assignment of a flattened value to an identifier, such as `exports.x = value`. */
export abstract class AssignmentFactory {
  abstract createAssignment(name: Identifier, value: Node, pos: number, end: number): Node;
}

/** Flattens `node`, a destructuring assignment or variable declaration, into a comma expression. */
export function flattenDestructuringAssignment(
  visitor: VisitorHooks,
  node: Node,
  needsValue: boolean,
  assignments: AssignmentFactory | undefined,
): Node {
  return new Flattener(visitor, assignments).flattenAssignment(node, needsValue);
}

class Flattener {
  readonly visitor: VisitorHooks;
  readonly assignments: AssignmentFactory | undefined;
  readonly expressions: Node[];

  constructor(visitor: VisitorHooks, assignments: AssignmentFactory | undefined) {
    this.visitor = visitor;
    this.assignments = assignments;
    this.expressions = [];
  }

  flattenAssignment(start: Node, needsValue: boolean): Node {
    const factory = this.visitor.factory;
    let node = start;
    let pos = node.pos;
    let end = node.end;
    let value: Node | undefined = undefined;
    if (node instanceof BinaryExpression && isDestructuringAssignment(node)) {
      let assignment: BinaryExpression = node as BinaryExpression;
      value = assignment.right;
      while (isEmptyPattern(assignment.left)) {
        const right = assignment.right;
        if (right instanceof BinaryExpression && isDestructuringAssignment(right)) {
          assignment = right;
          node = right;
          pos = right.pos;
          end = right.end;
          value = right.right;
        } else return this.visitor.visitNode(right)!;
      }
    }
    if (value !== undefined) {
      value = this.visitor.visitNode(value)!;
      if (
        (value instanceof Identifier && elementAssignsToName(node, value.text)) ||
        elementContainsNonLiteralComputedName(node)
      )
        value = this.ensureIdentifier(value, false, pos, end);
      else if (needsValue) value = this.ensureIdentifier(value, true, pos, end);
      else if ((node.flags & NodeFlags.Synthesized) !== 0) {
        pos = value.pos;
        end = value.end;
      }
    }
    this.flattenElement(node, value, pos, end, node instanceof BinaryExpression && isDestructuringAssignment(node));
    if (value !== undefined && needsValue) {
      if (this.expressions.length === 0) return value;
      this.expressions.push(value);
    }
    const result = factory.inlineExpressions(this.expressions);
    return result !== undefined ? result : factory.created(new OmittedExpression());
  }

  private emitAssignment(target: Node, value: Node, pos: number, end: number, original: Node | undefined): boolean {
    let expression: Node;
    if (this.assignments !== undefined && target instanceof Identifier)
      expression = this.assignments.createAssignment(target as Identifier, value, pos, end);
    else {
      expression = this.visitor.factory.createAssignment(this.visitor.visitNode(target)!, value);
      expression.pos = pos;
      expression.end = end;
    }
    if (original !== undefined) this.visitor.context.setOriginal(expression, original);
    this.expressions.push(expression);
    return true;
  }

  private ensureIdentifier(value: Node, reuseIdentifierExpressions: boolean, pos: number, end: number): Node {
    if (reuseIdentifierExpressions && value instanceof Identifier) return value;
    const factory = this.visitor.factory;
    const temp = factory.createTempVariable(0);
    this.visitor.context.addVariableDeclaration(temp);
    const assignment = factory.createAssignment(temp, value);
    assignment.pos = pos;
    assignment.end = end;
    this.expressions.push(assignment);
    return temp;
  }

  private createDefaultValueCheck(value: Node, defaultValue: Node, pos: number, end: number): Node {
    const checked = this.ensureIdentifier(value, true, pos, end);
    const factory = this.visitor.factory;
    return factory.createConditionalExpression(factory.createTypeCheck(checked, 'undefined'), defaultValue, checked);
  }

  private createPropertyAccess(value: Node, propertyName: Node): Node {
    const factory = this.visitor.factory;
    if (propertyName instanceof ComputedPropertyName) {
      const argument = this.ensureIdentifier(
        this.visitor.visitNode(propertyName.expression)!,
        false,
        propertyName.pos,
        propertyName.end,
      );
      return factory.createElementAccessExpression(value, argument);
    }
    if (propertyName instanceof StringLiteral)
      return factory.createElementAccessExpression(
        value,
        factory.createStringLiteral(propertyName.text, propertyName.tokenFlags),
      );
    if (propertyName instanceof NoSubstitutionTemplateLiteral)
      return factory.createElementAccessExpression(
        value,
        factory.createStringLiteral(propertyName.text, TokenFlags.None),
      );
    if (propertyName instanceof NumericLiteral)
      return factory.createElementAccessExpression(value, factory.createNumericLiteral(propertyName.text));
    if (propertyName instanceof BigIntLiteral)
      return factory.createElementAccessExpression(
        value,
        factory.created(new BigIntLiteral(propertyName.text, TokenFlags.None)),
      );
    return factory.createPropertyAccessExpression(value, factory.createIdentifier(propertyNameText(propertyName)));
  }

  private flattenElement(element: Node, start: Node | undefined, pos: number, end: number, skipInitializer: boolean) {
    const target = getTargetOfBindingOrAssignmentElement(element);
    if (target === undefined) return false;
    let value = start;
    if (!skipInitializer) {
      const initializer = this.visitor.visitNode(getInitializerOfBindingOrAssignmentElement(element));
      if (initializer !== undefined) {
        if (value !== undefined) {
          value = this.createDefaultValueCheck(value, initializer, pos, end);
          if (!isSimpleCopiableExpression(initializer) && isPattern(target))
            value = this.ensureIdentifier(value, true, pos, end);
        } else value = initializer;
      } else if (value === undefined) value = this.visitor.factory.createVoidZero();
    }
    if (target instanceof ObjectLiteralExpression || target.kind === SyntaxKind.ObjectBindingPattern)
      return this.flattenObjectPattern(element, target, value!, pos, end);
    if (target instanceof ArrayLiteralExpression || target.kind === SyntaxKind.ArrayBindingPattern)
      return this.flattenArrayPattern(element, target, value!, pos, end);
    return this.emitAssignment(target, value!, pos, end, element);
  }

  private flattenObjectPattern(parent: Node, pattern: Node, start: Node, pos: number, end: number): boolean {
    const elements = getElementsOfPattern(pattern);
    let value = start;
    if (elements.length !== 1)
      value = this.ensureIdentifier(value, !isDeclarationBindingElement(parent) || elements.length !== 0, pos, end);
    const computedTempVariables: Node[] = [];
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (getRestIndicatorOfBindingOrAssignmentElement(element) === undefined) {
        const propertyName = tryGetPropertyNameOfBindingOrAssignmentElement(element);
        if (propertyName === undefined) continue;
        const rhs = this.createPropertyAccess(value, propertyName);
        if (propertyName instanceof ComputedPropertyName && rhs instanceof ElementAccessExpression)
          computedTempVariables.push(rhs.argumentExpression);
        this.flattenElement(element, rhs, element.pos, element.end, false);
      } else if (i === elements.length - 1) {
        const rhs = this.createRestHelper(value, elements, computedTempVariables, pattern.pos, pattern.end);
        this.flattenElement(element, rhs, element.pos, element.end, false);
      }
    }
    return true;
  }

  private flattenArrayPattern(parent: Node, pattern: Node, start: Node, pos: number, end: number): boolean {
    const factory = this.visitor.factory;
    const elements = getElementsOfPattern(pattern);
    let value = start;
    let allOmitted = true;
    for (let i = 0; i < elements.length; i++) if (!(elements[i] instanceof OmittedExpression)) allOmitted = false;
    if (elements.length !== 1 || allOmitted)
      value = this.ensureIdentifier(value, !isDeclarationBindingElement(parent) || elements.length !== 0, pos, end);
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element instanceof OmittedExpression) continue;
      if (getRestIndicatorOfBindingOrAssignmentElement(element) === undefined) {
        const rhs = factory.createElementAccessExpression(value, factory.createNumericLiteral(String(i)));
        this.flattenElement(element, rhs, element.pos, element.end, false);
      } else if (i === elements.length - 1) {
        const args = i === 0 ? [] : [factory.createNumericLiteral(String(i)) as Node];
        const rhs = factory.createCallExpression(
          factory.createPropertyAccessExpression(value, factory.createIdentifier('slice')),
          args,
        );
        this.flattenElement(element, rhs, element.pos, element.end, false);
      }
    }
    return true;
  }

  /** `__rest(value, ["a", "b"])`, excluding the properties named before the rest element. */
  private createRestHelper(value: Node, elements: Node[], computed: Node[], pos: number, end: number): Node {
    const factory = this.visitor.factory;
    this.visitor.context.requestEmitHelper(restHelper);
    const names: Node[] = [];
    let computedOffset = 0;
    for (let i = 0; i < elements.length - 1; i++) {
      const propertyName = tryGetPropertyNameOfBindingOrAssignmentElement(elements[i]);
      if (propertyName === undefined) continue;
      if (propertyName instanceof ComputedPropertyName) {
        const temp = computed[computedOffset++];
        names.push(
          factory.createConditionalExpression(
            factory.createTypeCheck(temp, 'symbol'),
            temp,
            factory.createBinaryExpression(
              temp,
              SyntaxKind.PlusToken,
              factory.createStringLiteral('', TokenFlags.None),
            ),
          ),
        );
      } else names.push(factory.createStringLiteralFromNode(propertyName));
    }
    const array = factory.created(new ArrayLiteralExpression(factory.createNodeList(names), false));
    array.pos = pos;
    array.end = end;
    return factory.createCallExpression(factory.createUnscopedHelperName('__rest'), [value, array]);
  }
}

function propertyNameText(node: Node): string {
  if (node instanceof Identifier) return node.text;
  return '';
}

function isEmptyPattern(node: Node): boolean {
  if (node instanceof ArrayLiteralExpression) return node.elements.nodes.length === 0;
  if (node instanceof ObjectLiteralExpression) return node.properties.nodes.length === 0;
  return false;
}

function isPattern(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ObjectBindingPattern:
    case SyntaxKind.ArrayBindingPattern:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.ArrayLiteralExpression:
      return true;
  }
  return false;
}

/** Strings, numbers, keywords and identifiers: copied rather than cached in a temporary. */
export function isSimpleCopiableExpression(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.Identifier:
      return true;
  }
  return node.kind >= SyntaxKind.FirstKeyword && node.kind <= SyntaxKind.LastKeyword;
}

function isDeclarationBindingElement(node: Node): boolean {
  return (
    node.kind === SyntaxKind.VariableDeclaration ||
    node.kind === SyntaxKind.Parameter ||
    node.kind === SyntaxKind.BindingElement
  );
}

function getElementsOfPattern(node: Node): Node[] {
  if (node instanceof BindingPattern) return node.elements.nodes;
  if (node instanceof ArrayLiteralExpression) return node.elements.nodes;
  if (node instanceof ObjectLiteralExpression) return node.properties.nodes;
  return [];
}

export function getTargetOfBindingOrAssignmentElement(element: Node): Node | undefined {
  if (isDeclarationBindingElement(element)) return getName(element);
  if (element instanceof PropertyAssignment) return getTargetOfBindingOrAssignmentElement(element.initializer);
  if (element instanceof ShorthandPropertyAssignment) return element.name;
  if (element instanceof SpreadAssignment) return getTargetOfBindingOrAssignmentElement(element.expression);
  if (element.kind === SyntaxKind.MethodDeclaration || element.kind === SyntaxKind.GetAccessor) return undefined;
  if (element.kind === SyntaxKind.SetAccessor) return undefined;
  if (element instanceof BinaryExpression && isAssignmentExpression(element, true))
    return getTargetOfBindingOrAssignmentElement(element.left);
  if (element instanceof SpreadElement) return getTargetOfBindingOrAssignmentElement(element.expression);
  return element;
}

function getInitializerOfBindingOrAssignmentElement(element: Node | undefined): Node | undefined {
  if (element === undefined) return undefined;
  if (element instanceof VariableDeclaration) return element.initializer;
  if (element instanceof ParameterDeclaration) return element.initializer;
  if (element instanceof BindingElement) return element.initializer;
  if (element instanceof PropertyAssignment) {
    const initializer = element.initializer;
    return initializer instanceof BinaryExpression && isAssignmentExpression(initializer, true)
      ? initializer.right
      : undefined;
  }
  if (element instanceof ShorthandPropertyAssignment) return element.objectAssignmentInitializer;
  if (element instanceof BinaryExpression && isAssignmentExpression(element, true)) return element.right;
  if (element instanceof SpreadElement) return getInitializerOfBindingOrAssignmentElement(element.expression);
  return undefined;
}

function getRestIndicatorOfBindingOrAssignmentElement(element: Node): Node | undefined {
  if (element instanceof ParameterDeclaration) return element.dotDotDotToken;
  if (element instanceof BindingElement) return element.dotDotDotToken;
  if (element instanceof SpreadElement || element instanceof SpreadAssignment) return element;
  return undefined;
}

function tryGetPropertyNameOfBindingOrAssignmentElement(element: Node): Node | undefined {
  if (element instanceof BindingElement && element.propertyName !== undefined)
    return literalComputedName(element.propertyName);
  if (element instanceof PropertyAssignment) return literalComputedName(element.name);
  if (element instanceof SpreadAssignment) return undefined;
  const target = getTargetOfBindingOrAssignmentElement(element);
  return target !== undefined && isPropertyName(target) ? target : undefined;
}

function literalComputedName(name: Node): Node {
  if (name instanceof ComputedPropertyName && isStringOrNumericLiteralLike(name.expression)) return name.expression;
  return name;
}

function isStringOrNumericLiteralLike(node: Node): boolean {
  return (
    node.kind === SyntaxKind.StringLiteral ||
    node.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    node.kind === SyntaxKind.NumericLiteral
  );
}

function isPropertyName(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.ComputedPropertyName:
    case SyntaxKind.BigIntLiteral:
      return true;
  }
  return false;
}

function elementAssignsToName(element: Node, name: string): boolean {
  const target = getTargetOfBindingOrAssignmentElement(element);
  if (target === undefined) return false;
  if (isPattern(target)) {
    const elements = getElementsOfPattern(target);
    for (let i = 0; i < elements.length; i++) if (elementAssignsToName(elements[i], name)) return true;
    return false;
  }
  return target instanceof Identifier && target.text === name;
}

function elementContainsNonLiteralComputedName(element: Node): boolean {
  const propertyName = tryGetPropertyNameOfBindingOrAssignmentElement(element);
  if (propertyName instanceof ComputedPropertyName && !isLiteralKind(propertyName.expression.kind)) return true;
  const target = getTargetOfBindingOrAssignmentElement(element);
  if (target === undefined || !isPattern(target)) return false;
  const elements = getElementsOfPattern(target);
  for (let i = 0; i < elements.length; i++) if (elementContainsNonLiteralComputedName(elements[i])) return true;
  return false;
}

function isLiteralKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstLiteralToken && kind <= SyntaxKind.LastLiteralToken;
}

/** `pattern = initializer` for a variable declaration, with binding patterns as assignment patterns. */
export function convertVariableDeclarationToAssignment(
  visitor: VisitorHooks,
  node: VariableDeclaration,
): Node | undefined {
  const initializer = node.initializer;
  if (initializer === undefined) return undefined;
  const context = visitor.context;
  const assignment = visitor.factory.createAssignment(convertBindingNameToTarget(visitor, node.name), initializer);
  context.setOriginal(assignment, node);
  context.assignCommentAndSourceMapRanges(assignment, node);
  return assignment;
}

function convertBindingNameToTarget(visitor: VisitorHooks, name: Node): Node {
  if (!(name instanceof BindingPattern)) return name;
  const factory = visitor.factory;
  const context = visitor.context;
  const elements = name.elements.nodes;
  const converted: Node[] = [];
  const object = name.kind === SyntaxKind.ObjectBindingPattern;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element instanceof BindingElement)
      converted.push(
        object
          ? convertToObjectElement(visitor, element as BindingElement)
          : convertToArrayElement(visitor, element as BindingElement),
      );
  }
  const list = factory.createNodeList(converted);
  list.pos = name.elements.pos;
  list.end = name.elements.end;
  const pattern = object
    ? factory.created(new ObjectLiteralExpression(list, false))
    : factory.created(new ArrayLiteralExpression(list, false));
  context.setOriginal(pattern as Node, name);
  context.assignCommentAndSourceMapRanges(pattern, name);
  return pattern as Node;
}

/** A created element converted from `element`, with its original and ranges. */
function converted(visitor: VisitorHooks, node: Node, element: BindingElement): Node {
  visitor.context.setOriginal(node, element);
  visitor.context.assignCommentAndSourceMapRanges(node, element);
  return node;
}

function convertToArrayElement(visitor: VisitorHooks, element: BindingElement): Node {
  const factory = visitor.factory;
  const name = element.name;
  if (name === undefined) return converted(visitor, factory.created(new OmittedExpression()), element);
  if (element.dotDotDotToken !== undefined)
    return converted(visitor, factory.created(new SpreadElement(name)), element);
  const target = convertBindingNameToTarget(visitor, name);
  if (element.initializer === undefined) return target;
  return converted(visitor, factory.createAssignment(target, element.initializer), element);
}

function convertToObjectElement(visitor: VisitorHooks, element: BindingElement): Node {
  const factory = visitor.factory;
  const name = element.name!;
  if (element.dotDotDotToken !== undefined)
    return converted(visitor, factory.created(new SpreadAssignment(name)), element);
  if (element.propertyName !== undefined) {
    let target = convertBindingNameToTarget(visitor, name);
    if (element.initializer !== undefined) target = factory.createAssignment(target, element.initializer);
    return converted(visitor, factory.createPropertyAssignment(element.propertyName, target), element);
  }
  return converted(
    visitor,
    factory.created(
      new ShorthandPropertyAssignment(
        undefined,
        name,
        undefined,
        undefined,
        element.initializer !== undefined ? factory.createToken(SyntaxKind.EqualsToken) : undefined,
        element.initializer,
      ),
    ),
    element,
  );
}
