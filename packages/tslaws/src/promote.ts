// `tslaws promote`: the pure core. A person moves proposed laws into the accepted file; the lock is not touched here.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative } from 'node:path';
import ts from 'typescript';
import { ignoredDirs, namesLawsFile } from './lawFiles.ts';
import { directProjectImports } from './lawKinds.ts';
import { acceptedLawName, isProposedLawFile } from './lawNames.ts';
import { existingProposal, importsForTarget, ProposalError } from './proposals.ts';

export interface ParsedLaw {
  name: string;
  /** The declaration as written, from `export` to its end. */
  text: string;
  start: number;
  end: number;
}

/** A top-level statement that is neither an import nor a law (a helper const, function, type, interface, class, enum or namespace). */
export interface ParsedDeclaration {
  /** The names the statement declares: one for most, several for `const a = 1, b = 2` or a destructuring. */
  names: string[];
  /** The statement as written, with the comments directly above it (a JSDoc block, `//` lines) and no blank line between. */
  text: string;
  start: number;
  end: number;
  /** Every identifier the statement mentions, apart from property names after a `.`. A superset of what it really references. */
  references: string[];
}

export interface ParsedLawFile {
  /** Whole import statements, in order. */
  imports: string[];
  laws: ParsedLaw[];
  /** Where the last import statement ends, or 0 when there is none. */
  importEnd: number;
  /** The named top-level statements that are not imports or laws, in source order. */
  declarations: ParsedDeclaration[];
  /** The text with the imports and laws overwritten by spaces (line breaks kept): what is left to the helpers and anything else. */
  rest: string;
}

/**
 * `foo.proposed.laws.ts` -> `foo.laws.ts`, `foo.browser.proposed.laws.ts` -> `foo.browser.laws.ts` and
 * `foo.e2e.proposed.laws.ts` -> `foo.e2e.laws.ts`, so a proposal lands in a file of its own kind; undefined for any other name.
 */
export function acceptedPathFor(proposed: string): string | undefined {
  return isProposedLawFile(proposed) ? acceptedLawName(proposed) : undefined;
}

/**
 * Finds the import statements and the laws of a laws file, as `export law ...` declarations or as `law('name', ...)` calls. The keyword is not standard TypeScript, so
 * this scans tokens with the TypeScript scanner (strings, comments and templates are skipped correctly) and matches
 * brackets: a law ends at its closing `}` or at a `;` at depth 0.
 */
