// The seal of a law: what it depends on besides its own text, so the lock notices a law weakened without touching it.
//
// A law is only as strong as the helpers and generators it calls and the settings it runs under. The seal digests:
//   - the top-level declarations of its file that the law references, transitively (helpers, generators, types);
//   - the top-level code of its file that declares nothing (it runs on load and may change anything);
//   - the project modules those pull in, whole and transitively: an import's top-level code runs, and a type decides
//     the parameters a proof ranges over;
//   - the run settings of tslaws.json (see `sealedSettings`).
// The other laws of the file are not in it, so editing one law, or a helper only it uses, tampers that law alone. Code is
// compared as tokens, so reformatting and comments change nothing but a string, a number or an operator does.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';
import { readConfig } from './coverage.ts';
import { moduleSpecifiers } from './lawKinds.ts';
import { identifiersIn, parseLawFile, type ParsedDeclaration } from './promote.ts';
import { sealedSettings } from './settings.ts';
import { readResolution, resolutionCompilerOptions } from './tsconfigResolve.ts';
import type { ManifestLaw } from './types.ts';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The code as its tokens joined by one space: no comments or layout, every literal exact. */
function tokensOf(text: string, fileName: string): string {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length > 0) children.forEach(visit);
    else if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(node.getText(source));
  };
  visit(source);
  return tokens.join(' ');
}

const scripts = /\.(?:[cm]?[jt]sx?)$/;

/** The line endings of a checkout must not matter, so text is read with `\n`. */
const readText = (path: string): string => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

/** Finds the project file a specifier names, with the project's own `paths`; undefined for a package or a declaration file. */
function resolver(cwd: string): (specifier: string, from: string) => string | undefined {
  const options: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    ...resolutionCompilerOptions(readResolution(cwd)?.options),
  };
  return (specifier, from) => {
    const found = ts.resolveModuleName(specifier, from, options, ts.sys).resolvedModule;
    if (found === undefined || found.isExternalLibraryImport === true) return undefined;
    const file = found.resolvedFileName;
    const inside = relative(cwd, file);
    if (inside.startsWith('..') || isAbsolute(inside) || /(?:^|[\\/])node_modules[\\/]/.test(inside)) return undefined;
    return /\.d\.[cm]?ts$/.test(file) || !existsSync(file) ? undefined : file;
  };
}

/** One import statement of a laws file: where it points and the names it brings in; none for a side-effect import. */
interface Import {
  specifier: string;
  names: string[];
}

function importOf(statement: string): Import | undefined {
  const source = ts.createSourceFile('import.ts', statement, ts.ScriptTarget.Latest, true);
  const node = source.statements[0];
  if (node === undefined || !ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier))
    return undefined;
  const names: string[] = [];
  const clause = node.importClause;
  if (clause?.name !== undefined) names.push(clause.name.text);
  const bindings = clause?.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  else if (bindings !== undefined) for (const element of bindings.elements) names.push(element.name.text);
  return { specifier: node.moduleSpecifier.text, names };
}

