// Constant evaluation of enum member initializers and template expressions.
import {
  type Node,
  getExpression,
  getInitializer,
  getText,
  getType,
  getName,
  type BinaryExpression,
  type TemplateExpression,
  type TemplateSpan,
  ElementAccessExpression,
  PrefixUnaryExpression,
} from './ast.js';
import { Diagnostics } from './diagnostics.js';
import { SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import { computeEnumMemberValues } from './checker-declared-types.js';
import { getGlobalSymbol, resolveEntityName } from './checker-symbols.js';
import { declarationNameToString, getSourceFileOfNode } from './binder-utilities.js';
import { isConstantVariable } from './checker-narrowing.js';
import { isBlockScopedNameDeclaredBeforeUse } from './checker-declaration-order.js';

export const enum EvaluatedKind {
  None = 0,
  Number = 1,
  String = 2,
}

/** How a value was evaluated, for the isolatedModules checks of enum members. */
export const enum EvaluatedFlags {
  None = 0,
  /** Written as a string: a string literal, a template, or `+` with one. */
  SyntacticallyString = 1 << 0,
  /** Read from a declaration in another file. */
  ResolvedOtherFiles = 1 << 1,
}

export class EvaluatorResult {
  kind: EvaluatedKind = EvaluatedKind.None;
  numberValue = 0;
  stringValue = '';
  flags: EvaluatedFlags = EvaluatedFlags.None;

  static number(value: number): EvaluatorResult {
    const r = new EvaluatorResult();
    r.kind = EvaluatedKind.Number;
    r.numberValue = value;
    return r;
  }

  static string(value: string): EvaluatorResult {
    const r = new EvaluatorResult();
    r.kind = EvaluatedKind.String;
    r.stringValue = value;
    return r;
  }
}

/** No constant value. */
function none(): EvaluatorResult {
  return new EvaluatorResult();
}

function withFlags(result: EvaluatorResult, flags: EvaluatedFlags): EvaluatorResult {
  result.flags = flags;
  return result;
}

/** The constant value of an enum member initializer, if it has one. */
export function evaluateEnumMember(c: Checker, expr: Node, member: Node): EvaluatorResult {
  return evaluate(c, expr, member);
}

/** The constant value of `expr`, evaluated at `location`. */
export function evaluate(c: Checker, expr: Node, location: Node): EvaluatorResult {
  switch (expr.kind) {
    case SyntaxKind.PrefixUnaryExpression: {
      const operand = evaluate(c, (expr as PrefixUnaryExpression).operand, location);
      if (operand.kind !== EvaluatedKind.Number) return none();
      const v = operand.numberValue;
      const flags = operand.flags & EvaluatedFlags.ResolvedOtherFiles;
      switch ((expr as PrefixUnaryExpression).operator) {
        case SyntaxKind.PlusToken:
          return withFlags(EvaluatorResult.number(v), flags);
        case SyntaxKind.MinusToken:
          return withFlags(EvaluatorResult.number(-v), flags);
        case SyntaxKind.TildeToken:
          return withFlags(EvaluatorResult.number(~v), flags);
      }
      return none();
    }
    case SyntaxKind.BinaryExpression: {
      const shape = expr as BinaryExpression;
      const left = evaluate(c, shape.left, location);
      const right = evaluate(c, shape.right, location);
      const op = shape.operatorToken.kind;
      const flags =
        ((left.flags | right.flags) & EvaluatedFlags.ResolvedOtherFiles) |
        (op === SyntaxKind.PlusToken ? (left.flags | right.flags) & EvaluatedFlags.SyntacticallyString : 0);
      if (left.kind === EvaluatedKind.Number && right.kind === EvaluatedKind.Number) {
        const l = left.numberValue;
        const r = right.numberValue;
        switch (op) {
          case SyntaxKind.BarToken:
            return withFlags(EvaluatorResult.number(l | r), flags);
          case SyntaxKind.AmpersandToken:
            return withFlags(EvaluatorResult.number(l & r), flags);
          case SyntaxKind.GreaterThanGreaterThanToken:
            return withFlags(EvaluatorResult.number(l >> r), flags);
          case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
            return withFlags(EvaluatorResult.number(l >>> r), flags);
          case SyntaxKind.LessThanLessThanToken:
            return withFlags(EvaluatorResult.number(l << r), flags);
          case SyntaxKind.CaretToken:
            return withFlags(EvaluatorResult.number(l ^ r), flags);
          case SyntaxKind.AsteriskToken:
            return withFlags(EvaluatorResult.number(l * r), flags);
          case SyntaxKind.SlashToken:
            return withFlags(EvaluatorResult.number(l / r), flags);
          case SyntaxKind.PlusToken:
            return withFlags(EvaluatorResult.number(l + r), flags);
          case SyntaxKind.MinusToken:
            return withFlags(EvaluatorResult.number(l - r), flags);
          case SyntaxKind.PercentToken:
            return withFlags(EvaluatorResult.number(l % r), flags);
          case SyntaxKind.AsteriskAsteriskToken:
            return withFlags(EvaluatorResult.number(l ** r), flags);
        }
        return none();
      }
      if (
        op === SyntaxKind.PlusToken &&
        left.kind !== EvaluatedKind.None &&
        right.kind !== EvaluatedKind.None &&
        (left.kind === EvaluatedKind.String || right.kind === EvaluatedKind.String)
      )
        return withFlags(EvaluatorResult.string(valueText(left) + valueText(right)), flags);
      return none();
    }
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return withFlags(EvaluatorResult.string(getText(expr)), EvaluatedFlags.SyntacticallyString);
    case SyntaxKind.TemplateExpression: {
      const shape = expr as TemplateExpression;
      let text = getText(shape.head);
      let flags = EvaluatedFlags.SyntacticallyString;
      for (const span of shape.templateSpans.nodes) {
        const s = span as TemplateSpan;
        const value = evaluate(c, s.expression, location);
        if (value.kind === EvaluatedKind.None) return none();
        text += valueText(value) + getText(s.literal);
        flags |= value.flags & EvaluatedFlags.ResolvedOtherFiles;
      }
      return withFlags(EvaluatorResult.string(text), flags);
    }
    case SyntaxKind.NumericLiteral:
      return EvaluatorResult.number(Number(getText(expr)));
    case SyntaxKind.ParenthesizedExpression:
      return evaluate(c, getExpression(expr)!, location);
    case SyntaxKind.Identifier:
    case SyntaxKind.PropertyAccessExpression: {
      const symbol = resolveEntityName(c, expr, SymbolFlags.Value, true, false, undefined);
      if (symbol === undefined) return none();
      if (expr.kind === SyntaxKind.Identifier) {
        const text = getText(expr);
        if (
          (text === 'Infinity' || text === 'NaN') &&
          symbol === getGlobalSymbol(c, text, SymbolFlags.Value, undefined)
        )
          return EvaluatorResult.number(Number(text));
      }
      if ((symbol.flags & SymbolFlags.EnumMember) !== 0)
        return evaluateEnumMemberReference(c, expr, symbol.valueDeclaration, location);
      // Constants without annotations evaluate to their initializers, when declared before the use.
      const declaration = symbol.valueDeclaration;
      if (
        isConstantVariable(c, symbol) &&
        declaration !== undefined &&
        declaration.kind === SyntaxKind.VariableDeclaration &&
        getType(declaration) === undefined &&
        getInitializer(declaration) !== undefined &&
        declaration !== location &&
        isBlockScopedNameDeclaredBeforeUse(c, declaration, location)
      ) {
        const result = evaluate(c, getInitializer(declaration)!, declaration);
        // A transpiler sees only this file, so a constant from another file is not written as a string here.
        if (getSourceFileOfNode(location) !== getSourceFileOfNode(declaration))
          result.flags = EvaluatedFlags.ResolvedOtherFiles;
        return result;
      }
      return none();
    }
    case SyntaxKind.ElementAccessExpression: {
      const root = getExpression(expr)!;
      const argument = (expr as ElementAccessExpression).argumentExpression;
      if (argument.kind !== SyntaxKind.StringLiteral && argument.kind !== SyntaxKind.NoSubstitutionTemplateLiteral)
        return none();
      const rootSymbol = resolveEntityName(c, root, SymbolFlags.Value, true, false, undefined);
      if (rootSymbol === undefined || (rootSymbol.flags & SymbolFlags.Enum) === 0) return none();
      const member = rootSymbol.exports?.get(getText(argument));
      return member !== undefined ? evaluateEnumMemberReference(c, expr, member.valueDeclaration, location) : none();
    }
  }
  return none();
}

function evaluateEnumMemberReference(
  c: Checker,
  expr: Node,
  declaration: Node | undefined,
  location: Node,
): EvaluatorResult {
  if (declaration === undefined || declaration === location) {
    const name = declaration !== undefined ? getName(declaration) : undefined;
    c.error(
      expr,
      Diagnostics.Property_0_is_used_before_being_assigned,
      name !== undefined ? declarationNameToString(getSourceFileOfNode(name), name) : '',
    );
    return none();
  }
  // Referenced members must be declared earlier, in this enum or another.
  if (!isBlockScopedNameDeclaredBeforeUse(c, declaration, location)) {
    c.error(
      expr,
      Diagnostics.A_member_initializer_in_a_enum_declaration_cannot_reference_members_declared_after_it_including_members_defined_in_other_enums,
    );
    return EvaluatorResult.number(0);
  }
  computeEnumMemberValues(c, declaration.parent!);
  const links = c.nodeLinks(declaration);
  if (links.enumValueKind === EvaluatedKind.Number)
    return withFlags(EvaluatorResult.number(links.enumNumberValue), links.enumValueFlags);
  if (links.enumValueKind === EvaluatedKind.String)
    return withFlags(EvaluatorResult.string(links.enumStringValue), links.enumValueFlags);
  return none();
}

function valueText(v: EvaluatorResult): string {
  return v.kind === EvaluatedKind.Number ? String(v.numberValue) : v.stringValue;
}