export function parseLawFile(text: string): ParsedLawFile {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const imports: string[] = [];
  const importRanges: { start: number; end: number }[] = [];
  const laws: ParsedLaw[] = [];
  const templates: number[] = []; // depth at which each open template substitution started
  let depth = 0;
  let statement: { kind: 'import' | 'law'; start: number; name: string; sawString: boolean } | undefined;
  let arrow = false;
  const finish = (end: number): void => {
    if (statement === undefined) return;
    if (statement.kind === 'import') {
      imports.push(text.slice(statement.start, end));
      importRanges.push({ start: statement.start, end });
    } else laws.push({ name: statement.name, text: text.slice(statement.start, end), start: statement.start, end });
    statement = undefined;
    arrow = false;
  };
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    const tokenStart = scanner.getTokenStart();
    if (kind === ts.SyntaxKind.CloseBraceToken && templates.length > 0 && templates[templates.length - 1] === depth) {
      templates.pop();
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateMiddle) templates.push(depth);
    } else if (kind === ts.SyntaxKind.TemplateHead) {
      templates.push(depth);
    } else if (depth === 0 && statement === undefined) {
      if (kind === ts.SyntaxKind.ImportKeyword) {
        // `import(...)` and `import.meta` are expressions inside some other statement, not an import statement.
        const after = scanner.getTokenEnd();
        const peek = ts.createScanner(
          ts.ScriptTarget.Latest,
          true,
          ts.LanguageVariant.Standard,
          text,
          undefined,
          after,
          text.length - after,
        );
        const next = peek.scan();
        if (next !== ts.SyntaxKind.OpenParenToken && next !== ts.SyntaxKind.DotToken)
          statement = { kind: 'import', start: tokenStart, name: '', sawString: false };
      } else if (kind === ts.SyntaxKind.ExportKeyword) {
        const rest = scanner.getTokenEnd();
        const next = ts.createScanner(
          ts.ScriptTarget.Latest,
          true,
          ts.LanguageVariant.Standard,
          text,
          undefined,
          rest,
          text.length - rest,
        );
        const word = next.scan();
        if (word === ts.SyntaxKind.Identifier && next.getTokenValue() === 'law') {
          let n = next.scan();
          if (n === ts.SyntaxKind.Identifier && next.getTokenValue() === 'proved') n = next.scan();
          if (n === ts.SyntaxKind.Identifier || n > ts.SyntaxKind.LastReservedWord)
            statement = { kind: 'law', start: tokenStart, name: next.getTokenValue(), sawString: false };
        }
      }
    }
    if (
      kind === ts.SyntaxKind.OpenBraceToken ||
      kind === ts.SyntaxKind.OpenParenToken ||
      kind === ts.SyntaxKind.OpenBracketToken
    ) {
      depth += 1;
    } else if (
      kind === ts.SyntaxKind.CloseBraceToken ||
      kind === ts.SyntaxKind.CloseParenToken ||
      kind === ts.SyntaxKind.CloseBracketToken
    ) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && kind === ts.SyntaxKind.CloseBraceToken && statement?.kind === 'law') {
        // A block-bodied law ends here; the arrow form ends at its `;`.
        if (!arrow) {
          let end = scanner.getTokenEnd();
          const peek = ts.createScanner(
            ts.ScriptTarget.Latest,
            true,
            ts.LanguageVariant.Standard,
            text,
            undefined,
            end,
            text.length - end,
          );
          if (peek.scan() === ts.SyntaxKind.SemicolonToken) end = peek.getTokenEnd();
          finish(end);
          if (end > scanner.getTokenEnd()) scanner.resetTokenState(end);
          kind = scanner.scan();
          continue;
        }
      }
    } else if (depth === 0 && kind === ts.SyntaxKind.EqualsGreaterThanToken && statement?.kind === 'law') {
      arrow = true;
    } else if (depth === 0 && kind === ts.SyntaxKind.SemicolonToken) {
      finish(scanner.getTokenEnd());
    } else if (depth === 0 && statement?.kind === 'import' && kind === ts.SyntaxKind.StringLiteral) {
      statement.sawString = true;
      const end = scanner.getTokenEnd();
      const peek = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.Standard,
        text,
        undefined,
        end,
        text.length - end,
      );
      const after = peek.scan();
      const attributes =
        after === ts.SyntaxKind.WithKeyword ||
        (after === ts.SyntaxKind.Identifier && peek.getTokenValue() === 'assert');
      if (!attributes) {
        const stop = after === ts.SyntaxKind.SemicolonToken ? peek.getTokenEnd() : end;
        finish(stop);
        if (stop > end) scanner.resetTokenState(stop);
      }
    }
    kind = scanner.scan();
  }
  finish(text.length);
  for (const call of callLaws(text))
    if (!laws.some((l) => call.start >= l.start && call.start < l.end)) laws.push(call);
  laws.sort((a, b) => a.start - b.start);
  return {
    imports,
    laws,
    importEnd: importRanges[importRanges.length - 1]?.end ?? 0,
    declarations: declarationsOf(text, [...importRanges, ...laws]),
    rest: blank(text, [...importRanges, ...laws]),
  };
}

/** `text` with the given ranges overwritten by spaces (line breaks kept), so positions stay the same. */
function blank(text: string, ranges: { start: number; end: number }[]): string {
  let out = text;
  for (const { start, end } of ranges)
    out = out.slice(0, start) + out.slice(start, end).replace(/[^\r\n]/g, ' ') + out.slice(end);
  return out;
}

/** The names a statement declares; empty for statements that declare none (expressions, `export { x }`, `export default`). */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    const names: string[] = [];
    const walk = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) names.push(name.text);
      else for (const element of name.elements) if (!ts.isOmittedExpression(element)) walk(element.name);
    };
    for (const declaration of statement.declarationList.declarations) walk(declaration.name);
    return names;
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  )
    return statement.name !== undefined && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
  return [];
}

/** Where the comments directly above a statement start: only a run with no blank line between its comments and the statement. */
function commentStart(text: string, statement: ts.Statement, source: ts.SourceFile): number {
  const start = statement.getStart(source);
  const ranges = ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? [];
  let from = start;
  for (const range of [...ranges].reverse()) {
    if ((text.slice(range.end, from).match(/\n/g) ?? []).length > 1) break;
    from = range.pos;
  }
  return from;
}

