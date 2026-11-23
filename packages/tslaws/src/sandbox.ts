// A hard runtime boundary for law execution. Laws, and the helpers a proposal brings, may be written by an agent, and a
// static check cannot fence in JavaScript. So node laws run in a child process (lawHost.ts) started under Node's permission
// model: it may read the project, its `node_modules` and the tslaws package and nothing else, write nothing, and start no
// process, worker, addon or WASI instance; code from strings is off (`--disallow-code-generation-from-strings`); and a
// module guard (sandboxGuard.ts) refuses to load anything the parent did not review. The parent trusts nothing that
// comes back: `readOutcome` rebuilds each answer field by field, as `readReport` does for a check's report (isolate.ts).
//
// What the process cannot do for itself, the parent does first, as trusted code: transform the reviewed files that Node
// cannot load as written (TypeScript source outside the build, files in a project format through `bundlerPlugins`) and
// hand over the result. What it cannot hold: laws that drive a browser need processes, so end-to-end laws run outside it
// (browser laws run in the page, behind the browser's own boundary), and so they are refused unless the person allows
// them (`--allow-e2e`). `--no-sandbox` turns it all off, with a warning.
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { lawEnv, readConfig } from './coverage.ts';
import { scrubbedEnv } from './isolate.ts';
import type { HostReply, HostRequest, Prepared } from './lawHost.ts';
import { runtimeOf, transformSource } from './lawRuntime.ts';
import { pluginExtensionNeeded } from './pluginHooks.ts';
import { transformPluginFile } from './pluginHost.ts';
import { budget, jobs, WorkerPool } from './pool.ts';
import type { PropertyOutcome } from './propertyRun.ts';
import { decodeExample } from './regressions.ts';
import { normal, type GuardConfig } from './sandboxGuard.ts';
import { sealedFiles } from './seal.ts';
import { nearestTsconfig } from './tsconfigResolve.ts';
import type { Plan } from './plan.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

/** The permission flag this Node has, or undefined when it has none (before Node 20). */
export function permissionFlag(version: string = process.versions.node): string | undefined {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  // `--permission` is the stable name from 22.13 and 23.5; earlier versions that have the model call it experimental.
  if (major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13)) return '--permission';
  return major >= 20 ? '--experimental-permission' : undefined;
}

/** Whether the module guard can cover `import` as well as `require`: synchronous loader hooks came in 22.15 and 23.5. */
export function hasLoaderHooks(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 15);
}

let warned = false;

/**
 * Whether laws run in the sandbox for these options. Fails closed: a Node that cannot enforce the permission model is an
 * error, not a quiet fallback, and `sandbox: false` (`--no-sandbox`) is the explicit way out and says what it gives up.
 */
export function useSandbox(options: Pick<CheckOptions, 'sandbox'>, version: string = process.versions.node): boolean {
  if (options.sandbox === false) {
    if (!warned) {
      warned = true;
      process.stderr.write(
        'tslaws: warning: --no-sandbox: laws run with full access to this machine (files, processes and network). ' +
          'Use it only for laws and helpers you wrote or reviewed.\n',
      );
    }
    return false;
  }
  // Both are needed: the permission model is the fence, and the hooks keep an `import()` inside the reviewed set.
  if (permissionFlag(version) === undefined || !hasLoaderHooks(version))
    throw new Error(
      `tslaws runs laws in a sandbox built on Node's permission model and loader hooks, which need Node 22.15, 23.5 or later (this is Node ${version}). ` +
        'Upgrade Node, or pass --no-sandbox to run the laws with full access to this machine.',
    );
  return true;
}

let warnedE2e = false;

/** Says once that end-to-end laws are running outside the sandbox because the person allowed it. */
export function warnE2e(): void {
  if (warnedE2e) return;
  warnedE2e = true;
  process.stderr.write(
    'tslaws: warning: --allow-e2e: end-to-end laws run outside the sandbox, with full access to this machine ' +
      '(files, processes and network). Use it only for laws and helpers you wrote or reviewed.\n',
  );
}

/** Only these of the parent's own flags reach the process: resource limits and TypeScript support, never code loaders. */
const keptFlag =
  /^--(experimental-strip-types|experimental-transform-types|no-experimental-strip-types|max-old-space-size=\d+|max-semi-space-size=\d+|stack-size=\d+)$/;

