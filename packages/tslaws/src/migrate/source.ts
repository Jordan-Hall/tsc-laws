// A source file with the edits made to it so far, and the means to copy parts of it into a new file: text is taken from
// the original (comments and all), edits are applied to it, and the indentation is changed without touching template strings.
import ts from 'typescript';

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export class Source {
  readonly file: ts.SourceFile;
  readonly text: string;
  private readonly edits = new Map<string, Edit>();
  private readonly lines: string[];
  private readonly protectedLines = new Set<number>();
  /** Every identifier that appears anywhere in the file, so new names can avoid them. */
  readonly taken = new Set<string>();

  readonly path: string;

  constructor(path: string, text: string) {
    this.path = path;
    this.text = text;
    this.file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, scriptKindOf(path));
    this.lines = text.split('\n');
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) this.taken.add(node.text);
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const from = this.lineOf(node.getStart(this.file)) - 1;
        const to = this.lineOf(node.end) - 1;
        for (let i = from + 1; i <= to; i += 1) this.protectedLines.add(i);
      }
      ts.forEachChild(node, visit);
    };
    visit(this.file);
  }

  /** 1-based line of a position. */
  lineOf(pos: number): number {
    return this.file.getLineAndCharacterOfPosition(pos).line + 1;
  }

  lineOfNode(node: ts.Node): number {
    return this.lineOf(node.getStart(this.file));
  }

  /** Replaces `start..end` with a single line of text; the same edit made twice counts once. */
  edit(start: number, end: number, text: string): void {
    if (text.includes('\n')) throw new Error('an edit may not add or remove lines');
    this.edits.set(`${start}:${end}`, { start, end, text });
  }

  /** The original text of `start..end` with the edits inside it applied. */
  private render(start: number, end: number): string {
    const inside = [...this.edits.values()]
      .filter((e) => e.start >= start && e.end <= end)
      .sort((a, b) => a.start - b.start);
    let out = '';
    let at = start;
    for (const e of inside) {
      if (e.start < at) continue;
      out += this.text.slice(at, e.start) + e.text;
      at = e.end;
    }
    return out + this.text.slice(at, end);
  }

  /** The text of a node, edits applied, on its own (no reindentation). */
  textOf(node: ts.Node): string {
    return this.render(node.getStart(this.file), node.end);
  }

  /** A statement's range including the comments written above it and a comment after it on the same line. */
  rangeOf(node: ts.Node): [number, number] {
    const leading = ts.getLeadingCommentRanges(this.text, node.pos) ?? [];
    const trailing = ts.getTrailingCommentRanges(this.text, node.end) ?? [];
    const start = leading[0]?.pos ?? node.getStart(this.file);
    const end = trailing.length > 0 ? trailing[trailing.length - 1]!.end : node.end;
    return [start, end];
  }

  /** The statements' text at `depth` levels of two spaces, comments included, template strings untouched. */
  statements(nodes: readonly ts.Node[], depth: number): string[] {
    return nodes.flatMap((n) => this.block(...this.rangeOf(n), depth));
  }

  /** Copies `start..end` as lines at `depth`, keeping the shape the code had. */
  block(start: number, end: number, depth: number): string[] {
    const raw = this.render(start, end).split('\n');
    const startLine = this.lineOf(start) - 1;
    let first = 0;
    while (first < raw.length && raw[first]!.trim() === '') first += 1;
    let last = raw.length;
    while (last > first && raw[last - 1]!.trim() === '') last -= 1;
    if (first >= last) return [];
    const base = /^[ \t]*/.exec(this.lines[startLine + first] ?? '')![0].length;
    const pad = '  '.repeat(depth);
    const out: string[] = [];
    for (let i = first; i < last; i += 1) {
      const line = raw[i]!;
      if (this.protectedLines.has(startLine + i)) out.push(line);
      else if (line.trim() === '') out.push('');
      else {
        const lead = /^[ \t]*/.exec(line)![0].length;
        out.push(pad + line.slice(Math.min(base, lead)));
      }
    }
    return out;
  }
}

/** Names a statement declares at its top level (variables, destructured ones, functions, classes). */
export function declaredNames(statement: ts.Statement): string[] {
  const names: string[] = [];
  const fromBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) fromBinding(element.name);
  };
  if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) fromBinding(d.name);
  else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined)
    names.push(statement.name.text);
  return names;
}

/** Every identifier written inside `node`. */
export function identifiersIn(node: ts.Node, into: Set<string>): void {
  if (ts.isIdentifier(node)) into.add(node.text);
  ts.forEachChild(node, (child) => identifiersIn(child, into));
}

/** A string as a single-quoted TypeScript literal. */
export function quote(value: string): string {
  const escapes: Record<string, string> = {
    '\\': '\\\\',
    "'": "\\'",
    '\n': '\\n',
    '\r': '\\r',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  };
  let out = "'";
  for (const ch of value) out += escapes[ch] ?? ch;
  return `${out}'`;
}

/** A string literal's value when `node` is a plain string or a template with no substitutions. */
export function literalText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

export function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current))
    current = current.expression;
  return current;
}
