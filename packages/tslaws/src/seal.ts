// The seal of a law: what it depends on besides its own text, so the lock notices a law weakened without touching it.
//
// A law is only as strong as the helpers and generators it calls and the settings it runs under. The seal digests:
//   - the top-level declarations of its file that the law, or the code that runs when the file loads, references,
//     transitively (helpers, generators, types);
//   - the code of its file that runs when it loads: statements that declare nothing, and declarations whose initializer
//     may run code (`const x = setUp()`);
//   - every module its file imports, whole and transitively: an import runs when the file loads whether or not a law
//     names what it exports, and a type decides the parameters a proof ranges over. Project files, files outside the
//     project (a workspace package, a shared directory) and declaration files with their runtime sibling are digested;
//     a package from a registry is recorded by name and version; a specifier that resolves to nothing is recorded as it
//     is written, so it cannot go missing unseen;
//   - the effective tslaws.json (see `sealedSettings`), the files its `bundlerPlugins` name and the tsconfig it resolves
//     with.
// The other laws of the file are not in it, so editing one law, or a helper only it uses, tampers that law alone. Code is
// compared as tokens, so reformatting and comments change nothing but a string, a number or an operator does.
//
// What it cannot see: a `require(name)` or `import(name)` whose argument is not a string literal, a file the code reads at
// run time (`readFileSync`), the contents of an installed registry package beyond its version, and command line flags.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { readConfig } from './coverage.ts';
import { moduleSpecifiers } from './lawKinds.ts';
import { identifiersIn, parseLawFile, type ParsedDeclaration } from './promote.ts';
import { sealedSettings } from './settings.ts';
import { readResolution, resolutionCompilerOptions } from './tsconfigResolve.ts';
import type { ManifestLaw } from './types.ts';

const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

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

/** A file's digest: the tokens of a script, the text of any other text file, the bytes of a binary one. */
function digestOf(path: string): string {
  if (scripts.test(path)) return digest(tokensOf(readText(path), path));
  const bytes = readFileSync(path);
  return digest(bytes.includes(0) ? bytes : bytes.toString('utf8').replaceAll('\r\n', '\n'));
}

const builtins = new Set(builtinModules);
const underNodeModules = /(?:^|[\\/])node_modules[\\/]/;

const slash = (path: string): string => path.replaceAll('\\', '/');

const realOf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The `name` and `version` of the closest package.json above `file` that has both, stopping at a node_modules directory. */
function packageOfFile(file: string): { name: string; version: string } | undefined {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown };
        if (typeof json.name === 'string' && typeof json.version === 'string')
          return { name: json.name, version: json.version };
      } catch {
        // An unreadable manifest names no package.
      }
    }
    if (dirname(dir) === dir || /(?:^|[\\/])node_modules$/.test(dir)) return undefined;
  }
}

/** The package a bare specifier names: `lodash/fp` -> `lodash`, `@scope/pkg/x` -> `@scope/pkg`. */
const packageNameOf = (specifier: string): string =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

/** The sibling of a declaration file that holds the code, when there is one: `x.d.ts` -> `x.js`, `.d.mts` -> `.mjs`. */
function runtimeSibling(file: string): string | undefined {
  const match = /^(.*)\.d\.([cm]?)ts$/.exec(file);
  if (match === null) return undefined;
  const sibling = `${match[1]}.${match[2]}js`;
  return existsSync(sibling) ? sibling : undefined;
}

/** What one specifier leads to: files to digest and follow, and facts to record as they are. */
interface Linked {
  files: string[];
  externals: string[];
}

/** Resolves the specifiers of the files a law reaches, with the project's own `paths`. */
class Linker {
  private readonly options: ts.CompilerOptions;

  constructor(cwd: string) {
    this.options = {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      allowJs: true,
      resolveJsonModule: true,
      ...resolutionCompilerOptions(readResolution(cwd)?.options),
    };
  }