/**
 * The packages' trees: every `node_modules` above `from`, and the trees its symlinks (workspace packages) point to. A
 * workspace links the project being checked into the root `node_modules` as well; that tree is the project, whose files
 * are reviewed one by one, so it is not a package here (and neither is a tree inside it).
 */
function modulesAbove(from: string, project: string): { modules: string[]; linked: string[] } {
  const modules: string[] = [];
  const linked: string[] = [];
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const modulesDir = join(dir, 'node_modules');
    if (existsSync(modulesDir)) {
      modules.push(modulesDir);
      const scan = (parent: string, entries: import('node:fs').Dirent[]): void => {
        for (const entry of entries) {
          const path = join(parent, entry.name);
          if (entry.isSymbolicLink()) {
            try {
              const target = realpathSync(path);
              const isProject =
                project === target || project.startsWith(target + sep) || target.startsWith(project + sep);
              if (!target.startsWith(modulesDir) && !isProject) linked.push(target);
            } catch {
              // A link that points nowhere loads nothing.
            }
          } else if (entry.isDirectory() && entry.name.startsWith('@'))
            scan(path, readdirSync(path, { withFileTypes: true }));
        }
      };
      scan(modulesDir, readdirSync(modulesDir, { withFileTypes: true }));
    }
    if (dirname(dir) === dir) return { modules, linked };
  }
}

const realOf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The tslaws package: `src` or `dist` sits directly under it. */
const tslawsRoot = fileURLToPath(new URL('../', import.meta.url));
/** What of it the process loads: its code and its `package.json`, not whatever else sits in the package directory. */
const tslawsCode = [join(tslawsRoot, 'dist'), join(tslawsRoot, 'src'), join(tslawsRoot, 'package.json')];

/** The `--allow-fs-read` paths: the project, its `node_modules`, the tslaws package, and the trees workspace links lead to. */
export function readableBy(cwd: string, extra: string[] = []): string[] {
  const here = modulesAbove(cwd, resolve(cwd));
  const there = modulesAbove(tslawsRoot, resolve(cwd));
  return [
    ...new Set([
      resolve(cwd),
      ...tslawsCode,
      ...here.modules,
      ...here.linked,
      ...there.modules,
      ...there.linked,
      ...extra,
    ]),
  ];
}

/** The flags that make a process a sandbox, for a project at `cwd`. */
export function sandboxFlags(cwd: string, extra: string[] = []): string[] {
  const flag = permissionFlag();
  if (flag === undefined) throw new Error('this Node has no permission model');
  return [
    flag,
    ...readableBy(cwd, extra).map((path) => `--allow-fs-read=${path}`),
    '--disallow-code-generation-from-strings',
    '--no-warnings',
    ...process.execArgv.filter((flagged) => keptFlag.test(flagged)),
  ];
}

const tsFamily = /\.[cm]?tsx?$/;

/**
 * The files a law may load besides the build: the entries (what was compiled) and everything the seals of the laws cover,
 * which is what the lock digests (see seal.ts): each laws file, and every module it imports, transitively, including files
 * outside the project and workspace sources. A path computed at run time is not among them, so the guard refuses it.
 */
export function reviewedFiles(cwd: string, entries: string[], laws: ManifestLaw[]): string[] {
  const covered = sealedFiles(cwd, laws);
  return [...new Set([...entries.map((file) => resolve(cwd, file)), ...covered])].filter((file) => existsSync(file));
}

