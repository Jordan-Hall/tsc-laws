// Coverage: code is checked against the laws only if a law reaches it. Every exported function or class in the
// covered modules must be reachable from some law through calls, or a person must have exempted it.
//
// Covered modules are the `cover` globs of tslaws.json, or, without that file, every module the laws import
// (directly or through other project modules). A function carrying `@tslaws-exempt` in its doc comment is exempt,
// but only once the exemption is in tsc-laws.lock, so an agent cannot exempt its own code.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { parseE2eConfig, type E2eConfig } from './e2e.ts';

export interface CoverageConfig {
  cover?: string[];
  /** Compiler options the runner passes to tsc; see `compilerFlags` in compile.ts for the supported keys. */
  compilerOptions?: Record<string, unknown>;
  /** End-to-end laws: the app to drive; see `parseE2eConfig`. */
  e2e?: E2eConfig;
  /** Run settings; a command line flag beats them and they beat the built-in default. */
  runs?: number;
  propertyTimeoutMs?: number;
  proofTimeoutMs?: number;
  bound?: number;
}

const settingKeys = ['runs', 'propertyTimeoutMs', 'proofTimeoutMs', 'bound'] as const;
const configKeys = ['cover', 'compilerOptions', 'e2e', ...settingKeys];

export interface Uncovered {
  file: string;
  name: string;
}

export interface CoverageReport {
  uncovered: Uncovered[];
  /** `file::name` of every function marked `@tslaws-exempt`. */
  exempt: string[];
  /** The source files the check covers, for the compiler to emit. */
  files: string[];
}

interface Node {
  name: string;
  body: ts.Node;
  exempt: boolean;
}

interface Module {
  nodes: Map<string, Node>;
  imports: Map<string, string>;
}