/** The identifiers in `text`, found with the scanner so it also reads a law (`export law ...`, which is not standard TypeScript). */
export function identifiersIn(text: string): Set<string> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const found = new Set<string>();
  const templates: number[] = [];
  let depth = 0;
  let previous = ts.SyntaxKind.Unknown;
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (kind === ts.SyntaxKind.CloseBraceToken && templates.length > 0 && templates[templates.length - 1] === depth) {
      templates.pop();
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateMiddle) templates.push(depth);
    } else if (kind === ts.SyntaxKind.TemplateHead) {
      templates.push(depth);
    } else if (kind === ts.SyntaxKind.OpenBraceToken) {
      depth += 1;
    } else if (kind === ts.SyntaxKind.CloseBraceToken) {
      depth = Math.max(0, depth - 1);
    } else if (
      (kind === ts.SyntaxKind.Identifier || kind > ts.SyntaxKind.LastReservedWord) &&
      previous !== ts.SyntaxKind.DotToken &&
      previous !== ts.SyntaxKind.QuestionDotToken
    ) {
      found.add(scanner.getTokenValue());
    }
    previous = kind;
    kind = scanner.scan();
  }
  return found;
}

/** The named statements left once imports and laws are blanked out, each with the comments directly above it. */
function declarationsOf(text: string, taken: { start: number; end: number }[]): ParsedDeclaration[] {
  const rest = blank(text, taken);
  const source = ts.createSourceFile('laws.ts', rest, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: ParsedDeclaration[] = [];
  for (const statement of source.statements) {
    const names = declaredNames(statement);
    if (names.length === 0) continue;
    const start = commentStart(rest, statement, source);
    const written = text.slice(start, statement.end);
    found.push({ names, text: written, start, end: statement.end, references: [...identifiersIn(written)] });
  }
  return found;
}

/** The call-style laws: top-level `law('name', ...)` and `law.proved('name', ...)` statements, found in the syntax tree. */
function callLaws(text: string): ParsedLaw[] {
  const source = ts.createSourceFile('laws.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: ParsedLaw[] = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const { expression: callee, arguments: args } = statement.expression;
    const isLaw =
      (ts.isIdentifier(callee) && callee.text === 'law') ||
      (ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'law' &&
        callee.name.text === 'proved');
    const name = args[0];
    if (!isLaw || name === undefined || !(ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)))
      continue;
    found.push({
      name: name.text,
      text: text.slice(statement.getStart(source), statement.end),
      start: statement.getStart(source),
      end: statement.end,
    });
  }
  return found;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The code of `text` printed from its syntax tree without comments: layout is normalised, string and template contents are not. */
export function sameCode(a: string, b: string): boolean {
  const printer = ts.createPrinter({ removeComments: true });
  const print = (text: string): string => {
    const source = ts.createSourceFile('helper.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    return source.statements
      .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, source))
      .join('\n');
  };
  return print(a) === print(b);
}

/** The local names the import statements bind (`import a, { b as c, type d } from 'x'` binds a, c and d). */
function importedNames(imports: string[]): Set<string> {
  const names = new Set<string>();
  const source = ts.createSourceFile('imports.ts', imports.join('\n'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement)) names.add(statement.name.text);
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const { name, namedBindings } = statement.importClause;
    if (name !== undefined) names.add(name.text);
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) names.add(namedBindings.name.text);
    else for (const element of namedBindings.elements) names.add(element.name.text);
  }
  return names;
}

const isAssignmentOperator = (kind: ts.SyntaxKind): boolean =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/** Whether `node` is a BigInt: mixing one with a number, dividing by zero or a unary plus throws, so a BigInt is only allowed bare or negated. */
function isBigInt(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return isBigInt(node.expression);
  if (ts.isPrefixUnaryExpression(node)) return isBigInt(node.operand);
  return ts.isBigIntLiteral(node);
}

