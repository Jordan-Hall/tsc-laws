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
  /** Single files: the laws files, the files they cover and the project files they import. */
  files: string[];
  /** Trees of dependencies and of tslaws itself: installed packages, workspace packages, the tslaws package. */
  packages: string[];
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

/** What an installed package may load as well: it reads its own files and may use the usual helpers. */
export const packageBuiltins: readonly string[] = [
  ...lawBuiltins,
  'async_hooks',
  'console',
  'constants',
  'diagnostics_channel',
  'fs',
  'fs/promises',
  'module',
  'os',
  'perf_hooks',
  'process',
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

/** The rule: what may be loaded, and by whom. */
export class Guard {
  private trees: string[] = [];
  private packages: string[] = [];
  private files = new Set<string>();

  configure(config: GuardConfig): void {
    this.trees = config.trees.map(normal);
    this.packages = config.packages.map(normal);
    this.files = new Set(config.files.map(normal));
  }

  private isPackageFile(path: string): boolean {
    return this.packages.some((tree) => within(path, tree));
  }

  /** Throws unless `request`, a Node module, may be loaded by `parent` (a file path or URL, if known). */
  builtin(request: string, parent: string | undefined): void {
    const name = request.startsWith('node:') ? request.slice(5) : request;
    const from = parent?.startsWith('file:') === true ? fileURLToPath(parent) : parent;
    const fromPackage = from !== undefined && this.isPackageFile(normal(from));
    if ((fromPackage ? packageBuiltins : lawBuiltins).includes(name)) return;
    throw refusal(
      `"${request}"`,
      `is not a module a law may load${fromPackage ? '' : ' (allowed: ' + lawBuiltins.join(', ') + ')'}`,
    );
  }

  /** Throws unless the file `path` is in the reviewed set. */
  file(path: string, request: string): void {
    const at = normal(path);
    if (this.files.has(at) || this.trees.some((tree) => within(at, tree)) || this.isPackageFile(at)) return;
    throw refusal(
      `"${request}" resolves to ${path}, which`,
      'is outside the reviewed set of files (the laws, what they import, installed packages)',
    );
  }

  /** Checks one resolution: `request` as written, `resolved` as Node found it (a `file:` or `node:` URL, or a path). */
  resolved(request: string, resolved: string, parent: string | undefined): void {
    if (resolved.startsWith('node:') || nodeModule.isBuiltin(resolved)) return this.builtin(resolved, parent);
    if (resolved.startsWith('file:')) return this.file(fileURLToPath(resolved), request);
    if (/^[a-z][a-z0-9+.-]+:/i.test(resolved) && !/^[a-z]:[\\/]/i.test(resolved))
      throw refusal(`"${request}"`, `resolves to ${resolved.slice(0, 40)}, which is not a file`);
    return this.file(resolved, request);
  }
}

type Parent = { filename?: string } | null | undefined;

/**
 * Puts the guard in front of every way a law can load a module: the CommonJS loader (`require`, `createRequire`, `import()`
 * compiled to `require`) and, where Node has them (22.15, 23.5 or later), the synchronous hooks that cover `import` too.
 * The CommonJS entries are made read-only, so a law cannot put the originals back. On an older Node an `import()` of an
 * ES module is held back by the read permission alone.
 */
export function installGuard(guard: Guard): void {
  const internals = nodeModule as unknown as {
    _load: (request: string, parent: Parent, isMain: boolean) => unknown;
    _resolveFilename: (request: string, parent: Parent, ...rest: unknown[]) => string;
  };
  const load = internals._load;
  const resolveFilename = internals._resolveFilename;
  // `require('node:fs')` is answered before `_resolveFilename` is asked, so the request is checked here as well.
  const guardedLoad = function (this: unknown, request: string, parent: Parent, isMain: boolean): unknown {
    if (typeof request === 'string' && nodeModule.isBuiltin(request)) guard.builtin(request, parent?.filename);
    return load.call(this, request, parent, isMain);
  };
  const guardedResolve = function (this: unknown, request: string, parent: Parent, ...rest: unknown[]): string {
    const found = resolveFilename.call(this, request, parent, ...rest);
    guard.resolved(request, found, parent?.filename);
    return found;
  };
  Object.defineProperty(nodeModule, '_load', { value: guardedLoad, writable: false, configurable: false });
  Object.defineProperty(nodeModule, '_resolveFilename', {
    value: guardedResolve,
    writable: false,
    configurable: false,
  });

  if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        guard.resolved(specifier, result.url, context.parentURL);
        return result;
      },
    });
  }
}
