// The reviewed set, as a rule about module loading. A sandboxed law process (lawHost.ts) runs inside Node's permission
// model, which stops what the process can do to the machine; this decides what code it may load at all. Anything a
// resolve step names that is outside the set is refused before it is read: a file nobody reviewed (a proposal that was
// not passed, a helper the law reaches by a computed path), a `data:` or network URL, and a Node module a law has no
// use for (`child_process`, `net`, `vm`, `module`, ...). The permission model is the hard fence; this one makes a
// refusal a plain error with the reason, and keeps an unreviewed file from running even where it could be read.
import nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';

/** What the parent decided is reviewed. Every path is absolute, with forward slashes. */
export interface GuardConfig {
  /** Trees of code the build wrote from reviewed files (`.tslaws/out`). */
  trees: string[];
  /** Single files: the laws files, the files their seals cover and the project files they import. */
  files: string[];
  /** Trees of trusted code outside `node_modules`: the tslaws package and workspace packages the project declares. */
  packages: string[];
  /** The package directories under `node_modules` that the manifests of the project and of tslaws declare. */
  modules: string[];
}

/** The Node modules the code of a law and of the project may load: no files, processes, sockets, code or threads. */
export const lawBuiltins: readonly string[] = [
  'assert',
  'assert/strict',
  'buffer',
  'crypto',
  'events',
  'path',
  'path/posix',
  'path/win32',
  'punycode',
  'querystring',
  'string_decoder',
  'timers',
  'timers/promises',
  'url',
  'util',
  'util/types',
];

/**
 * What a declared package may load as well: it reads its own files and may use the usual helpers. Never `module` (the
 * loader's own internals; see `builtin` for tslaws's own files) or `process`, and none of what starts a process, a
 * thread or a socket.
 */
export const packageBuiltins: readonly string[] = [
  ...lawBuiltins,
  'async_hooks',
  'console',
  'constants',
  'diagnostics_channel',
  'fs',
  'fs/promises',
  'os',
  'perf_hooks',
  'stream',
  'stream/promises',
  'tty',
  'zlib',
];

const refusal = (what: string, why: string): Error =>
  Object.assign(new Error(`tslaws sandbox: ${what} ${why}`), { code: 'ERR_TSLAWS_SANDBOX' });

