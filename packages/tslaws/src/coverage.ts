// Coverage: code is checked against the laws only if a law reaches it. Every exported function or class in the
// covered modules must be reachable from some law through calls, or a person must have exempted it.
//
// Covered modules are the `cover` globs of tslaws.json, or, without that file, every module the laws import
// (directly or through other project modules). A function carrying `@tslaws-exempt` in its doc comment is exempt,
// but only once the exemption is in tsc-laws.lock, so an agent cannot exempt its own code.
import { parseGithubConfig } from './github.ts';
import { parseSecurityConfig } from './security/deps/config.ts';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import ts from 'typescript';
import { parseE2eConfig, type E2eConfig } from './e2e.ts';
import { globMatcher } from './globs.ts';
import { customLawFile } from './lawFiles.ts';
import { certifyProblem, type CertifyMode } from './certificates.ts';
import { importMetaEnvOf, parseEnvConfig, type ImportMetaEnv } from './runtimeEnv.ts';
import { solversProblem, type SolverName } from './solvers.ts';

export interface CoverageConfig {
  cover?: string[];
  /** Compiler options the runner passes to tsc; see `compilerFlags` in compile.ts for the supported keys. */
  compilerOptions?: Record<string, unknown>;
  /**
   * Where laws take their module resolution (`paths`, `baseUrl`, project references) from: a tsconfig path relative to
   * tslaws.json, or `false` for none. Default: the nearest tsconfig.json above the project. See tsconfigResolve.ts.
   */
  tsconfig?: string | false;
  /** End-to-end laws: the app to drive; see `parseE2eConfig`. */
  e2e?: E2eConfig;
  /**
   * Extra globs for laws files with other names: any file they match that declares a top-level `export law` is a laws
   * file, besides every file named `*.laws.ts`. A leading `!` excludes. Default: none.
   */
  laws?: string[];
  /**
   * Where a laws file's level (Node, browser, end to end) comes from. `names` (the default): the file name
   * (`*.browser.laws.ts`, `*.e2e.laws.ts`). `imports`: the file's import graph; names are still recognised as hints.
   */
  levels?: 'names' | 'imports';
  /**
   * The SMT solvers that must agree before a law is `proved`: `["z3"]` (the default) or `["z3", "cvc5"]`, where cvc5
   * must also answer `unsat` or the law is `bounded`. Z3 is required. See solvers.ts.
   */
  solvers?: SolverName[];
  /**
   * Check every proof Z3 finds with cvc5 (an Alethe proof) and Carcara, and record the law as `certified` or
   * `uncertified`. `"require"` makes anything short of `certified` an error. Default off. See certificates.ts.
   */
  certify?: CertifyMode;
  /** esbuild plugin modules (paths relative to tslaws.json) that teach the browser bundler new source formats. */
  bundlerPlugins?: string[];
  /**
   * Directories outside the project (paths relative to tslaws.json) whose reviewed files the law sandbox may read, besides
   * the workspace packages and the `paths` and `references` targets of the tsconfig. Dotfiles and the home directory are
   * refused whatever is named. See sandbox.ts.
   */
  sandboxReads?: string[];
  /**
   * `import.meta.env` for code laws reach, on top of `process.env` and the defaults (`MODE` `test`, `DEV`, `PROD`, `SSR`,
   * `BASE_URL`); its entries override both. See runtimeEnv.ts.
   */
  env?: Record<string, string | boolean>;
  /** Run settings; a command line flag beats them and they beat the built-in default. */
  runs?: number;
  propertyTimeoutMs?: number;
  proofTimeoutMs?: number;
  bound?: number;
  /** The most laws, proofs and solvers that run at once (the CPU budget); `--jobs` and `TSLAWS_JOBS` beat it. Not sealed: it is the machine's, not the project's. */
  jobs?: number;
  /** Accepting laws on GitHub: see github.ts. When present, `tslaws accept` refuses to run unless `github.local` is true (the default). */
  github?: unknown;
  /** `tslaws security deps`: the severity that fails the check, offline mode, the cache; see security/deps/config.ts. */
  security?: unknown;
}