  /** The registry package a bare specifier names, found the way node finds it: in the closest node_modules above `from`. */
  private installed(specifier: string, from: string): { name: string; version: string } | 'linked' | undefined {
    const name = packageNameOf(specifier);
    for (let dir = dirname(from); ; dir = dirname(dir)) {
      const manifest = join(dir, 'node_modules', name, 'package.json');
      if (existsSync(manifest)) {
        const real = realOf(manifest);
        // A link to a directory outside node_modules (a workspace package) is source: its files are digested.
        if (!underNodeModules.test(real)) return 'linked';
        return packageOfFile(real) ?? undefined;
      }
      if (dirname(dir) === dir) return undefined;
    }
  }

  link(specifier: string, from: string): Linked {
    if (specifier.startsWith('node:') || builtins.has(specifier))
      return { files: [], externals: [`builtin ${specifier}`] };
    const files: string[] = [];
    const externals: string[] = [];
    const bare = !/^\.{1,2}(?:[\\/]|$)/.test(specifier) && !isAbsolute(specifier);
    const installed = bare ? this.installed(specifier, from) : undefined;
    if (installed !== undefined && installed !== 'linked') externals.push(registry(installed, specifier));
    const found = ts.resolveModuleName(specifier, from, this.options, ts.sys).resolvedModule;
    if (found !== undefined && existsSync(found.resolvedFileName)) {
      const real = realOf(found.resolvedFileName);
      if (underNodeModules.test(real)) {
        // A registry package reached through `paths` or as types only (`@types/x`): its name and version.
        const owner = packageOfFile(real);
        externals.push(owner === undefined ? `unresolved ${specifier}` : registry(owner, specifier));
      } else {
        const owner = bare ? packageOfFile(real) : undefined;
        // The tool itself is whatever version runs it; the lock's own format says which semantics it records.
        if (owner?.name === 'tslaws' && (specifier === 'tslaws' || specifier.startsWith('tslaws/')))
          externals.push('package tslaws');
        else {
          files.push(real);
          const sibling = runtimeSibling(real);
          if (sibling !== undefined) files.push(realOf(sibling));
        }
      }
    } else if (installed === undefined || installed === 'linked') {
      // An asset TypeScript does not resolve (css, svg, txt) is digested when the specifier names a file.
      const asset = bare ? undefined : resolve(dirname(from), specifier);
      if (asset !== undefined && existsSync(asset) && statSync(asset).isFile()) files.push(realOf(asset));
      else externals.push(`unresolved ${specifier}`);
    }
    return { files, externals };
  }
}

const registry = (owner: { name: string; version: string }, specifier: string): string =>
  `package ${owner.name}@${owner.version}${packageNameOf(specifier) === owner.name ? '' : ` for ${specifier}`}`;