/** Whether `node` is a constant that cannot throw: literals joined by operators that read no property, call nothing and cannot fail on their operands. */
function isLiteralValue(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return isLiteralValue(node.expression);
  if (ts.isPrefixUnaryExpression(node))
    return (
      node.operator !== ts.SyntaxKind.PlusPlusToken &&
      node.operator !== ts.SyntaxKind.MinusMinusToken &&
      !(node.operator === ts.SyntaxKind.PlusToken && isBigInt(node.operand)) &&
      isLiteralValue(node.operand)
    );
  if (ts.isBinaryExpression(node))
    return (
      !isAssignmentOperator(node.operatorToken.kind) &&
      node.operatorToken.kind !== ts.SyntaxKind.CommaToken &&
      // `in` and `instanceof` throw on a primitive right-hand side.
      node.operatorToken.kind !== ts.SyntaxKind.InKeyword &&
      node.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword &&
      !isBigInt(node.left) &&
      !isBigInt(node.right) &&
      isLiteralValue(node.left) &&
      isLiteralValue(node.right)
    );
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/** A `const` statement: not `let`, `var`, `using` or `await using` (the last two carry the Const flag too and call a dispose method). */
export function isPlainConst(statement: ts.VariableStatement): boolean {
  return (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
}

/** Why `expression` may not run when a file loads (it can have a side effect), or undefined when it may. */
function initialiserProblem(expression: ts.Expression, source: ts.SourceFile): string | undefined {
  const bad = (what: string, node: ts.Node): string =>
    `${what} \`${node.getText(source).replace(/\s+/g, ' ').slice(0, 40)}\``;
  const visit = (node: ts.Expression): string | undefined => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node)
    )
      return visit(node.expression);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isIdentifier(node) || isLiteralValue(node))
      return undefined;
    if (ts.isTemplateExpression(node)) {
      const span = node.templateSpans.find((s) => !isLiteralValue(s.expression));
      return span === undefined ? undefined : bad('a substitution', span.expression);
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) return bad('a spread', element);
        const problem = visit(element);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) continue;
        if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property))
          return bad(ts.isSpreadAssignment(property) ? 'a spread' : 'an accessor', property);
        // A computed key is evaluated when the object is built, methods included; `[Symbol.dispose]` is the hook `using` calls.
        if (ts.isComputedPropertyName(property.name) && !isLiteralValue(property.name.expression))
          return bad(
            /^Symbol\s*\.\s*(?:async)?dispose$/i.test(property.name.expression.getText(source))
              ? 'a dispose method'
              : 'a computed key',
            property.name,
          );
        if (ts.isMethodDeclaration(property)) continue;
        const problem = visit(property.initializer);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    if (ts.isCallExpression(node))
      return bad(node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'an import()' : 'a call', node);
    if (ts.isNewExpression(node)) return bad('a new expression', node);
    if (ts.isTaggedTemplateExpression(node)) return bad('a tagged template', node);
    if (ts.isAwaitExpression(node)) return bad('an await', node);
    if (ts.isDeleteExpression(node)) return bad('a delete', node);
    if (
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))
    )
      return bad('an update', node);
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) return bad('an assignment', node);
    return bad('an expression that may run code', node);
  };
  return visit(expression);
}

/**
 * Why a helper may not be proposed or copied, or undefined when it may. A helper is a function, type or interface
 * declaration, or a `const` whose initialiser has no side effects (a literal, a function, an object or array of those,
 * `as const`): a helper becomes part of the accepted tree, and a `const` initialiser runs when the file loads.
 */
export function helperProblem(text: string): string | undefined {
  const source = ts.createSourceFile('helper.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (ts.isEmptyStatement(statement)) continue;
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    )
      continue;
    if (ts.isVariableStatement(statement) && isPlainConst(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name))
          return `a destructuring \`${declaration.name.getText(source).slice(0, 40)}\` reads properties, which can run code`;
        if (declaration.initializer === undefined) continue;
        const problem = initialiserProblem(declaration.initializer, source);
        if (problem !== undefined)
          return `const '${declaration.name.text}' is initialised with ${problem}, which would run when the file loads`;
      }
      continue;
    }
    if (ts.isClassDeclaration(statement)) return 'a class is not an allowed helper';
    if (ts.isEnumDeclaration(statement)) return 'an enum is not an allowed helper';
    if (ts.isModuleDeclaration(statement)) return 'a namespace is not an allowed helper';
    return 'only function, type, interface and const declarations are allowed helpers';
  }
  return undefined;
}

const helperRule =
  'Helpers may only be function, type and interface declarations, and const with a side-effect-free initialiser (a literal, a function, an object or array literal of those, as const)';