/** The directories a manifest's `workspaces` name (`packages/*`, `apps/web`), as absolute paths. */
function workspaceDirs(dir: string): string[] {
  const field = readManifest(join(dir, 'package.json'))?.workspaces;
  const list = Array.isArray(field) ? field : (field as { packages?: unknown } | undefined)?.packages;
  if (!Array.isArray(list)) return [];
  const found: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue;
    const star = entry.search(/[*?{[]/);
    if (star < 0) {
      found.push(resolve(dir, entry));
      continue;
    }
    // `packages/*` and `packages/**`: the directories directly under the fixed part.
    const base = resolve(dir, entry.slice(0, star).replace(/[\\/][^\\/]*$/, '') || '.');
    try {
      for (const child of readdirSync(base, { withFileTypes: true }))
        if (child.isDirectory() && !child.name.startsWith('.')) found.push(join(base, child.name));
    } catch {
      // A pattern that matches nothing names nothing.
    }
  }
  return found;
}

/** The directories the project's tsconfig sends module resolution to: its `paths` targets, `baseUrl` and `references`. */
function tsconfigDirs(cwd: string): string[] {
  const config = nearestTsconfig(cwd);
  const dirs: string[] = [];
  const options = runtimeOf(cwd)?.options as { paths?: Record<string, unknown>; baseUrl?: unknown } | undefined;
  for (const targets of Object.values(options?.paths ?? {}))
    for (const target of Array.isArray(targets) ? targets : [])
      if (typeof target === 'string') dirs.push(resolve(cwd, target.replace(/[\\/]?\*.*$/, '') || '.'));
  if (typeof options?.baseUrl === 'string') dirs.push(resolve(cwd, options.baseUrl));
  if (config !== undefined) {
    const references = ts.readConfigFile(config, ts.sys.readFile).config?.references;
    for (const reference of Array.isArray(references) ? references : []) {
      const path = (reference as { path?: unknown } | null)?.path;
      if (typeof path === 'string') dirs.push(resolve(dirname(config), path.replace(/tsconfig[^\\/]*\.json$/, '')));
    }
  }
  return dirs;
}

const isInside = (dir: string, file: string): boolean => {
  const rel = relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** The path as the file system has it: links followed, and the case Windows and macOS keep. Itself when it does not exist. */
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Paths compare in one case on a file system that ignores it. */
const folds = process.platform === 'win32' || process.platform === 'darwin' || !ts.sys.useCaseSensitiveFileNames;
const fold = (path: string): string => (folds ? path.toLowerCase() : path);

/**
 * The first part of `path` that is a dotfile or a dot directory. A path inside the project is judged below the project,
 * which is readable already wherever it sits. Any other path is judged below the home directory, or in full when it is not
 * under it: what it shares with the project's own path says nothing about it (`~/.work/secret` beside `~/.work/proj`).
 */
function dottedBelow(path: string, project: string): string | undefined {
  const home = real(homedir());
  const base = isInside(fold(project), fold(path)) ? project : isInside(fold(home), fold(path)) ? home : undefined;
  const parts = path.split(/[/\\]/);
  const skip = base === undefined ? 0 : base.split(/[/\\]/).length;
  return parts.slice(skip).find((part) => part.startsWith('.'));
}

/**
 * Why the sandbox may not read below `root` (as the file system names it), or undefined when it may: a file system root,
 * the home directory or a directory above it, or a place named by a dot (`~/.ssh`, `~/.config`). A root inside the project is
 * judged below the project (it is readable already); any other root below the home directory (or in full).
 */
function unreadableRoot(root: string, project: string): string | undefined {
  if (dirname(root) === root) return 'is the root of a file system';
  const home = real(homedir());
  const toHome = relative(fold(root), fold(home));
  if (toHome === '' || (toHome !== '..' && !toHome.startsWith(`..${sep}`) && !isAbsolute(toHome)))
    return 'is the home directory or a directory above it';
  const dotted = dottedBelow(root, project);
  return dotted === undefined ? undefined : `sits in ${dotted}, a dotfile`;
}

/** What `grantOutside` told the person already, so a project that is checked again is not told again. */
const told = new Set<string>();
const tell = (line: string): void => {
  if (told.has(line)) return;
  told.add(line);
  process.stderr.write(`tslaws: ${line}\n`);
};

/**
 * The files of the reviewed set outside the project that the law process may read, by name. Only these are granted: the
 * packages of the workspace (a `workspaces` field of the root `package.json`), the `paths`, `baseUrl` and `references`
 * targets of the tsconfig, and the directories the person lists under `sandboxReads` in tslaws.json (the declared
 * dependencies already sit in the `node_modules` trees). A dotfile, the home directory and a file system root are refused,
 * as is any other file; each grant and each refusal is printed once.
 */
export function grantOutside(cwd: string, outside: string[]): { granted: string[]; refused: string[] } {
  const roots: [string, string][] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const workspace of workspaceDirs(dir)) roots.push([workspace, 'a workspace package']);
    if (dirname(dir) === dir) break;
  }
  for (const dir of tsconfigDirs(cwd)) roots.push([dir, 'a target of the tsconfig']);
  for (const path of readConfig(cwd).sandboxReads ?? [])
    roots.push([resolve(cwd, path), '"sandboxReads" in tslaws.json']);
  const project = real(cwd);
  const places = roots.map(([root, why]) => ({ root: real(root), why }));
  const granted: string[] = [];
  const refused: string[] = [];
  for (const file of outside) {
    // What counts is where the file really is, so a link cannot lead from a named directory to a place that is not.
    const actual = real(file);
    const named = places.filter(({ root }) => isInside(fold(root), fold(actual)));
    const dotted = dottedBelow(actual, project);
    const hit =
      dotted === undefined ? named.find(({ root }) => unreadableRoot(root, project) === undefined) : undefined;
    if (hit !== undefined) {
      granted.push(file);
      tell(`the law sandbox may read ${file} (${hit.why})`);
      continue;
    }
    refused.push(file);
    const [first] = [...named].sort((a, b) => b.root.length - a.root.length);
    const why =
      first === undefined
        ? undefined
        : `${first.root} ${unreadableRoot(first.root, project) ?? `holds ${dotted}, a dotfile`}`;
    tell(
      `the law sandbox may not read ${file}${why === undefined ? '' : ` (${why})`}; ` +
        'to allow it, name its directory under "sandboxReads" in tslaws.json',
    );
  }
  return { granted, refused };
}

