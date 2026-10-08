// Constant evaluation of enum member initializers.
import {
  type Node,
  getExpression,
  getText,
  getSymbol,
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
import { symbolToString } from './type-printer.js';

export const enum EvaluatedKind {
  None = 0,
  Number = 1,
  String = 2,
}

export class EvaluatorResult {
  kind: EvaluatedKind = EvaluatedKind.None;
  numberValue = 0;
  stringValue = '';

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

/** The constant value of an enum member initializer, if it has one. */
export function evaluateEnumMember(c: Checker, expr: Node, member: Node): EvaluatorResult {
  return evaluate(c, expr, member);
}

function evaluate(c: Checker, expr: Node, location: Node): EvaluatorResult {
  switch (expr.kind) {
    case SyntaxKind.PrefixUnaryExpression: {
      const operand = evaluate(c, (expr as PrefixUnaryExpression).operand, location);
      if (operand.kind !== EvaluatedKind.Number) return none();
      const v = operand.numberValue;
      switch ((expr as PrefixUnaryExpression).operator) {
        case SyntaxKind.PlusToken:
          return EvaluatorResult.number(v);
        case SyntaxKind.MinusToken:
          return EvaluatorResult.number(-v);
        case SyntaxKind.TildeToken:
          return EvaluatorResult.number(~v);
      }
      return none();
    }
    case SyntaxKind.BinaryExpression: {
      const shape = expr as BinaryExpression;
      const left = evaluate(c, shape.left, location);
      const right = evaluate(c, shape.right, location);
      const op = shape.operatorToken.kind;
      if (left.kind === EvaluatedKind.Number && right.kind === EvaluatedKind.Number) {
        const l = left.numberValue;
        const r = right.numberValue;
        switch (op) {
          case SyntaxKind.BarToken:
            return EvaluatorResult.number(l | r);
          case SyntaxKind.AmpersandToken:
            return EvaluatorResult.number(l & r);
          case SyntaxKind.GreaterThanGreaterThanToken:
            return EvaluatorResult.number(l >> r);
          case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
            return EvaluatorResult.number(l >>> r);
          case SyntaxKind.LessThanLessThanToken:
            return EvaluatorResult.number(l << r);
          case SyntaxKind.CaretToken:
            return EvaluatorResult.number(l ^ r);
          case SyntaxKind.AsteriskToken:
            return EvaluatorResult.number(l * r);
          case SyntaxKind.SlashToken:
            return EvaluatorResult.number(l / r);
          case SyntaxKind.PlusToken:
            return EvaluatorResult.number(l + r);
          case SyntaxKind.MinusToken:
            return EvaluatorResult.number(l - r);
          case SyntaxKind.PercentToken:
            return EvaluatorResult.number(l % r);
          case SyntaxKind.AsteriskAsteriskToken:
            return EvaluatorResult.number(l ** r);
        }
        return none();
      }
      if (
        op === SyntaxKind.PlusToken &&
        left.kind !== EvaluatedKind.None &&
        right.kind !== EvaluatedKind.None &&
        (left.kind === EvaluatedKind.String || right.kind === EvaluatedKind.String)
      )
        return EvaluatorResult.string(valueText(left) + valueText(right));
      return none();
    }
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return EvaluatorResult.string(getText(expr));
    case SyntaxKind.TemplateExpression: {
      const shape = expr as TemplateExpression;
      let text = getText(shape.head);
      for (const span of shape.templateSpans.nodes) {
        const s = span as TemplateSpan;
        const value = evaluate(c, s.expression, location);
        if (value.kind === EvaluatedKind.None) return none();
        text += valueText(value) + getText(s.literal);
      }
      return EvaluatorResult.string(text);
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
    c.error(
      expr,
      Diagnostics.Property_0_is_used_before_being_assigned,
      declaration !== undefined && getSymbol(declaration) !== undefined
        ? symbolToString(c, getSymbol(declaration)!)
        : '',
    );
    return none();
  }
  // Members of the same enum must be declared earlier.
  if (declaration.parent === location.parent && declaration.pos > location.pos) {
    c.error(expr, Diagnostics.Property_0_is_used_before_being_assigned, symbolToString(c, getSymbol(declaration)!));
    return none();
  }
  computeEnumMemberValues(c, declaration.parent!);
  const links = c.nodeLinks(declaration);
  if (links.enumValueKind === EvaluatedKind.Number) return EvaluatorResult.number(links.enumNumberValue);
  if (links.enumValueKind === EvaluatedKind.String) return EvaluatorResult.string(links.enumStringValue);
  return none();
}

function valueText(v: EvaluatorResult): string {
  return v.kind === EvaluatedKind.Number ? String(v.numberValue) : v.stringValue;
}