/** Throws unless every one of `declarations` passes `helperProblem`. */
export function assertHelpersSafe(declarations: ParsedDeclaration[]): void {
  for (const declaration of declarations) {
    const problem = helperProblem(declaration.text);
    if (problem !== undefined)
      throw new Error(`helper '${declaration.names.join(', ')}' is refused: ${problem}. ${helperRule}`);
  }
}

/** Throws unless each of `imports` is exactly one import statement, so a scanning slip cannot pass other code off as an import. */
export function assertImportStatements(imports: string[]): void {
  for (const text of imports) {
    const source = ts.createSourceFile('import.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const [only, ...more] = source.statements;
    if (only === undefined || more.length > 0 || !(ts.isImportDeclaration(only) || ts.isImportEqualsDeclaration(only)))
      throw new Error(`\`${text.replace(/\s+/g, ' ').slice(0, 40)}\` is not an import statement`);
  }
}

/** Joins the import statements, dropping repeats by whitespace-insensitive text. */
export function dedupeImports(existing: string[], added: string[]): string[] {
  const seen = new Set(existing.map(squash));
  const out = [...existing];
  for (const statement of added) {
    if (seen.has(squash(statement))) continue;
    seen.add(squash(statement));
    out.push(statement);
  }
  return out;
}

/**
 * The declarations the promoted `laws` need: every one of `declarations` whose name a law mentions, and so on for the
 * names those declarations mention, in source order. A declaration is taken with all others of the same name
 * (overloads, merged interfaces). One that no promoted law reaches stays behind.
 */
function neededDeclarations(laws: ParsedLaw[], declarations: ParsedDeclaration[]): ParsedDeclaration[] {
  const byName = new Map<string, ParsedDeclaration[]>();
  for (const declaration of declarations)
    for (const name of declaration.names) byName.set(name, [...(byName.get(name) ?? []), declaration]);
  const needed = new Set<ParsedDeclaration>();
  const queue = laws.flatMap((l) => [...identifiersIn(l.text)]);
  for (let name = queue.pop(); name !== undefined; name = queue.pop())
    for (const declaration of byName.get(name) ?? []) {
      if (needed.has(declaration)) continue;
      needed.add(declaration);
      queue.push(...declaration.references);
    }
  return declarations.filter((d) => needed.has(d));
}

/**
 * The accepted file after promoting `laws` (with the proposed file's imports) into it. `existing` is the current text
 * of the accepted file, or undefined when it does not exist yet. `declarations` are all the helper declarations of the
 * proposed file: the ones the laws use, directly or through each other, are copied too. A declaration already in the
 * accepted file with the same code (layout and comments aside) is not copied again; one of the same name with different text is
 * an error. Throws when a law name is already taken there, and, as a safety net, when the result would use a name the
 * proposed file declares but the accepted file does not.
 */
export function buildAccepted(
  existing: string | undefined,
  imports: string[],
  laws: ParsedLaw[],
  declarations: ParsedDeclaration[] = [],
): string {
  return planAccepted(existing, imports, laws, declarations).text;
}

/** What a promote would write, with the code it adds beside the laws. */
export interface AcceptedPlan {
  text: string;
  /** The import statements the accepted file does not have yet. */
  imports: string[];
  /** The helper declarations copied into the accepted file. */
  declarations: ParsedDeclaration[];
}

/** `buildAccepted`, with the imports and helpers it adds, so a person can read them before anything is written. */
export function planAccepted(
  existing: string | undefined,
  imports: string[],
  laws: ParsedLaw[],
  declarations: ParsedDeclaration[] = [],
): AcceptedPlan {
  const base = existing ?? '';
  const parsed = parseLawFile(base);
  const taken = new Set(parsed.laws.map((l) => l.name));
  for (const law of laws)
    if (taken.has(law.name)) throw new Error(`law '${law.name}' already exists in the accepted file`);
  const missing = dedupeImports(parsed.imports, imports).slice(parsed.imports.length);
  assertImportStatements(missing);
  let text = base;
  if (missing.length > 0) {
    // New imports go after the last existing import, or at the top.
    const lastEnd =
      parsed.imports.length > 0
        ? base.indexOf(parsed.imports[parsed.imports.length - 1]!) + parsed.imports[parsed.imports.length - 1]!.length
        : 0;
    const block = missing.map((m) => (m.endsWith(';') ? m : `${m};`)).join('\n');
    text =
      lastEnd === 0
        ? `${block}\n${base === '' ? '' : `${base.startsWith('\n') ? '' : '\n'}`}${base}`
        : `${base.slice(0, lastEnd)}\n${block}${base.slice(lastEnd)}`;
  }
  const copied = copiedDeclarations(text, laws, declarations);
  assertHelpersSafe(copied);
  if (copied.length > 0) text = withDeclarations(text, copied.map((d) => d.text.trim()).join('\n\n'));
  const body = laws.map((l) => l.text.trimEnd()).join('\n\n');
  const trimmed = text.trimEnd();
  const result = `${trimmed === '' ? '' : `${trimmed}\n\n`}${body}\n`;
  assertNothingLost(result, laws, copied, declarations);
  return { text: result, imports: missing, declarations: copied };
}

/** The needed declarations that `accepted` does not have yet; throws when it has a different one under the same name. */
function copiedDeclarations(
  accepted: string,
  laws: ParsedLaw[],
  declarations: ParsedDeclaration[],
): ParsedDeclaration[] {
  const { declarations: have, imports } = parseLawFile(accepted);
  const imported = importedNames(imports);
  return neededDeclarations(laws, declarations).filter((declaration) => {
    const bound = declaration.names.find((n) => imported.has(n));
    if (bound !== undefined)
      throw new Error(
        `'${bound}' is imported in the accepted file but declared as a helper in the proposed file; rename one`,
      );
    const same = have.filter((h) => h.names.some((n) => declaration.names.includes(n)));
    if (same.length === 0) return true;
    if (same.some((h) => sameCode(h.text, declaration.text))) return false;
    throw new Error(
      `'${declaration.names.find((n) => same.some((h) => h.names.includes(n)))}' is declared differently in the accepted file; make the two the same or rename one`,
    );
  });
}

/** `block` placed after the last declaration of `text`, else after its last import, else before its first law, else at the end. */
export function withDeclarations(text: string, block: string): string {
  const parsed = parseLawFile(text);
  const lastDeclaration = parsed.declarations[parsed.declarations.length - 1];
  const at = lastDeclaration?.end ?? (parsed.importEnd > 0 ? parsed.importEnd : (parsed.laws[0]?.start ?? text.length));
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at).trimStart();
  return `${before === '' ? '' : `${before}\n\n`}${block}${after === '' ? '' : `\n\n${after}`}`;
}