const settingKeys = ['runs', 'propertyTimeoutMs', 'proofTimeoutMs', 'bound'] as const;
const configKeys = [
  'cover',
  'laws',
  'levels',
  'solvers',
  'certify',
  'compilerOptions',
  'tsconfig',
  'e2e',
  'bundlerPlugins',
  'sandboxReads',
  'env',
  'github',
  'security',
  'jobs',
  ...settingKeys,
];
/** Keys that steer inheritance and discovery rather than a run; `readConfig` acts on them and drops them. */
const structuralKeys = ['extends', 'projects', 'standalone'];

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

/** Why `value` is not a usable `projects` list (directory globs relative to the file), or undefined. */
export function projectsProblem(value: unknown): string | undefined {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.replace(/^!/, '') === '' || entry.startsWith('/'))
  )
    return `"projects" must be an array of directory globs relative to tslaws.json, got ${JSON.stringify(value)}`;
  return undefined;
}

/** The top-level checks that hold for one file on its own; `source` names that file in every message. */
function checkFile(raw: unknown, source: string): Record<string, unknown> {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('must be a JSON object');
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== '$schema' && !configKeys.includes(key) && !structuralKeys.includes(key))
      fail(`unknown option "${key}"; supported options are ${[...configKeys, ...structuralKeys].join(', ')}`);
  }
  if (object.extends !== undefined && (typeof object.extends !== 'string' || object.extends === ''))
    fail(`"extends" must be a path to another tslaws.json, got ${JSON.stringify(object.extends)}`);
  const projects = object.projects === undefined ? undefined : projectsProblem(object.projects);
  if (projects !== undefined) fail(projects);
  if (object.standalone !== undefined && typeof object.standalone !== 'boolean')
    fail(`"standalone" must be true or false, got ${JSON.stringify(object.standalone)}`);
  for (const key of [...settingKeys, 'jobs'] as const) {
    const value = object[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1))
      fail(`"${key}" must be an integer of at least 1, got ${JSON.stringify(value)}`);
  }
  const tsconfig = object.tsconfig;
  if (tsconfig !== undefined && tsconfig !== false && (typeof tsconfig !== 'string' || tsconfig === ''))
    fail(`"tsconfig" must be a path to a tsconfig file or false, got ${JSON.stringify(tsconfig)}`);
  const plugins = object.bundlerPlugins;
  if (
    plugins !== undefined &&
    (!Array.isArray(plugins) || plugins.some((entry) => typeof entry !== 'string' || entry === ''))
  )
    fail(`"bundlerPlugins" must be an array of module paths, got ${JSON.stringify(plugins)}`);
  const reads = object.sandboxReads;
  if (
    reads !== undefined &&
    (!Array.isArray(reads) || reads.some((entry) => typeof entry !== 'string' || entry === ''))
  )
    fail(`"sandboxReads" must be an array of directory paths, got ${JSON.stringify(reads)}`);
  if (object.env !== undefined) parseEnvConfig(object.env);
  const levels = object.levels;
  if (levels !== undefined && levels !== 'names' && levels !== 'imports')
    fail(`"levels" must be "names" or "imports", got ${JSON.stringify(levels)}`);
  const problem = object.solvers === undefined ? undefined : solversProblem(object.solvers);
  if (problem !== undefined) fail(problem);
  const certifyIssue = object.certify === undefined ? undefined : certifyProblem(object.certify);
  if (certifyIssue !== undefined) fail(certifyIssue);
  const laws = object.laws;
  if (
    laws !== undefined &&
    (!Array.isArray(laws) ||
      laws.some((entry) => typeof entry !== 'string' || entry.replace(/^!/, '') === '' || entry.startsWith('/')))
  )
    fail(`"laws" must be an array of project-relative globs, got ${JSON.stringify(laws)}`);
  if (object.security !== undefined) parseSecurityConfig(object.security);
  return object;
}

/**
 * Validates the top level of tslaws.json: known keys only, and the run settings are integers of at least 1. `extends`
 * and `projects` are accepted (a string, and a list of globs) but are not part of the result: `readConfig` has
 * already acted on `extends`, and discovery reads `projects` from the file itself.
 */
export function parseConfig(raw: unknown, source = 'tslaws.json'): CoverageConfig {
  const object = checkFile(raw, source);
  if (object.github !== undefined) parseGithubConfig(object.github);
  const config = { ...object };
  for (const key of structuralKeys) delete config[key];
  return config as CoverageConfig;
}