/** Validates the top level of tslaws.json: known keys only, and the run settings are integers of at least 1. */
export function parseConfig(raw: unknown): CoverageConfig {
  const fail = (message: string): never => {
    throw new Error(`tslaws.json: ${message}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('must be a JSON object');
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== '$schema' && !configKeys.includes(key))
      fail(`unknown option "${key}"; supported options are ${configKeys.join(', ')}`);
  }
  for (const key of settingKeys) {
    const value = object[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1))
      fail(`"${key}" must be an integer of at least 1, got ${JSON.stringify(value)}`);
  }
  return object as CoverageConfig;
}

export function readConfig(cwd: string): CoverageConfig {
  const path = join(cwd, 'tslaws.json');
  if (!existsSync(path)) return {};
  const config = parseConfig(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (config.e2e !== undefined) config.e2e = parseE2eConfig(config.e2e);
  return config;
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Source files matching the `cover` globs (a leading `!` excludes), minus laws files and declarations. */
export function coverFiles(cwd: string, globs: string[]): string[] {
  // Plain JavaScript sources are covered only when the project compiles them (`allowJs`).
  const js = readConfig(cwd).compilerOptions?.allowJs === true;
  const include = globs.filter((g) => !g.startsWith('!')).map(globToRegExp);
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.tslaws' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const file = relative(cwd, full).replaceAll('\\', '/');
        if (!(js ? /\.(ts|tsx|mts|cts|js)$/ : /\.(ts|tsx|mts|cts)$/).test(file)) continue;
        if (/\.d\.(ts|mts|cts)$/.test(file) || /\.laws\.ts$/.test(file)) continue;
        if (include.some((r) => r.test(file)) && !exclude.some((r) => r.test(file))) found.push(file);
      }
    }
  };
  walk(cwd);
  return found.sort();
}

function parseModule(jsFile: string, modules: Map<string, Module>): Module | undefined {
  const known = modules.get(jsFile);
  if (known !== undefined) return known;
  if (!existsSync(jsFile)) return undefined;
  const text = readFileSync(jsFile, 'utf8');
  const source = ts.createSourceFile(jsFile, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const module: Module = { nodes: new Map(), imports: new Map() };
  modules.set(jsFile, module);
  const exempt = (statement: ts.Node): boolean =>
    (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []).some((r) =>
      text.slice(r.pos, r.end).includes('@tslaws-exempt'),
    );
  for (const statement of source.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined)
      module.nodes.set(statement.name.text, { name: statement.name.text, body: statement, exempt: exempt(statement) });
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      const init = declaration.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init))
        module.nodes.set(declaration.name.text, { name: declaration.name.text, body: init, exempt: exempt(statement) });
      else if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'require' &&
        init.arguments.length === 1 &&
        ts.isStringLiteral(init.arguments[0]!) &&
        init.arguments[0].text.startsWith('.')
      ) {
        const base = resolve(dirname(jsFile), init.arguments[0].text);
        module.imports.set(declaration.name.text, /\.[cm]?js$/.test(base) ? base : `${base}.js`);
      }
    }
  }
  return module;
}

function exportedFunctions(program: ts.Program, dts: string): string[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(dts);
  const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) return [];
  const names: string[] = [];
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (target.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Class)) names.push(symbol.getName());
    else if (target.flags & ts.SymbolFlags.Variable) {
      const declaration = target.valueDeclaration ?? target.declarations?.[0];
      if (
        declaration !== undefined &&
        checker.getTypeOfSymbolAtLocation(target, declaration).getCallSignatures().length > 0
      )
        names.push(symbol.getName());
    }
  }
  return names;
}

export interface CoverageInput {
  cwd: string;
  outDir: string;
  lawFiles: string[];
  /** Files named by the `cover` globs; empty means every module the laws reach. */
  coverFiles: string[];
  /** Declarations the compiler emitted for the program. */
  program: ts.Program;
}

const jsOf = (outDir: string, file: string): string => join(outDir, file.replace(/\.(ts|tsx|mts|cts)$/, '.js'));
const dtsOf = (outDir: string, file: string): string => join(outDir, file.replace(/\.(ts|tsx|mts|cts|js)$/, '.d.ts'));
/** The project source behind an emitted module: TypeScript, JSX or, with `allowJs`, JavaScript. */
const sourceOf = (outDir: string, cwd: string, js: string): string => {
  const rel = relative(outDir, js).replaceAll('\\', '/');
  if (rel === '') return relative(cwd, js);
  const base = rel.replace(/\.js$/, '');
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}.js`];
  return candidates.find((c) => existsSync(join(cwd, c))) ?? candidates[0]!;
};

export function analyzeCoverage(input: CoverageInput): CoverageReport {
  const modules = new Map<string, Module>();
  const key = (js: string, name: string): string => `${js}::${name}`;
  const edges = (js: string, node: Node): string[] => {
    const module = modules.get(js)!;
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && module.nodes.has(n.text) && n.text !== node.name) out.push(key(js, n.text));
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        const target = module.imports.get(n.expression.text);
        if (target !== undefined) {
          parseModule(target, modules);
          out.push(key(target, n.name.text));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node.body);
    return out;
  };

  // Everything a law calls, transitively, is checked by that law.
  const reached = new Set<string>();
  const queue: string[] = [];
  const lawJs = input.lawFiles.map((f) => jsOf(input.outDir, f));
  for (const js of lawJs) {
    const module = parseModule(js, modules);
    if (module === undefined) continue;
    for (const node of module.nodes.values()) queue.push(key(js, node.name));
  }
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (reached.has(current)) continue;
    reached.add(current);
    const [js, name] = current.split('::') as [string, string];
    const module = parseModule(js, modules);
    const node = module?.nodes.get(name);
    if (node !== undefined) for (const next of edges(js, node)) if (!reached.has(next)) queue.push(next);
  }

  // The modules in scope: the cover globs, or every project module the laws import.
  const scope = new Set<string>();
  if (input.coverFiles.length > 0) for (const f of input.coverFiles) scope.add(jsOf(input.outDir, f));
  else {
    const visit = (js: string): void => {
      const module = parseModule(js, modules);
      if (module === undefined) return;
      for (const target of module.imports.values()) {
        if (!scope.has(target) && !lawJs.includes(target)) {
          scope.add(target);
          visit(target);
        }
      }
    };
    for (const js of lawJs) visit(js);
  }

  const uncovered: Uncovered[] = [];
  const exempt: string[] = [];
  for (const js of scope) {
    const module = parseModule(js, modules);
    if (module === undefined) continue;
    const file = sourceOf(input.outDir, input.cwd, js);
    for (const name of exportedFunctions(input.program, dtsOf(input.outDir, file))) {
      const node = module.nodes.get(name);
      if (node?.exempt === true) exempt.push(`${file}::${name}`);
      else if (!reached.has(key(js, name))) uncovered.push({ file, name });
    }
  }
  return {
    uncovered: uncovered.sort((a, b) => `${a.file}::${a.name}`.localeCompare(`${b.file}::${b.name}`)),
    exempt: exempt.sort(),
    files: [...scope].map((js) => sourceOf(input.outDir, input.cwd, js)).sort(),
  };
}
