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
// (browser laws run in the page, behind the browser's own boundary). `--no-sandbox` turns it all off, with a warning.
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import nodeModule from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { lawEnv } from './coverage.ts';
import { runtimeSpecifiers } from './lawKinds.ts';
import type { HostReply, HostRequest, Prepared } from './lawHost.ts';
import { runtimeOf, transformSource } from './lawRuntime.ts';
import { pluginExtensionNeeded } from './pluginHooks.ts';
import { transformPluginFile } from './pluginHost.ts';
import { jobs, WorkerPool } from './pool.ts';
import type { PropertyOutcome } from './propertyRun.ts';
import { decodeExample } from './regressions.ts';
import { normal, type GuardConfig } from './sandboxGuard.ts';
import { resolutionCompilerOptions } from './tsconfigResolve.ts';
import type { Plan } from './plan.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

/** The permission flag this Node has, or undefined when it has none (before Node 20). */
export function permissionFlag(version: string = process.versions.node): string | undefined {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  // `--permission` is the stable name from 22.13 and 23.5; earlier versions that have the model call it experimental.
  if (major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13)) return '--permission';
  return major >= 20 ? '--experimental-permission' : undefined;
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
  if (permissionFlag(version) === undefined)
    throw new Error(
      `tslaws runs laws in a sandbox built on Node's permission model, which needs Node 20 or later (this is Node ${version}). ` +
        'Upgrade Node, or pass --no-sandbox to run the laws with full access to this machine.',
    );
  return true;
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

const sourceFamily = /\.[cm]?[jt]sx?$/;
const tsFamily = /\.[cm]?tsx?$/;

/**
 * The files a law may load besides the build: the entries, and every project file they reach by an import or `require`
 * that TypeScript can resolve, or that is a relative path to a file (a template, a stylesheet). Packages are not walked:
 * they are reviewed as packages. A path computed at run time is not here, so the guard refuses it.
 */
export function reviewedFiles(cwd: string, entries: string[]): string[] {
  const runtime = runtimeOf(cwd);
  const options: ts.CompilerOptions = {
    ...resolutionCompilerOptions(runtime?.options),
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };
  const seen = new Set<string>();
  const queue = entries.map((file) => resolve(cwd, file));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    if (!sourceFamily.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { value } of runtimeSpecifiers(text, file)) {
      if (nodeModule.isBuiltin(value)) continue;
      const found = ts.resolveModuleName(value, file, options, ts.sys).resolvedModule;
      // A workspace package resolves to its real path, so its TypeScript source counts as the project's own.
      const source = found?.resolvedFileName;
      if (source !== undefined && !/\.d\.[cm]?ts$/.test(source) && !/[\\/]node_modules[\\/]/.test(source)) {
        queue.push(resolve(source));
      } else if (found === undefined && value.startsWith('.')) queue.push(resolve(dirname(file), value));
    }
  }
  return [...seen];
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
export function hostConfig(cwd: string, entries: string[], outDir: string): HostConfig {
  const files = reviewedFiles(cwd, entries);
  const base = join(cwd, '.tslaws', 'out');
  const here = modulesAbove(cwd, resolve(cwd));
  const there = modulesAbove(tslawsRoot, resolve(cwd));
  const guard: GuardConfig = {
    trees: [base],
    files,
    packages: [...tslawsCode, ...here.modules, ...here.linked, ...there.modules, ...there.linked],
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
  const outside = files.filter((file) => relative(resolve(cwd), file).startsWith('..'));
  return { guard, transforms, outside, key: JSON.stringify([guard, Object.keys(transforms)]) };
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

/** A flag-restricted child that serves one request at a time (the pool hands it to one caller at once). */
class LawProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (reply: HostReply) => void; reject: (error: Error) => void }>();
  private next = 1;
  configKey: string | undefined;

  constructor(cwd: string, extra: string[]) {
    // The environment may not load code into the process; resource limits stay.
    const env = { ...process.env };
    const kept = (env.NODE_OPTIONS ?? '').split(/\s+/).filter((flag) => keptFlag.test(flag));
    if (kept.length > 0) env.NODE_OPTIONS = kept.join(' ');
    else delete env.NODE_OPTIONS;
    this.child = fork(hostFile, [], {
      env,
      execArgv: sandboxFlags(cwd, extra),
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

  configure(config: HostConfig): void {
    if (this.configKey === config.key) return;
    this.configKey = config.key;
    this.child.send({ type: 'configure', guard: config.guard, transforms: config.transforms } satisfies HostRequest);
  }

  request(make: (id: number) => HostRequest): Promise<HostReply> {
    const id = this.next++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.child.send(make(id), (error) => {
        if (error !== null) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  terminate(): void {
    this.child.channel?.unref();
    this.child.kill();
  }
}

const pools = new Map<string, { cwd: string; pool: WorkerPool<LawProcess> }>();

function poolFor(cwd: string, extra: string[]): WorkerPool<LawProcess> {
  const key = JSON.stringify([resolve(cwd), extra]);
  let entry = pools.get(key);
  if (entry === undefined) {
    entry = { cwd: resolve(cwd), pool: new WorkerPool(() => new LawProcess(cwd, extra)) };
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
  poolFor(cwd, []).warm(Math.min(n, jobs()));
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
    this.pool = poolFor(cwd, []);
  }

  /** Sends one request to a process of its own, and gives up on it after `timeoutMs`. */
  private async ask(timeoutMs: number, make: (id: number) => HostRequest): Promise<HostReply | 'timeout'> {
    const current = await this.pool.acquire();
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
  async run(outDir: string, law: ManifestLaw, options: CheckOptions, plans: Plan[]): Promise<SandboxedRun | 'timeout'> {
    const reply = await this.ask(options.propertyTimeoutMs ?? 30000, (id) => ({
      type: 'run',
      id,
      outDir,
      law,
      plans,
      // Functions cannot cross to the process; it needs only the numbers.
      options: { ...options, onEvent: undefined },
      env: lawEnv(options.cwd, 'node'),
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