/** The dependency fields of a manifest that name packages the code may load. */
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

function readManifest(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const namesOf = (manifest: Record<string, unknown> | undefined, fields: readonly string[]): string[] =>
  fields.flatMap((field) => {
    const value = manifest?.[field];
    return typeof value === 'object' && value !== null ? Object.keys(value) : [];
  });

const trustedPackagesCache = new Map<
  string,
  { stamps: [string, number, number][]; value: { modules: string[]; linked: string[] } }
>();

function manifestStamp(dir: string): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml']) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      out.push([p, st.size, st.mtimeMs]);
    } catch {
      out.push([p, -1, -1]);
    }
  }
  return out;
}

function stampsMatch(stamps: [string, number, number][]): boolean {
  for (const [p, size, mtimeMs] of stamps) {
    try {
      const st = statSync(p);
      if (st.size !== size || st.mtimeMs !== mtimeMs) return false;
    } catch {
      if (size !== -1 || mtimeMs !== -1) return false;
    }
  }
  return true;
}

/**
 * The packages the code may load: those the manifests declare (the project's `package.json` with its dev dependencies,
 * and tslaws's own) and, from each one's manifest, what it declares in turn. Anything else in a `node_modules` was put
 * there by something else, and is not trusted. A package that is a link to a directory outside `node_modules` (a workspace
 * package) is source: its tree is trusted as a tree. The project itself is not a package; its files are reviewed one by one.
 */
export function trustedPackages(cwd: string): { modules: string[]; linked: string[] } {
  const project = realOf(resolve(cwd));
  const cached = trustedPackagesCache.get(project);
  if (cached !== undefined && stampsMatch(cached.stamps)) return cached.value;
  const stamps = [...manifestStamp(project), ...manifestStamp(tslawsRoot)];
  const modules = new Set<string>();
  const linked = new Set<string>();
  const seen = new Set<string>();
  const find = (name: string, from: string): string | undefined => {
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realOf(candidate);
      if (dirname(dir) === dir) return undefined;
    }
  };
  const visit = (name: string, from: string): void => {
    const dir = find(name, from);
    if (dir === undefined || seen.has(dir)) return;
    seen.add(dir);
    if (/[\\/]node_modules[\\/]/.test(dir)) modules.add(normal(dir));
    // The project's own files are reviewed one by one (through the seals), not as a tree.
    else if (dir === project || dir.startsWith(project + sep)) return;
    else linked.add(dir);
    for (const next of namesOf(readManifest(join(dir, 'package.json')), dependencyFields)) visit(next, dir);
  };
  const manifests: [string, readonly string[]][] = [
    [project, [...dependencyFields, 'devDependencies']],
    [tslawsRoot, dependencyFields],
  ];
  for (const [dir, fields] of manifests)
    for (const name of namesOf(readManifest(join(dir, 'package.json')), fields)) visit(name, dir);
  const value = { modules: [...modules], linked: [...linked] };
  if (trustedPackagesCache.size > 256) trustedPackagesCache.clear();
  trustedPackagesCache.set(project, { stamps, value });
  return value;
}

/** Everything the process needs to know about the reviewed set, built once per check after the build. */
export interface HostConfig {
  guard: GuardConfig;
  transforms: Record<string, Prepared>;
  /** Files outside the project root the process must be allowed to read. */
  outside: string[];
  /** Tells two configurations apart. */
  key: string;
}