/** Throws when the result mentions a name the proposed file declares and the result does not declare or import. */
function assertNothingLost(
  result: string,
  laws: ParsedLaw[],
  copied: ParsedDeclaration[],
  declarations: ParsedDeclaration[],
): void {
  const proposed = new Set(declarations.flatMap((d) => d.names));
  const present = new Set(parseLawFile(result).declarations.flatMap((d) => d.names));
  for (const part of [...laws, ...copied])
    for (const name of identifiersIn(part.text))
      if (proposed.has(name) && !present.has(name))
        throw new Error(`'${name}' is declared in the proposed file but would be missing from the accepted file`);
}

/** The proposed file without the promoted laws, or undefined when no law is left (the file is deleted). */
export function buildRemaining(text: string, promoted: string[]): string | undefined {
  const parsed = parseLawFile(text);
  const drop = new Set(promoted);
  if (parsed.laws.every((l) => drop.has(l.name))) return undefined;
  let out = text;
  for (const law of [...parsed.laws].reverse()) {
    if (!drop.has(law.name)) continue;
    let end = law.end;
    while (out[end] === '\r' || out[end] === '\n') end += 1;
    out = out.slice(0, law.start) + out.slice(end);
  }
  return out;
}

export interface PromoteHost {
  cwd: string;
  /** Checks one proposed file and returns its results by law name (as `check --proposed` would). */
  checkFile: (file: string) => Promise<Map<string, string>>;
  ask: (question: string) => Promise<string>;
  out: (text: string) => void;
  /** Add the imports and helpers without asking (`--yes`); they are still printed. */
  yes?: boolean;
}

/**
 * Prints the imports and helper declarations a promote adds, in full, before anything is written. When helpers are
 * copied it asks the person to confirm (the imports are shown too; like a law's imports they are only listed); `yes`
 * skips the question. Returns whether to go on; true when no helper is copied.
 */
