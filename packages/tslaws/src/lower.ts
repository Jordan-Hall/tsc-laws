// Laws as calls: `law('name', (x: int) => ...)` and `law.proved(...)` in a `*.laws.ts` file are ordinary TypeScript. The
// runner lowers each top-level call to the exported function the rest of tslaws already runs, proves and tests, keeping
// every line where it was so diagnostics and counterexamples point at the file the person wrote.
import ts from 'typescript';
import type { ManifestLaw } from './types.ts';

export interface Lowered {
  /** The file text with every law call replaced by an exported function. */
  text: string;
  laws: ManifestLaw[];
}

/** The pre-call syntax (`export law name(...)`), which only the tsc-laws compiler parses. */
export function usesLegacySyntax(text: string): boolean {
  return /^[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?law[ \t]+(?:proved[ \t]+)?[A-Za-z_$][\w$]*[ \t]*[(<]/m.test(text);
}

function newlines(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === '\n') count += 1;
  return count;
}

/** `law` or `law.proved` as the callee of a call; undefined when the call is something else. */
function lawCallee(call: ts.CallExpression): { proved: boolean } | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && callee.text === 'law') return { proved: false };
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'law' &&
    callee.name.text === 'proved'
  )
    return { proved: true };
  return undefined;
}

function identifierFor(name: string, taken: Set<string>): string {
  let id = name.replace(/[^\w$]/g, '_');
  if (id === '' || /^\d/.test(id)) id = `_${id}`;
  let unique = id;
  for (let n = 2; taken.has(unique); n += 1) unique = `${id}_${n}`;
  taken.add(unique);
  return unique;
}

/** Why a law's function cannot be run, or undefined when it can. */
function problemsOf(fn: ts.ArrowFunction | ts.FunctionExpression): string[] {
  const problems: string[] = [];
  if (!ts.isArrowFunction(fn) && fn.asteriskToken !== undefined)
    problems.push('a law cannot be a generator');
  for (const parameter of fn.parameters) {
    if (!ts.isIdentifier(parameter.name))
      problems.push('a law parameter must be a plain identifier');
    else if (parameter.type === undefined)
      problems.push(
        `parameter ${parameter.name.text} of a law needs a type annotation so inputs can be generated`,
      );
  }
  return problems;
}

/** Lowers the law calls of one file; `file` is the project-relative path the results carry. */
export function lowerLawFile(file: string, text: string): Lowered {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, scriptKind(file));
  const taken = new Set<string>();
  for (const statement of source.statements)
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) taken.add(statement.name.text);
    else if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) taken.add(d.name.text);

  const laws: ManifestLaw[] = [];
  const edits: { start: number; end: number; replacement: string }[] = [];
  const checks: string[] = [];
  const seen = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    const callee = lawCallee(call);
    if (callee === undefined) continue;
    const start = call.getStart(source);
    const line = source.getLineAndCharacterOfPosition(start).line + 1;
    const [nameArg, bodyArg] = call.arguments;
    const lawText = text.slice(start, call.end);
    const base = { file, exported: true, proved: callee.proved, line, text: lawText };

    if (nameArg === undefined || !(ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg))) {
      laws.push({
        ...base,
        name: `law@${line}`,
        params: [],
        body: '',
        problems: ['the name of a law must be a string literal'],
      });
      continue;
    }
    const name = nameArg.text;
    if (bodyArg === undefined || !(ts.isArrowFunction(bodyArg) || ts.isFunctionExpression(bodyArg))) {
      laws.push({ ...base, name, params: [], body: '', problems: ['a law needs a function as its second argument'] });
      continue;
    }
    const problems = problemsOf(bodyArg);
    if (seen.has(name)) problems.push(`there is already a law named "${name}" in this file`);
    seen.add(name);
    const params = bodyArg.parameters.map((p) => p.name.getText(source));
    const body = text.slice(bodyArg.body.getStart(source), bodyArg.body.end);
    const entry: ManifestLaw = { ...base, name, symbol: name, params, body, problems };
    laws.push(entry);
    if (problems.length > 0) continue;

    const id = identifierFor(name, taken);
    entry.symbol = id;
    const isAsync = bodyArg.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
    const typeParameters =
      bodyArg.typeParameters === undefined
        ? ''
        : `<${text.slice(bodyArg.typeParameters.pos, bodyArg.typeParameters.end)}>`;
    const parameterText = text.slice(bodyArg.parameters.pos, bodyArg.parameters.end);
    const returnType = bodyArg.type === undefined ? '' : `: ${text.slice(bodyArg.type.getStart(source), bodyArg.type.end)}`;
    const header = `export ${isAsync ? 'async ' : ''}function ${id}${typeParameters}(${parameterText})${returnType}`;

    const bodyStart = bodyArg.body.getStart(source);
    const dropped = newlines(text.slice(start, bodyStart)) - newlines(parameterText) - newlines(returnType);
    const pad = '\n'.repeat(Math.max(0, dropped));
    const tail = '\n'.repeat(newlines(text.slice(bodyArg.body.end, statement.end)));
    const inner = text.slice(bodyStart, bodyArg.body.end);
    const replacement = ts.isBlock(bodyArg.body)
      ? `${header} ${pad}${inner}${tail}`
      : `${header} {${pad} return ${inner};${tail} }`;
    edits.push({ start: statement.getStart(source), end: statement.end, replacement });
    checks.push(
      `type __LawResult_${id} = __LawReturns<typeof ${id}>;`,
    );
  }

  let lowered = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    lowered = lowered.slice(0, edit.start) + edit.replacement + lowered.slice(edit.end);
  if (checks.length > 0)
    lowered += `\ntype __LawReturns<F extends (...args: never[]) => boolean | void | Promise<boolean | void>> = F;${checks.join('')}`;
  return { text: lowered, laws };
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}