/**
 * The reviewed set of a project after a build: the build's output, the files its laws reach, the packages, and the
 * transformed text of what needs transforming. `outDir` is where the build wrote the output of `cwd`.
 */
export function hostConfig(cwd: string, entries: string[], outDir: string, laws: ManifestLaw[]): HostConfig {
  const files = reviewedFiles(cwd, entries, laws);
  // What the process cannot read already (outside the project and outside the trees it is given) needs a grant, by name.
  const trees = readableBy(cwd);
  const { granted } = grantOutside(
    cwd,
    files.filter((file) => !trees.some((tree) => file === tree || isInside(tree, file))),
  );
  const base = join(cwd, '.tslaws', 'out');
  const trusted = trustedPackages(cwd);
  const guard: GuardConfig = {
    trees: [base],
    files,
    packages: [...tslawsCode, ...trusted.linked],
    modules: trusted.modules,
  };
  const plugins = runtimeOf(cwd)?.bundlerPlugins ?? [];
  const transforms: HostConfig['transforms'] = {};
  const attempt = (key: string, make: () => string): void => {
    try {
      transforms[key] = { code: make() };
    } catch (error) {
      transforms[key] = { error: error instanceof Error ? error.message : String(error) };
    }
  };
  const modules = files.some((file) => /\.m[jt]s$/.test(file));
  for (const file of files) {
    const at = normal(file);
    const extension = extname(file);
    if (pluginExtensionNeeded(extension)) {
      attempt(`cjs:${at}`, () => transformPluginFile(file, cwd, plugins, 'cjs'));
      if (modules) attempt(`esm:${at}`, () => transformPluginFile(file, cwd, plugins, 'esm'));
    } else if (tsFamily.test(file)) {
      // A file the build compiled loads from its output; only one it left alone loads as source.
      const compiled = resolve(outDir, relative(cwd, file)).replace(/\.[cm]?tsx?$/, '.js');
      if (!existsSync(compiled)) attempt(`ts:${at}`, () => transformSource(file, extension));
    }
  }
  // The text of the transforms is part of the key: a process keeps what it was configured with, so edited source needs a new one.
  const key = createHash('sha256')
    .update(JSON.stringify([guard, transforms]))
    .digest('hex');
  return { guard, transforms, outside: granted, key };
}

// ---- the process -----------------------------------------------------------------------------------------------------

/** A law could not be loaded: the compiled module is missing, does not export the law, or loads something unreviewed. */
export class LawLoadError extends Error {}

/** The largest text taken from a process, and the other limits `readOutcome` holds a reply to. */
const longest = { text: 20_000, encoded: 200_000, runs: 1_000_000_000 };

/**
 * A property outcome as plain data, or an error. The process runs the law, so its answer is the law's claim and nothing
 * more: each field is rebuilt from what is checked here, anything else is dropped, and a counterexample that the corpus
 * could not read back is not kept.
 */