/** The statements of a laws file that declare nothing and are not imports or laws: code that runs when the file loads. */
function loadCode(rest: string, declarations: ParsedDeclaration[]): string[] {
  const source = ts.createSourceFile('laws.ts', rest, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = new Set(declarations.map((d) => d.end));
  return source.statements
    .filter((s) => !declared.has(s.end) && !ts.isEmptyStatement(s))
    .map((s) => tokensOf(s.getText(source), 'laws.ts'));
}

interface FileFacts {
  imports: Import[];
  declarations: ParsedDeclaration[];
  loadCode: string[];
}

/** Reads laws files and the modules behind them once, and seals the laws of a project. */
class Sealer {
  private readonly cwd: string;
  private readonly settings: string;
  private readonly resolve: ReturnType<typeof resolver>;
  private readonly facts = new Map<string, FileFacts | undefined>();
  /** The tokens' digest of each project module and the project modules it imports. */
  private readonly modules = new Map<string, { digest: string; imports: string[] } | undefined>();

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    this.settings = JSON.stringify(sorted(sealedSettings(readConfig(cwd))));
    this.resolve = resolver(this.cwd);
  }

  private factsOf(file: string): FileFacts | undefined {
    if (!this.facts.has(file)) {
      let facts: FileFacts | undefined;
      try {
        const parsed = parseLawFile(readText(resolve(this.cwd, file)));
        facts = {
          imports: parsed.imports.flatMap((statement) => importOf(statement) ?? []),
          declarations: parsed.declarations,
          loadCode: loadCode(parsed.rest, parsed.declarations),
        };
      } catch {
        // An unreadable file seals nothing but its settings; the compiler reports the file itself.
      }
      this.facts.set(file, facts);
    }
    return this.facts.get(file);
  }

  private moduleOf(path: string): { digest: string; imports: string[] } | undefined {
    if (!this.modules.has(path)) {
      this.modules.set(path, undefined);
      let text: string;
      try {
        text = readText(path);
      } catch {
        return undefined;
      }
      const script = scripts.test(path);
      const found = {
        digest: digest(script ? tokensOf(text, path) : text),
        imports: script
          ? moduleSpecifiers(text, path).flatMap((s) => this.resolve(s.value, path) ?? [])
          : ([] as string[]),
      };
      this.modules.set(path, found);
    }
    return this.modules.get(path);
  }

  /** `path` and every project module it reaches, with each one's digest, keyed by project-relative path. */
  private reach(start: string[]): Record<string, string> {
    const reached: Record<string, string> = {};
    const seen = new Set<string>();
    const queue = [...start];
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      if (seen.has(path)) continue;
      seen.add(path);
      const found = this.moduleOf(path);
      if (found === undefined) continue;
      reached[relative(this.cwd, path).replaceAll('\\', '/')] = found.digest;
      queue.push(...found.imports);
    }
    return reached;
  }

  seal(law: ManifestLaw): string {
    const facts = this.factsOf(law.file);
    const base = resolve(this.cwd, law.file);
    const identifiers = identifiersIn(law.text);
    const needed = new Set<ParsedDeclaration>();
    const byName = new Map<string, ParsedDeclaration[]>();
    for (const declaration of facts?.declarations ?? [])
      for (const name of declaration.names) byName.set(name, [...(byName.get(name) ?? []), declaration]);
    const queue = [...identifiers];
    for (let name = queue.pop(); name !== undefined; name = queue.pop())
      for (const declaration of byName.get(name) ?? []) {
        if (needed.has(declaration)) continue;
        needed.add(declaration);
        for (const reference of declaration.references) {
          identifiers.add(reference);
          queue.push(reference);
        }
      }
    const helpers = (facts?.declarations ?? []).filter((d) => needed.has(d)).map((d) => tokensOf(d.text, 'laws.ts'));
    // `require()` and `import()` inside what the law reaches, and every re-export or import of the load code, load a module too.
    const code = [law.text, ...helpers, ...(facts?.loadCode ?? [])];
    const specifiers = new Set<string>(code.flatMap((text) => moduleSpecifiers(text).map((s) => s.value)));
    for (const entry of facts?.imports ?? [])
      if (entry.names.length === 0 || entry.names.some((name) => identifiers.has(name)))
        specifiers.add(entry.specifier);
    const modules = this.reach([...specifiers].flatMap((s) => this.resolve(s, base) ?? []));
    return digest(
      JSON.stringify({ settings: this.settings, helpers, loadCode: facts?.loadCode ?? [], modules: sorted(modules) }),
    );
  }
}

/** `value` with the keys of every object in sorted order, so equal data stringifies equally. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sorted(entry)]),
  );
}

/** The laws with their `seal` set. */
export function sealLaws(cwd: string, laws: ManifestLaw[]): ManifestLaw[] {
  if (laws.length === 0) return laws;
  const sealer = new Sealer(cwd);
  return laws.map((law) => ({ ...law, seal: sealer.seal(law) }));
}