/**
 * The settings that name a file or directory by path, rebased when inherited through `extends`: a value is written
 * relative to the file that declares it (as in tsconfig), so it is rebased to the extending file. `bundlerPlugins` are
 * module paths and `e2e.server.cwd` is the directory the dev server runs in. A trailing `[]` means every element of an
 * array. `cover` and `laws` are not here on purpose: they are globs relative to the project that uses the config, so a
 * shared base saying `"cover": ["src/**"]` means each package's own src/. `compilerOptions`, `github` and `security` hold no
 * paths. Add a new file-reference option here when it is added to `configKeys`.
 */
const pathFields: readonly string[] = ['bundlerPlugins[]', 'sandboxReads[]', 'e2e.server.cwd', 'tsconfig'];

/** `entry`, written relative to the directory `from`, as a path relative to `to`. A leading `!` and absolute paths stay. */
function rebase(entry: string, from: string, to: string): string {
  const negated = entry.startsWith('!');
  const body = negated ? entry.slice(1) : entry;
  const prefix = relative(to, from).replaceAll('\\', '/');
  if (prefix === '' || isAbsolute(body)) return entry;
  return `${negated ? '!' : ''}${posix.join(prefix, body)}`;
}

function rebaseFields(config: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const field of pathFields) {
    const parts = field.split('.');
    let node = out;
    for (const [index, part] of parts.entries()) {
      const list = part.endsWith('[]');
      const key = list ? part.slice(0, -2) : part;
      const value = node[key];
      if (index === parts.length - 1) {
        if (list && Array.isArray(value))
          node[key] = value.map((entry) => (typeof entry === 'string' ? rebase(entry, from, to) : entry));
        else if (!list && typeof value === 'string') node[key] = rebase(value, from, to);
      } else if (isPlain(value)) {
        node[key] = { ...value };
        node = node[key] as Record<string, unknown>;
      } else break;
    }
  }
  return out;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objects merge key by key; anything else, arrays included, is replaced. The child wins. */
function deepMerge(base: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(child)) {
    if (key === '__proto__') continue;
    const inherited = out[key];
    out[key] = isPlain(value) && isPlain(inherited) ? deepMerge(inherited, value) : value;
  }
  return out;
}

/**
 * The text of an `extends` value if it is one this tool will follow: a non-empty relative path with forward slashes only.
 * An absolute path, a drive or UNC path, a backslash, or a NUL is refused, so the on-disk loader and the GitHub checks
 * that read the same files through the API resolve one target and never two.
 */
export function checkExtendsValue(value: unknown): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(`"extends" must be a path to another tslaws.json, got ${JSON.stringify(value)}`);
  // Letters, digits and . _ - / @ only: no `?`, `#`, `&` or `%` (which change an API URL's query), no backslash, NUL,
  // space or drive colon.
  if (!/^[A-Za-z0-9._\-/@]+$/.test(value) || value.startsWith('/'))
    throw new Error(
      `"extends" must be a relative path of letters, digits and . _ - / @ with forward slashes, got ${JSON.stringify(value)}`,
    );
  return value;
}

/**
 * Where `extends` points, as a repository path: `fromFile` is the repository path of the file that names it. Refuses
 * what `checkExtendsValue` does, and a target that leaves the repository.
 */
export function extendsTarget(fromFile: string, value: unknown): string {
  const target = posix.normalize(posix.join(posix.dirname(fromFile), checkExtendsValue(value)));
  if (target === '..' || target.startsWith('../') || posix.isAbsolute(target))
    throw new Error(`"extends" ${JSON.stringify(value)} in ${fromFile} leaves the repository`);
  return target;
}

/**
 * The directory no `extends` may leave: the nearest enclosing directory with a `.git`, else the highest enclosing one
 * that carries a workspace file (`tslaws.json`, `package.json` or `pnpm-workspace.yaml`), else `cwd` itself.
 */
export function extendsRoot(cwd: string): string {
  let top = resolve(cwd);
  let dir = top;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (['tslaws.json', 'package.json', 'pnpm-workspace.yaml'].some((f) => existsSync(join(dir, f)))) top = dir;
    const parent = dirname(dir);
    if (parent === dir) return top;
    dir = parent;
  }
}