async function confirmAdditions(
  host: { ask: (question: string) => Promise<string>; out: (text: string) => void; yes?: boolean },
  target: string,
  plan: AcceptedPlan,
): Promise<boolean> {
  if (plan.imports.length === 0 && plan.declarations.length === 0) return true;
  let shown = `\nThis also adds code to ${target}, which becomes part of the trusted tree:\n`;
  if (plan.imports.length > 0)
    shown += `\nimports (${plan.imports.length}):\n${plan.imports.map((i) => i.trim()).join('\n')}\n`;
  if (plan.declarations.length > 0)
    shown += `\nhelpers (${plan.declarations.length}):\n${plan.declarations.map((d) => d.text.trim()).join('\n\n')}\n`;
  host.out(shown);
  if (plan.declarations.length === 0) return true;
  if (host.yes === true) {
    host.out('adding it (--yes)\n');
    return true;
  }
  return (await host.ask(`add this helper code to ${target}? [y/N] `)).trim().toLowerCase() === 'y';
}

/** Walks the proposed files, asks per law, and rewrites the accepted and proposed files. Returns the number promoted. */
export async function promoteFiles(host: PromoteHost, proposedFiles: string[]): Promise<number> {
  let promoted = 0;
  for (const file of proposedFiles) {
    const accepted = acceptedPathFor(file);
    if (accepted === undefined) {
      host.out(`${file}: not a *.proposed.laws.ts file, skipped\n`);
      continue;
    }
    const proposedPath = join(host.cwd, file);
    const acceptedPath = join(host.cwd, accepted);
    const text = readFileSync(proposedPath, 'utf8');
    const parsed = parseLawFile(text);
    if (parsed.laws.length === 0) {
      host.out(`${file}: no laws\n`);
      continue;
    }
    const results = await host.checkFile(file);
    const chosen: ParsedLaw[] = [];
    for (const law of parsed.laws) {
      host.out(`\n${file}: ${law.name}  [${results.get(law.name) ?? 'not checked'}]\n${law.text.trim()}\n`);
      if ((await host.ask(`promote ${law.name}? [y/N] `)).trim().toLowerCase() === 'y') chosen.push(law);
    }
    if (chosen.length === 0) continue;
    const existing = existsSync(acceptedPath) ? readFileSync(acceptedPath, 'utf8') : undefined;
    let plan: AcceptedPlan;
    try {
      plan = planAccepted(existing, parsed.imports, chosen, parsed.declarations);
    } catch (error) {
      host.out(
        `${accepted}: ${error instanceof Error ? error.message : String(error)}; nothing promoted from ${file}\n`,
      );
      continue;
    }
    if (!(await confirmAdditions(host, accepted, plan))) {
      host.out(`nothing promoted from ${file}\n`);
      continue;
    }
    writeFileSync(acceptedPath, plan.text);
    const remaining = buildRemaining(
      text,
      chosen.map((l) => l.name),
    );
    if (remaining === undefined) rmSync(proposedPath);
    else writeFileSync(proposedPath, remaining);
    promoted += chosen.length;
    host.out(
      `${chosen.length} law${chosen.length === 1 ? '' : 's'} moved to ${accepted}${remaining === undefined ? `; ${file} removed` : ''}\n`,
    );
  }
  if (promoted > 0)
    host.out('\nThe lock is unchanged. Review the diff, then run `tslaws accept` to record these laws.\n');
  return promoted;
}

/** The path `promote` suggests for a proposal: beside the source it imports, else under `laws/`. */
export function defaultTarget(cwd: string, proposal: string): string {
  const name = posix
    .basename(proposal)
    .replace(/\.(?:ts|mts|cts)$/, '')
    .replace(/\.laws$/, '');
  const source = directProjectImports(cwd, proposal).find((file) => !file.startsWith('.tslaws/'));
  const dir = source === undefined ? 'laws' : posix.dirname(source);
  return `${dir === '.' ? '' : `${dir}/`}${name}.laws.ts`;
}

/**
 * A path a promoted proposal may be written to, as a project-relative slash path: inside the project, a name laws
 * files have (`*.laws.ts`, or a path a `laws` glob picks), not in a reserved directory, and not through a link.
 */