/** Whether the code of a top-level declaration may run something when its file loads, as opposed to defining a value. */
function runsOnLoad(text: string): boolean {
  const source = ts.createSourceFile('declaration.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const plainName = (name: ts.PropertyName | undefined): boolean =>
    name === undefined || !ts.isComputedPropertyName(name);
  const inert = (node: ts.Expression | undefined): boolean => {
    if (node === undefined) return true;
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      ts.isBigIntLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      node.kind === ts.SyntaxKind.ThisKeyword
    )
      return true;
    if (ts.isClassExpression(node)) return classInert(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
      return inert(node.expression);
    if (ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) return inert(node.expression);
    if (ts.isPrefixUnaryExpression(node))
      return (
        node.operator !== ts.SyntaxKind.PlusPlusToken &&
        node.operator !== ts.SyntaxKind.MinusMinusToken &&
        inert(node.operand)
      );
    if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => inert(span.expression));
    if (ts.isPropertyAccessExpression(node)) return inert(node.expression);
    if (ts.isConditionalExpression(node)) return inert(node.condition) && inert(node.whenTrue) && inert(node.whenFalse);
    if (ts.isBinaryExpression(node))
      return node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
        node.operatorToken.kind > ts.SyntaxKind.LastAssignment
        ? inert(node.left) && inert(node.right)
        : false;
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => !ts.isSpreadElement(e) && inert(e));
    if (ts.isObjectLiteralExpression(node))
      return node.properties.every((p) => {
        if (ts.isShorthandPropertyAssignment(p)) return true;
        if (ts.isPropertyAssignment(p)) return plainName(p.name) && inert(p.initializer);
        return (ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && plainName(p.name);
      });
    return false;
  };
  const classInert = (node: ts.ClassLikeDeclaration): boolean =>
    !ts.canHaveDecorators(node) || (ts.getDecorators(node) ?? []).length === 0
      ? (node.heritageClauses ?? []).every((clause) => clause.types.every((type) => inert(type.expression))) &&
        node.members.every((member) => {
          if (ts.isClassStaticBlockDeclaration(member)) return false;
          if (!plainName(member.name as ts.PropertyName | undefined)) return false;
          if (ts.canHaveDecorators(member) && (ts.getDecorators(member) ?? []).length > 0) return false;
          const isStatic = ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Static;
          return !(ts.isPropertyDeclaration(member) && isStatic !== 0 && !inert(member.initializer));
        })
      : false;
  return source.statements.some((statement) => {
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    )
      return false;
    if (ts.isClassDeclaration(statement)) return !classInert(statement);
    if (ts.isEnumDeclaration(statement)) return !statement.members.every((m) => inert(m.initializer));
    if (ts.isVariableStatement(statement))
      return !statement.declarationList.declarations.every((d) => inert(d.initializer));
    return true;
  });
}

/** A statement of a laws file that runs when the file loads: its text, for the identifiers in it, and its tokens. */
interface LoadCode {
  text: string;
  tokens: string;
}

/**
 * The code of a laws file that runs when it loads: statements that declare nothing and are not imports or laws, and
 * declarations whose initializer may run code.
 */