export function readOutcome(value: unknown): PropertyOutcome {
  const fail = (why: string): never => {
    throw new Error(`the law process sent an answer that is not valid: ${why}`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('the outcome is not an object');
  const o = value as Record<string, unknown>;
  const text = (input: unknown, what: string, max: number): string | undefined => {
    if (input === undefined) return undefined;
    if (typeof input !== 'string') return fail(`${what} is not text`);
    if (input.length > max) return fail(`${what} is longer than ${max} characters`);
    return input;
  };
  if (typeof o.failed !== 'boolean') return fail('failed is not a boolean');
  if (typeof o.numRuns !== 'number' || !Number.isSafeInteger(o.numRuns) || o.numRuns < 0 || o.numRuns > longest.runs)
    return fail('numRuns is not a whole number');
  // A seed may be negative (a 32-bit signed integer).
  if (typeof o.seed !== 'number' || !Number.isSafeInteger(o.seed)) return fail('seed is not a whole number');
  const outcome: PropertyOutcome = { failed: o.failed, numRuns: o.numRuns, seed: o.seed };
  const counterexample = text(o.counterexample, 'the counterexample', longest.text);
  const message = text(o.message, 'the message', longest.text);
  const stack = text(o.stack, 'the stack', longest.text);
  const encoded = text(o.encoded, 'the encoded counterexample', longest.encoded);
  if (counterexample !== undefined) outcome.counterexample = counterexample;
  if (message !== undefined) outcome.message = message;
  if (stack !== undefined) outcome.stack = stack;
  if (encoded !== undefined) {
    try {
      decodeExample(encoded);
      outcome.encoded = encoded;
    } catch {
      // Not something the corpus can replay: the failure is still reported, it is just not stored.
    }
  }
  if (outcome.encoded !== undefined && typeof o.regression === 'boolean') outcome.regression = o.regression;
  return outcome;
}

const hostFile = new URL(`./lawHost${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);

type Run = Extract<HostRequest, { type: 'run' }>;
type Holds = Extract<HostRequest, { type: 'holds' }>;
/** A request as the caller makes it; the process adds the token. */
type Body = Omit<Run, 'token'> | Omit<Holds, 'token'>;

/** A flag-restricted child that serves one request at a time (the pool hands it to one caller at once). */
class LawProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (reply: HostReply) => void; reject: (error: Error) => void }>();
  private next = 1;
  configKey: string | undefined;
  /** Answers only requests that carry it. The process learns it from `configure` and no law can read it. */
  private readonly token = randomBytes(24).toString('hex');

  constructor(flags: string[]) {
    this.child = fork(hostFile, [], {
      // The allowlisted environment the token-free check process gets (see isolate.ts): no credential, no code loader.
      env: scrubbedEnv(process.env),
      execArgv: flags,
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    // Neither the process nor its channel may keep the caller alive once the laws are done.
    this.child.unref();
    this.child.channel?.unref();
    this.child.on('message', (reply: unknown) => {
      const id = (reply as { id?: unknown } | null)?.id;
      const waiting = typeof id === 'number' ? this.pending.get(id) : undefined;
      if (waiting === undefined) return;
      this.pending.delete(id as number);
      waiting.resolve(reply as HostReply);
    });
    const ended = (why: string): void => {
      for (const waiting of this.pending.values()) waiting.reject(new Error(why));
      this.pending.clear();
    };
    this.child.on('error', (error) => ended(`the law process could not run: ${error.message}`));
    this.child.on('exit', (code, signal) =>
      ended(`the law process ended without an answer (${signal ?? `exit ${code}`})`),
    );
  }

  /** Fixes what this process may load, once: it takes no second `configure`, so a changed set needs a new process. */
  configure(config: HostConfig): void {
    if (this.configKey !== undefined) {
      if (this.configKey !== config.key) throw new Error('a law process is configured once');
      return;
    }
    this.configKey = config.key;
    this.child.send({
      type: 'configure',
      token: this.token,
      guard: config.guard,
      transforms: config.transforms,
    } satisfies HostRequest);
  }

  request(make: (id: number) => Body): Promise<HostReply> {
    const id = this.next++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.child.send({ ...make(id), token: this.token } as HostRequest, (error) => {
        if (error !== null) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  terminate(): void {
    this.child.channel?.unref();
    // Not the default SIGTERM: a law that handles it and then spins would never see it run, and would outlive the check.
    this.child.kill('SIGKILL');
  }
}

const pools = new Map<string, { cwd: string; pool: WorkerPool<LawProcess> }>();

/** How long a law process may sit unused before it ends. */
const idleMs = 5000;

/** The law processes alive now, across every project. */
export function liveSandboxProcesses(): number {
  let live = 0;
  for (const { pool } of pools.values()) live += pool.live;
  return live;
}

/**
 * Makes room for a process about to start: the cap is shared by every project, not held by each, so an idle process of
 * another project (or configuration) ends when the budget is already spent. The pool counts the new one before it starts.
 */
function startProcess(flags: string[]): LawProcess {
  const cap = jobs();
  for (const { pool } of pools.values()) {
    if (liveSandboxProcesses() <= cap) break;
    while (liveSandboxProcesses() > cap && pool.evictOne());
  }
  return new LawProcess(flags);
}

function poolFor(cwd: string, extra: string[]): WorkerPool<LawProcess> {
  const key = JSON.stringify([resolve(cwd), extra]);
  let entry = pools.get(key);
  if (entry === undefined) {
    // Compute permission flags once per pool instead of re-walking node_modules for every forked process.
    const flags = sandboxFlags(cwd, extra);
    entry = {
      cwd: resolve(cwd),
      pool: new WorkerPool(() => startProcess(flags), jobs, idleMs),
    };
    pools.set(key, entry);
  }
  return entry.pool;
}

/** Ends the idle law processes of a project and of any project below it, for a scratch copy about to be deleted. */
export function releaseSandbox(cwd: string): void {
  const top = resolve(cwd);
  for (const [key, { cwd: at, pool }] of pools)
    if (at === top || at.startsWith(top + sep)) {
      pool.close();
      pools.delete(key);
    }
}

/** Starts `n` law processes ahead of the first law, so they load while the code compiles. */
export function warmSandbox(cwd: string, n: number): void {
  const pool = poolFor(cwd, []);
  // The cap is shared: this project may warm only what the other projects have left.
  pool.warm(Math.min(n, jobs() - (liveSandboxProcesses() - pool.live)));
}

/** What a sandboxed run of a law came to: the outcome and whether the law is async (the prover cannot model an await). */
export interface SandboxedRun {
  outcome: PropertyOutcome;
  async: boolean;
}

/** Runs laws and replays inputs in sandboxed processes for one project, under one reviewed set. */
export class Sandbox {
  private readonly pool: WorkerPool<LawProcess>;
  private readonly config: HostConfig;
  private readonly cwd: string;

  constructor(cwd: string, config: HostConfig) {
    this.cwd = cwd;
    this.config = config;
    // The files of the reviewed set that sit outside the project (reached through `paths`) are readable by name, and no more.
    this.pool = poolFor(cwd, config.outside);
  }

  /** Sends one request to a process of its own, and gives up on it after `timeoutMs`. */
  private ask(timeoutMs: number, make: (id: number) => Body): Promise<HostReply | 'timeout'> {
    // A law process is a slot of the budget while it works; under the law that asked for it, that is the law's own slot.
    return budget.run(() => this.askOnce(timeoutMs, make));
  }

  private async askOnce(timeoutMs: number, make: (id: number) => Body): Promise<HostReply | 'timeout'> {
    let current = await this.pool.acquire();
    // A process that was configured for another reviewed set (an earlier check) is not reused: it takes no second configure.
    while (current.configKey !== undefined && current.configKey !== this.config.key) {
      this.pool.discard(current);
      current = await this.pool.acquire();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      current.configure(this.config);
      const timeout = new Promise<'timeout'>((done) => {
        timer = setTimeout(() => done('timeout'), timeoutMs);
      });
      const reply = await Promise.race([current.request(make), timeout]);
      if (reply === 'timeout') this.pool.discard(current);
      else this.pool.release(current);
      return reply;
    } catch (error) {
      this.pool.discard(current);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The property test of `law`, `'timeout'` when it does not finish; throws `LawLoadError` when it cannot be loaded. */
  async run(
    outDir: string,
    law: ManifestLaw,
    options: CheckOptions,
    plans: Plan[],
    buildKey?: string,
  ): Promise<SandboxedRun | 'timeout'> {
    const reply = await this.ask(options.propertyTimeoutMs ?? 30000, (id) => ({
      type: 'run',
      id,
      outDir,
      law,
      plans,
      // Functions cannot cross to the process; it needs only the numbers.
      options: { ...options, onEvent: undefined },
      env: lawEnv(options.cwd, 'node'),
      buildKey,
    }));
    if (reply === 'timeout') return reply;
    if ('error' in reply) {
      if (typeof reply.error !== 'string' || reply.error.length > longest.text)
        throw new Error('the law process sent an error that is not valid');
      throw reply.phase === 'load' ? new LawLoadError(reply.error) : new Error(reply.error);
    }
    if (!('outcome' in reply) || typeof reply.async !== 'boolean')
      throw new Error('the law process sent an answer that is not valid');
    return { outcome: readOutcome(reply.outcome), async: reply.async };
  }

  /**
   * Whether the law holds on `inputs` (a model the prover found), as the prover's replay needs it. A law that hangs or
   * cannot be loaded counts as holding: the model is then not confirmed, and nothing is reported as refuted.
   */
  async holds(outDir: string, law: ManifestLaw, inputs: unknown[], timeoutMs: number): Promise<boolean> {
    const reply = await this.ask(timeoutMs, (id) => ({
      type: 'holds',
      id,
      outDir,
      law,
      inputs,
      env: lawEnv(this.cwd, 'node'),
    }));
    return reply === 'timeout' || 'error' in reply || !('holds' in reply) || reply.holds !== false;
  }
}