/** Whether `inner` is `outer` or inside it, by path alone. */
const within = (outer: string, inner: string): boolean => {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Loads `file` and the files it `extends`, merged, with paths relative to the directory of `file`. `chain` holds the
 * files being loaded, outermost first, so a cycle or a missing file is reported with the way it was reached; every
 * file read is added to `loaded`.
 */
function loadMerged(
  file: string,
  cwd: string,
  root: string,
  chain: string[],
  loaded: string[],
): Record<string, unknown> {
  const shown = (path: string): string => relative(cwd, path).replaceAll('\\', '/') || path;
  const trail = [...chain, file];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${shown(file)}: no such file (reached by extends: ${trail.map(shown).join(' -> ')})`);
  }
  // A symlink is not followed: the GitHub checks read a repository file as a blob and refuse a link, so a link here
  // would be a file only one side reads.
  if (lstatSync(file).isSymbolicLink())
    throw new Error(
      `${shown(file)}: a symlink, which tslaws does not follow (reached by extends: ${trail.map(shown).join(' -> ')})`,
    );
  loaded.push(file);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // The parser's message quotes the file's text, which is not ours to echo into a log.
    throw new Error(`${shown(file)}: not valid JSON`);
  }
  const { extends: parent, ...own } = checkFile(json, shown(file));
  if (parent === undefined) return own;
  const baseFile = resolve(dirname(file), checkExtendsValue(parent));
  // The same containment as the GitHub checks (`extendsTarget`): by path, and by where a link or a linked directory
  // really leads.
  const outside = (): Error =>
    new Error(`${shown(file)}: "extends" ${JSON.stringify(parent)} leaves the repository (${shown(root)})`);
  if (!within(root, baseFile)) throw outside();
  if (existsSync(baseFile) && !within(realpathSync(root), realpathSync(baseFile))) throw outside();
  if (trail.includes(baseFile))
    throw new Error(`${shown(file)}: "extends" forms a cycle (${[...trail, baseFile].map(shown).join(' -> ')})`);
  const base = rebaseFields(loadMerged(baseFile, cwd, root, trail, loaded), dirname(baseFile), dirname(file));
  // `projects` lists directories under the file that wrote it, so it is never inherited; nor is `standalone`, which is
  // about the one project whose file says it.
  delete base.projects;
  delete base.standalone;
  return deepMerge(base, own);
}

/** The settings of tslaws.json in `cwd`, with every `extends` followed; `{}` when there is no file. */
export function readConfig(cwd: string): CoverageConfig {
  const path = join(cwd, 'tslaws.json');
  if (!existsSync(path)) return {};
  const loaded: string[] = [];
  const merged = loadMerged(path, cwd, extendsRoot(cwd), [], loaded);
  let config: CoverageConfig;
  try {
    config = parseConfig(merged);
    if (config.e2e !== undefined) config.e2e = parseE2eConfig(config.e2e);
  } catch (error) {
    if (loaded.length === 1) throw error;
    const files = loaded.map((file) => relative(cwd, file).replaceAll('\\', '/')).join(', ');
    throw new Error(`${(error as Error).message} (merged from ${files})`);
  }
  return config;
}

/** The `import.meta.env` of the project's laws: `process.env`, the defaults and the `env` of tslaws.json. */
export function lawEnv(cwd: string, surface: 'node' | 'browser'): ImportMetaEnv {
  return importMetaEnvOf(readConfig(cwd).env, surface);
}

/** Source files matching the `cover` globs (a leading `!` excludes), minus laws files and declarations. */
export function coverFiles(cwd: string, globs: string[]): string[] {
  // Plain JavaScript sources are covered only when the project compiles them (`allowJs`).
  const js = readConfig(cwd).compilerOptions?.allowJs === true;
  const covered = globMatcher(globs);
  const isLaws = customLawFile(cwd);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.tslaws' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const file = relative(cwd, full).replaceAll('\\', '/');
        if (!(js ? /\.(ts|tsx|mts|cts|js)$/ : /\.(ts|tsx|mts|cts)$/).test(file)) continue;
        if (/\.d\.(ts|mts|cts)$/.test(file) || file.endsWith('.laws.ts')) continue;
        if (covered(file) && !isLaws(file)) found.push(file);
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
  /** Declarations the compiler emitted for the program, or the program that compiled the code (then `moduleOf` is given). */
  program: ts.Program;
  /** Where a module's exports are read from, by its path relative to `cwd`; the emitted declaration when absent. */
  moduleOf?: (file: string) => string;
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
    for (const name of exportedFunctions(input.program, input.moduleOf?.(file) ?? dtsOf(input.outDir, file))) {
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