function loadCode(rest: string, declarations: ParsedDeclaration[]): LoadCode[] {
  const source = ts.createSourceFile('laws.ts', rest, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = new Set(declarations.map((d) => d.end));
  const code: LoadCode[] = source.statements
    .filter((s) => !declared.has(s.end) && !ts.isEmptyStatement(s))
    .map((s) => ({ text: s.getText(source), tokens: tokensOf(s.getText(source), 'laws.ts') }));
  for (const declaration of declarations)
    if (runsOnLoad(declaration.text))
      code.push({ text: declaration.text, tokens: tokensOf(declaration.text, 'laws.ts') });
  return code;
}

interface FileFacts {
  imports: string[];
  declarations: ParsedDeclaration[];
  loadCode: LoadCode[];
}

/** What the modules a seal reaches contribute: their digests and the facts recorded as written. */
interface Reached {
  modules: Record<string, string>;
  externals: string[];
}

/** Reads laws files and the modules behind them once, and seals the laws of a project. */
class Sealer {
  private readonly cwd: string;
  private readonly linker: Linker;
  private readonly facts = new Map<string, FileFacts | undefined>();
  /** The digest of each module and what it imports. */
  private readonly modules = new Map<string, { digest: string; links: Linked[] } | undefined>();
  private readonly settings: string;

  constructor(cwd: string) {
    this.cwd = realOf(resolve(cwd));
    this.linker = new Linker(this.cwd);
    const config = readConfig(cwd);
    const plugins = this.reach(
      (config.bundlerPlugins ?? []).map((path) => realOf(resolve(this.cwd, path))),
      'plugin',
    );
    const resolution = readResolution(cwd);
    const tsconfig =
      resolution === undefined
        ? null
        : {
            file: slash(relative(this.cwd, realOf(resolution.file))),
            digest: digestOf(resolution.file),
            options: portable(resolution.options, this.cwd),
          };
    this.settings = JSON.stringify(sorted({ config: sealedSettings(config), plugins, tsconfig }));
  }

  private factsOf(file: string): FileFacts | undefined {
    if (!this.facts.has(file)) {
      let facts: FileFacts | undefined;
      try {
        const parsed = parseLawFile(readText(resolve(this.cwd, file)));
        const code = loadCode(parsed.rest, parsed.declarations);
        facts = {
          imports: parsed.imports.flatMap((statement) => moduleSpecifiers(statement).map((s) => s.value)),
          declarations: parsed.declarations,
          loadCode: code,
        };
      } catch {
        // An unreadable file seals nothing but its settings; the compiler reports the file itself.
      }
      this.facts.set(file, facts);
    }
    return this.facts.get(file);
  }

  private moduleOf(path: string): { digest: string; links: Linked[] } | undefined {
    if (!this.modules.has(path)) {
      this.modules.set(path, undefined);
      let found: { digest: string; links: Linked[] };
      try {
        found = {
          digest: digestOf(path),
          links: scripts.test(path)
            ? moduleSpecifiers(readText(path), path).map((s) => this.linker.link(s.value, path))
            : [],
        };
      } catch {
        return undefined;
      }
      this.modules.set(path, found);
    }
    return this.modules.get(path);
  }

  /** The files in `start` and every module they reach, with each one's digest, and what is recorded as written. */
  private reach(start: string[], what = 'module'): Reached {
    const modules: Record<string, string> = {};
    const externals = new Set<string>();
    const seen = new Set<string>();
    const queue = [...start];
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      if (seen.has(path)) continue;
      seen.add(path);
      const found = this.moduleOf(path);
      if (found === undefined) {
        externals.add(`unreadable ${what} ${slash(relative(this.cwd, path))}`);
        continue;
      }
      modules[slash(relative(this.cwd, path))] = found.digest;
      for (const link of found.links) {
        queue.push(...link.files);
        for (const external of link.externals) externals.add(external);
      }
    }
    return { modules, externals: [...externals].sort() };
  }

  seal(law: ManifestLaw): string {
    const facts = this.factsOf(law.file);
    const base = resolve(this.cwd, law.file);
    const needed = new Set<ParsedDeclaration>();
    const byName = new Map<string, ParsedDeclaration[]>();
    for (const declaration of facts?.declarations ?? [])
      for (const name of declaration.names) byName.set(name, [...(byName.get(name) ?? []), declaration]);
    // What runs when the file loads references declarations too, so they are reached from there as well as from the law.
    const identifiers = identifiersIn(law.text);
    for (const code of facts?.loadCode ?? []) for (const name of identifiersIn(code.text)) identifiers.add(name);
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
    const load = (facts?.loadCode ?? []).map((c) => c.tokens);
    // Every import of the file runs when it loads, and `require()`, `import()` and re-exports inside what the seal covers
    // load a module too.
    const specifiers = new Set<string>(facts?.imports ?? []);
    for (const text of [law.text, ...helpers, ...load]) for (const s of moduleSpecifiers(text)) specifiers.add(s.value);
    const linked = [...specifiers].sort().map((specifier) => this.linker.link(specifier, base));
    const reached = this.reach(linked.flatMap((l) => l.files));
    const externals = [...new Set([...linked.flatMap((l) => l.externals), ...reached.externals])].sort();
    return digest(
      JSON.stringify({
        settings: this.settings,
        helpers,
        loadCode: load,
        modules: sorted(reached.modules),
        externals,
      }),
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

/** `value` with every absolute path in it written relative to `base`, so a seal does not depend on where a project is checked out. */
function portable(value: unknown, base: string): unknown {
  if (typeof value === 'string')
    return isAbsolute(value)
      ? `${slash(relative(base, value))}${value.endsWith('/') || value.endsWith('\\') ? '/' : ''}`
      : value;
  if (Array.isArray(value)) return value.map((entry) => portable(entry, base));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, portable(entry, base)]));
}

/** The laws with their `seal` set. */
export function sealLaws(cwd: string, laws: ManifestLaw[]): ManifestLaw[] {
  if (laws.length === 0) return laws;
  const sealer = new Sealer(cwd);
  return laws.map((law) => ({ ...law, seal: sealer.seal(law) }));
}
