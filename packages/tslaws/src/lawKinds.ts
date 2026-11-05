// The level a laws file runs at, from what it imports. A file that reaches the browser law API (`tslaws/browser`, or one
// of the `tslaws/adapters/*` entry points) is a browser law; a file that reaches the end-to-end API (`tslaws/e2e`) is an
// end-to-end law; a file that reaches both is refused; a file that reaches neither is a Node law. "Reaches" follows the
// project's own import graph: a helper module the law imports, or a re-export, counts. Imports used only as types, and
// modules under node_modules, do not.
//
// The `.browser.laws.ts` and `.e2e.laws.ts` names stay as hints. They never override an import, and a hint that
// disagrees with the imports is reported.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { suffixKind } from './lawNames.ts';

export type LawKind = 'node' | 'browser' | 'e2e';

export interface ImportFacts {
  /** The chain of project files from the laws file to the one that imports a browser law entry point, if any. */
  browser: string[] | undefined;
  e2e: string[] | undefined;
}

export interface KindVerdict {
  kind: LawKind;
  /** Set when the file cannot run at one level; the message names the files involved. */
  error?: string;
  /** Things worth saying that do not stop the file: a name hint that the imports contradict or do not back. */
  notices: string[];
  imports: ImportFacts;
}

const browserEntry = /^tslaws\/(?:browser|adapters\/(?:dom|react|angular|element))$/;
const e2eEntry = 'tslaws/e2e';

interface Specifier {
  value: string;
}

/** The module specifiers a file loads at run time: static imports, re-exports, `require` and dynamic `import()`. */
export function runtimeSpecifiers(text: string, fileName = 'laws.ts'): Specifier[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Specifier[] = [];
  const literal = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) found.push({ value: node.text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) literal(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) literal(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference))
        literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))
        literal(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const resolveOptions: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  allowJs: true,
  resolveJsonModule: false,
};

/** The project source a specifier names, or undefined for a package, a declaration file or something unresolved. */
function projectSource(specifier: string, from: string): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined;
  const resolved = ts.resolveModuleName(specifier, from, resolveOptions, ts.sys).resolvedModule;
  if (resolved === undefined || resolved.isExternalLibraryImport === true) return undefined;
  const file = resolved.resolvedFileName;
  if (/[\\/]node_modules[\\/]/.test(file) || /\.d\.[cm]?ts$/.test(file) || !existsSync(file)) return undefined;
  return file;
}

/** Walks the import graph from `file` and finds the first chain that reaches each level's entry point. */
export function importFacts(cwd: string, file: string): ImportFacts {
  const start = resolve(cwd, file);
  const facts: ImportFacts = { browser: undefined, e2e: undefined };
  const seen = new Set<string>([start]);
  const queue: { path: string; chain: string[] }[] = [{ path: start, chain: [file.replaceAll('\\', '/')] }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    let text: string;
    try {
      text = readFileSync(next.path, 'utf8');
    } catch {
      continue;
    }
    for (const { value } of runtimeSpecifiers(text, next.path)) {
      if (browserEntry.test(value)) facts.browser ??= next.chain;
      else if (value === e2eEntry) facts.e2e ??= next.chain;
      const target = projectSource(value, join(dirname(next.path), 'x.ts'));
      if (target === undefined || seen.has(target)) continue;
      seen.add(target);
      const inside = relative(resolve(cwd), resolve(target));
      const shown = inside.startsWith('..') || isAbsolute(inside) ? target : inside;
      queue.push({ path: target, chain: [...next.chain, shown.replaceAll('\\', '/')] });
    }
  }
  return facts;
}

const via = (chain: string[]): string => (chain.length <= 1 ? 'directly' : `through ${chain.slice(1).join(' > ')}`);

/** Classifies a laws file (project-relative path) by its imports, checking the name hint against them. */
export function classifyLawFile(cwd: string, file: string): KindVerdict {
  const imports = importFacts(cwd, file);
  const hint = suffixKind(file);
  const notices: string[] = [];
  const base = file.replaceAll('\\', '/');
  if (imports.browser !== undefined && imports.e2e !== undefined)
    return {
      kind: 'node',
      imports,
      notices,
      error:
        `${base}: a laws file is either component level (tslaws/browser) or end-to-end (tslaws/e2e), not both ` +
        `(browser API reached ${via(imports.browser)}; end-to-end API reached ${via(imports.e2e)})`,
    };
  const kind: LawKind = imports.e2e !== undefined ? 'e2e' : imports.browser !== undefined ? 'browser' : 'node';
  if (hint === undefined || hint === kind) return { kind, imports, notices };
  if (kind === 'node') {
    // Nothing imported says which level, so the name still stands: a law may use the page's globals directly.
    notices.push(
      `${base}: the name says ${hint}, but nothing it imports is the ${hint === 'e2e' ? 'end-to-end' : 'browser'} law API; ` +
        `the name is used as the level. Import ${hint === 'e2e' ? 'tslaws/e2e' : 'tslaws/browser'} (the name is only a hint)`,
    );
    return { kind: hint, imports, notices };
  }
  if (hint === 'browser') {
    // A browser-named file that drives an app is an end-to-end law, as it always was.
    notices.push(
      `${base}: the name says browser, but it reaches the end-to-end API ${via(imports.e2e!)}; it runs end to end`,
    );
    return { kind, imports, notices };
  }
  return {
    kind,
    imports,
    notices,
    error: `${base}: the name says end-to-end, but it reaches the browser API ${via(imports.browser!)} and not tslaws/e2e; rename it or fix its imports`,
  };
}