export function promotionTarget(cwd: string, to: string): string {
  if (isAbsolute(to)) throw new ProposalError(`'${to}' must be relative to the project root`);
  const rel = posix.normalize(to.replaceAll('\\', '/'));
  if (rel.startsWith('..') || rel === '.' || rel.startsWith('/'))
    throw new ProposalError(`'${to}' is outside the project`);
  if (rel.split('/').some((part) => ignoredDirs.has(part)))
    throw new ProposalError(`'${to}' is in a reserved directory (node_modules, .tslaws or .git)`);
  if (!namesLawsFile(cwd, rel))
    throw new ProposalError(
      `'${to}' would not be found as a laws file: name it *.laws.ts, or list a glob for it in "laws" in tslaws.json`,
    );
  const abs = join(cwd, rel);
  let probe = dirname(abs);
  while (!existsSync(probe)) probe = dirname(probe);
  const back = relative(realpathSync(cwd), realpathSync(probe));
  if (back.startsWith('..') || isAbsolute(back)) throw new ProposalError(`'${to}' is outside the project`);
  try {
    if (lstatSync(abs).isSymbolicLink()) throw new ProposalError(`'${to}' is a link`);
  } catch (error) {
    if (error instanceof ProposalError) throw error;
  }
  return rel;
}

export interface PromoteProposalHost {
  cwd: string;
  /** Checks one proposal and returns its results by law name (as `check --proposed` would). */
  checkFile: (file: string) => Promise<Map<string, string>>;
  ask: (question: string) => Promise<string>;
  out: (text: string) => void;
  /** Add the imports and helpers without asking (`--yes`); they are still printed. */
  yes?: boolean;
}

export interface PromoteProposalResult {
  /** Project-relative path the laws went to; undefined when the person declined or nothing was moved. */
  target?: string;
}

const plural = (n: number): string => `${n} law${n === 1 ? '' : 's'}`;

/**
 * Moves one proposal into the tree. Shows each law with its result, asks the person to confirm the target path (the
 * default, or `to` when given, or another typed path), rewrites the proposal's relative imports for the new directory,
 * merges into the target if it already exists, and removes the proposal. The lock is never written: the laws stay
 * unaccepted, and `check` fails them as not in the lock until a person runs `tslaws accept`.
 */
export async function promoteProposal(
  host: PromoteProposalHost,
  file: string,
  to?: string,
): Promise<PromoteProposalResult> {
  const { rel, abs } = existingProposal(host.cwd, file);
  const text = readFileSync(abs, 'utf8');
  const parsed = parseLawFile(text);
  if (parsed.laws.length === 0) {
    host.out(`${rel}: no laws\n`);
    return {};
  }
  const results = await host.checkFile(rel);
  for (const law of parsed.laws)
    host.out(`\n${rel}: ${law.name}  [${results.get(law.name) ?? 'not checked'}]\n${law.text.trim()}\n`);
  const suggested = to ?? defaultTarget(host.cwd, rel);
  const answer = (
    await host.ask(
      `\nmove ${plural(parsed.laws.length)} to ${suggested}?\nEnter accepts that path, another path replaces it, n cancels: `,
    )
  ).trim();
  if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
    host.out('nothing moved\n');
    return {};
  }
  let target: string;
  try {
    target = promotionTarget(host.cwd, answer === '' || answer.toLowerCase() === 'y' ? suggested : answer);
  } catch (error) {
    host.out(`${error instanceof Error ? error.message : String(error)}; nothing moved\n`);
    return {};
  }
  const targetPath = join(host.cwd, target);
  const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : undefined;
  const toDir = posix.dirname(target);
  const moved = parseLawFile(importsForTarget(text, toDir === '.' ? '' : toDir));
  let plan: AcceptedPlan;
  try {
    plan = planAccepted(existing, moved.imports, moved.laws, moved.declarations);
  } catch (error) {
    host.out(`${target}: ${error instanceof Error ? error.message : String(error)}; nothing moved\n`);
    return {};
  }
  if (!(await confirmAdditions(host, target, plan))) {
    host.out('nothing moved\n');
    return {};
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, plan.text);
  rmSync(abs);
  host.out(
    `${plural(parsed.laws.length)} moved to ${target}; ${rel} removed\n` +
      'The lock is unchanged: until a person runs `tslaws accept`, `tslaws check` fails these laws as not in the lock.\n',
  );
  return { target };
}