/** A path as the guard compares it: forward slashes, and no case on Windows. */
export function normal(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

const within = (path: string, tree: string): boolean =>
  path === tree || path.startsWith(tree.endsWith('/') ? tree : `${tree}/`);

/** The package directory a file under `node_modules` belongs to (`.../node_modules/@scope/name`), if it is under one. */
export function packageDirOf(path: string): string | undefined {
  const marker = '/node_modules/';
  const at = path.lastIndexOf(marker);
  if (at < 0) return undefined;
  const start = at + marker.length;
  const parts = path.slice(start).split('/');
  const name = parts.slice(0, parts[0]?.startsWith('@') ? 2 : 1).join('/');
  return name === '' ? undefined : path.slice(0, start) + name;
}

// What the guard needs from V8 is taken once, before any law code runs, so a law that replaces `Error.captureStackTrace`
// or the `Error` global cannot change what the guard sees.
const ErrorClass = Error;
const captureStackTrace = Error.captureStackTrace.bind(Error);
const selfPath = normal(fileURLToPath(import.meta.url));
/** tslaws's own code (`dist` or `src`, not the rest of the package directory): it alone may read `module.builtinModules`. */
const selfRoot = selfPath.slice(0, selfPath.lastIndexOf('/'));

/**
 * The files that are really asking: every frame of the call stack that is neither Node's own nor this file, closest
 * first. A `parent` handed to `Module._load` is the caller's claim (`module.constructor._load('fs', { filename })` makes
 * any), so the stack, which the caller cannot write, decides. All frames count, not the closest: a trusted package that a
 * law calls must not vouch for what the law asked it to load.
 */
function callerFiles(): string[] {
  const limit = ErrorClass.stackTraceLimit;
  const prepare = ErrorClass.prepareStackTrace;
  ErrorClass.stackTraceLimit = 100;
  ErrorClass.prepareStackTrace = (_error, sites) => sites;
  let sites: NodeJS.CallSite[] = [];
  try {
    const holder: { stack?: unknown } = {};
    captureStackTrace(holder, callerFiles);
    sites = (holder.stack as NodeJS.CallSite[] | undefined) ?? [];
  } finally {
    ErrorClass.prepareStackTrace = prepare;
    ErrorClass.stackTraceLimit = limit;
  }
  const files: string[] = [];
  for (const site of sites) {
    const name = site.getFileName();
    if (typeof name !== 'string' || name === '' || name.startsWith('node:')) continue;
    const path = name.startsWith('file:') ? fileURLToPath(name) : name;
    if (normal(path) === selfPath) continue;
    files.push(path);
  }
  return files;
}

/** The rule: what may be loaded, and by whom. */
export class Guard {
  private trees: string[] = [];
  private packages: string[] = [];
  private modules = new Set<string>();
  private files = new Set<string>();
  private configured = false;

  /** Sets the reviewed set. Once: a second call (a forged message) changes nothing and throws. */
  configure(config: GuardConfig): void {
    if (this.configured) throw refusal('the reviewed set', 'is already fixed');
    this.configured = true;
    this.trees = config.trees.map(normal);
    this.packages = config.packages.map(normal);
    this.modules = new Set(config.modules.map(normal));
    this.files = new Set(config.files.map(normal));
  }

  /** Whether `path` is code of a trusted package: tslaws, or a package the manifests declare. */
  isPackageFile(path: string): boolean {
    if (this.packages.some((tree) => within(path, tree))) return true;
    const dir = packageDirOf(path);
    return dir !== undefined && this.modules.has(dir);
  }

  /**
   * Throws unless the Node module `request` may be loaded. The callers are the files on the call stack; `parent` is what
   * the loader says imports it (a `file:` URL or a path), consulted as well. The strictest wins: if any of them is a law or
   * project file the request is a law's, whatever package code sits between (a law that has a trusted helper `require`
   * `child_process` for it is refused).
   */
  builtin(request: string, parent?: string): void {
    const name = request.startsWith('node:') ? request.slice(5) : request;
    const declared = parent === undefined ? undefined : parent.startsWith('file:') ? fileURLToPath(parent) : parent;
    const frames = callerFiles();
    const callers = declared === undefined ? frames : [...frames, declared];
    const fromPackage = callers.length > 0 && callers.every((file) => this.isPackageFile(normal(file)));
    const asking = frames.find((file) => !this.isPackageFile(normal(file))) ?? frames[0];
    if ((fromPackage ? packageBuiltins : lawBuiltins).includes(name)) return;
    // tslaws itself asks what Node's modules are called (`builtinModules`, to tell a package from a built-in). The loader's
    // functions that could load anything are locked, so naming the module gives its caller nothing it could use.
    if (name === 'module' && callers.length > 0 && callers.every((file) => within(normal(file), selfRoot))) return;
    throw refusal(
      `"${request}"`,
      `is not a module a law may load${fromPackage ? '' : ' (allowed: ' + lawBuiltins.join(', ') + ')'}` +
        (asking === undefined ? '' : `; requested by ${asking}`) +
        (frames.length > 1 ? ` (call stack: ${frames.slice(0, 6).join(' <- ')})` : ''),
    );
  }

  /** Throws unless the file `path` is in the reviewed set. */
  file(path: string, request: string): void {
    const at = normal(path);
    if (this.files.has(at) || this.trees.some((tree) => within(at, tree)) || this.isPackageFile(at)) return;
    throw refusal(
      `"${request}" resolves to ${path}, which`,
      'is outside the reviewed set of files (the laws, what their seals cover, declared packages)',
    );
  }

  /** Checks one resolution: `request` as written, `resolved` as Node found it (a `file:` or `node:` URL, or a path). */
  resolved(request: string, resolved: string, parent?: string): void {
    if (resolved.startsWith('node:') || nodeModule.isBuiltin(resolved)) return this.builtin(resolved, parent);
    if (resolved.startsWith('file:')) return this.file(fileURLToPath(resolved), request);
    if (/^[a-z][a-z0-9+.-]+:/i.test(resolved) && !/^[a-z]:[\\/]/i.test(resolved))
      throw refusal(`"${request}"`, `resolves to ${resolved.slice(0, 40)}, which is not a file`);
    return this.file(resolved, request);
  }
}

type Parent = { filename?: string } | null | undefined;

const locked = (target: object, name: string, value: unknown): void => {
  Object.defineProperty(target, name, { value, writable: false, configurable: false });
};

/**
 * Puts the guard in front of every way a law can load a module: the CommonJS loader (`require`, `createRequire`,
 * `import()` compiled to `require`) and the synchronous hooks that cover `import` as well (Node 22.15, 23.5 or later, which
 * the sandbox requires). Then it closes the doors to the loader itself, so that law code can neither take the guard out
 * nor put a hook in front of it: the loader's functions and tables are made read-only, `registerHooks` and `register`
 * throw. `process.getBuiltinModule` passes the same check.
 */
export function installGuard(guard: Guard): void {
  const internals = nodeModule as unknown as {
    _load: (request: string, parent: Parent, isMain: boolean) => unknown;
    _resolveFilename: (request: string, parent: Parent, ...rest: unknown[]) => string;
    _extensions: object;
    registerHooks?: (hooks: object) => unknown;
  };
  const load = internals._load;
  const resolveFilename = internals._resolveFilename;
  const register = internals.registerHooks;
  if (typeof register !== 'function') throw refusal('the loader', 'has no synchronous hooks, so it cannot be guarded');
  // `require('node:fs')` is answered before `_resolveFilename` is asked, so the request is checked here as well. The
  // parent is not consulted: it is whatever the caller passed.
  const guardedLoad = function (this: unknown, request: string, parent: Parent, isMain: boolean): unknown {
    if (typeof request === 'string' && nodeModule.isBuiltin(request)) guard.builtin(request);
    return load.call(this, request, parent, isMain);
  };
  const guardedResolve = function (this: unknown, request: string, parent: Parent, ...rest: unknown[]): string {
    const found = resolveFilename.call(this, request, parent, ...rest);
    guard.resolved(request, found);
    return found;
  };
  locked(nodeModule, '_load', guardedLoad);
  locked(nodeModule, '_resolveFilename', guardedResolve);
  register({
    resolve(
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: unknown) => { url: string },
    ) {
      const result = nextResolve(specifier, context);
      guard.resolved(specifier, result.url, context.parentURL);
      return result;
    },
  });

  const getBuiltin = process.getBuiltinModule?.bind(process);
  if (getBuiltin !== undefined)
    locked(process, 'getBuiltinModule', (id: string) => {
      guard.builtin(id);
      return getBuiltin(id);
    });

  const refuse = (what: string) => (): never => {
    throw refusal(what, 'is not available to a law');
  };
  for (const name of ['registerHooks', 'register']) locked(nodeModule, name, refuse(`module.${name}`));
  // The tables and entry points the loader works through: read-only, so no law swaps in its own.
  Object.freeze(internals._extensions);
  const loader = nodeModule as unknown as Record<string, unknown>;
  for (const name of ['_extensions', '_cache', '_pathCache', '_findPath', 'createRequire'])
    locked(nodeModule, name, loader[name]);
  const proto = nodeModule.prototype as unknown as Record<string, unknown>;
  for (const name of ['_compile', 'require', 'load']) locked(nodeModule.prototype, name, proto[name]);
  // Not closed, because Node fixes them: `Module.wrap` (its setter makes later loads use another wrapper) and the
  // `constructor` of a module, which is how a law reaches `Module` without `require('module')`. What a law gains is the
  // text around files not yet loaded; every request those make is still checked, by the real caller on the stack, and the
  // permission model denies writes, processes, threads and sockets whatever any code asks for.
  // What reads the stack must not be redirected: the properties stay writable data but cannot become accessors.
  for (const name of ['prepareStackTrace', 'stackTraceLimit'])
    Object.defineProperty(ErrorClass, name, {
      value: (ErrorClass as unknown as Record<string, unknown>)[name],
      writable: true,
      enumerable: false,
      configurable: false,
    });
  locked(ErrorClass, 'captureStackTrace', ErrorClass.captureStackTrace);
}
