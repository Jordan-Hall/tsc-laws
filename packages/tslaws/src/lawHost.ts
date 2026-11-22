// The process a sandboxed law runs in (see sandbox.ts, which starts it under Node's permission model). It loads one law
// at a time, runs its property test or replays one input, and answers over IPC with plain data. It starts no process
// or thread, writes nothing and loads only what the parent reviewed (sandboxGuard.ts): a file that needs transforming
// (TypeScript source, a project format) was transformed by the parent and is looked up here.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { installLawRuntime, loadResolver, runtimeFile, useTransforms, type LawRuntime } from './lawRuntime.ts';
import { arbitraryOf, type Plan } from './plan.ts';
import { isDiscard, jsPath, runLaw, summarise } from './propertyRun.ts';
import { installLoaderHooks, setImportMetaEnv, type ImportMetaEnv } from './runtimeEnv.ts';
import { Guard, installGuard, normal, type GuardConfig } from './sandboxGuard.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

/** A reviewed file as the parent transformed it, or why it could not. */
export type Prepared = { code: string } | { error: string };

/**
 * What the parent sends. `configure` comes first and once: it fixes the reviewed set and hands over `token`, a secret that
 * every later request must carry. The process takes a request from no one else, so code that runs inside it cannot make one.
 */
export type HostRequest =
  | { type: 'configure'; token: string; guard: GuardConfig; transforms: Record<string, Prepared> }
  | {
      type: 'run';
      token: string;
      id: number;
      outDir: string;
      law: ManifestLaw;
      plans: Plan[];
      options: CheckOptions;
      env: ImportMetaEnv;
    }
  | {
      type: 'holds';
      token: string;
      id: number;
      outDir: string;
      law: ManifestLaw;
      inputs: unknown[];
      env: ImportMetaEnv;
    };

/** What it answers: `phase` says whether the law could not be loaded or failed while it ran. */
export type HostReply =
  | { id: number; outcome: unknown; async: boolean }
  | { id: number; holds: boolean }
  | { id: number; error: string; phase: 'load' | 'run' };

// Compiled laws are CommonJS, loaded with `require` so that a recompiled law can be dropped from `require.cache`.
const require = createRequire(import.meta.url);
type Law = (...args: unknown[]) => unknown;

const guard = new Guard();
let secret: string | undefined;
const transformed = new Map<string, Prepared>();
const loaded = new Map<string, Law>();
let guarded = false;

// The channel is the only way out. Keep it, and take it from the code that runs here so it cannot answer for the host.
// `process.send` calls `this._send`, which lockDown hides, so the inner function is kept as well.
const sendRaw = (process as unknown as { _send: (...args: unknown[]) => boolean })._send.bind(process);
const send = (message: unknown): boolean => sendRaw(message, undefined, {}, undefined);

const forbidden = (what: string): never => {
  throw Object.assign(new Error(`tslaws sandbox: ${what} is not available to a law`), { code: 'ERR_TSLAWS_SANDBOX' });
};

const ErrorClass = Error;
const captureStackTrace = Error.captureStackTrace.bind(Error);

/** Whether the code that called the accessor that called this is Node's own (`node:internal/...`), not a file of a law. */
function askedByNode(): boolean {
  const limit = ErrorClass.stackTraceLimit;
  const prepare = ErrorClass.prepareStackTrace;
  ErrorClass.stackTraceLimit = 3;
  ErrorClass.prepareStackTrace = (_error, sites) => sites;
  try {
    const holder: { stack?: unknown } = {};
    captureStackTrace(holder, askedByNode);
    const sites = (holder.stack as NodeJS.CallSite[] | undefined) ?? [];
    // Frame 0 is the accessor; frame 1 is whoever read or wrote the property.
    const name = sites[1]?.getFileName();
    return typeof name === 'string' && name.startsWith('node:');
  } finally {
    ErrorClass.prepareStackTrace = prepare;
    ErrorClass.stackTraceLimit = limit;
  }
}

/** Removes the ways around the guard that need no permission: the internals, signals, the channel and the network. */
function lockDown(): void {
  const hide = (target: object, name: string, value: unknown): void => {
    Object.defineProperty(target, name, { value, writable: false, configurable: false });
  };
  hide(process, 'binding', () => forbidden('process.binding'));
  hide(process, 'dlopen', () => forbidden('process.dlopen'));
  hide(process, 'kill', () => forbidden('process.kill'));
  // The channel to the parent is this file's alone: nothing here may use it, listen on it or put a message on it.
  // (Accessors that answer nothing and take nothing: Node itself assigns to some of these when the channel closes.)
  // Node's own code still reads and writes them (to close the channel, say), and it is told by the frame that asks: a
  // read from a file of a law is answered with nothing.
  const own = process as unknown as Record<string, unknown>;
  for (const name of ['send', '_send', 'channel', '_channel']) {
    let value = own[name];
    Object.defineProperty(process, name, {
      get: () => (askedByNode() ? value : undefined),
      set: (next: unknown) => {
        if (askedByNode()) value = next;
      },
      configurable: false,
    });
  }
  // Nor may a listener see the requests (the secret is in them) or be put in place of ours. `emit` stays: Node uses it, and
  // a message made up with it has no secret.
  const messages = new Set(['message', 'internalMessage']);
  const emitter = process as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
    const original = emitter[name]!.bind(process);
    hide(process, name, (event: unknown, ...rest: unknown[]) =>
      messages.has(String(event)) ? process : original(event, ...rest),
    );
  }
  for (const name of ['off', 'removeListener']) {
    const original = emitter[name]!.bind(process);
    hide(process, name, (event: unknown, ...rest: unknown[]) =>
      messages.has(String(event)) ? process : original(event, ...rest),
    );
  }
  const removeAll = emitter.removeAllListeners!.bind(process);
  hide(process, 'removeAllListeners', (event?: unknown) => {
    if (event === undefined) {
      for (const name of process.eventNames()) if (!messages.has(String(name))) removeAll(name);
    } else if (!messages.has(String(event))) removeAll(event);
    return process;
  });
  for (const name of ['listeners', 'rawListeners']) {
    const original = emitter[name]!.bind(process);
    hide(process, name, (event: unknown) => (messages.has(String(event)) ? [] : original(event)));
  }
  const events = (process as unknown as { _events?: Record<string, unknown> })._events;
  const names = process.eventNames.bind(process);
  hide(process, 'eventNames', () => names().filter((name) => !messages.has(String(name))));
  // Our own listener stays where it is, whatever is done to the table that holds it.
  if (events !== undefined && 'message' in events)
    Object.defineProperty(events, 'message', { value: events.message, writable: false, configurable: false });
  // Nothing may open a socket, and the globals that do are the way past the module list.
  for (const name of ['fetch', 'WebSocket', 'EventSource']) hide(globalThis, name, () => forbidden(name));
}

function lookup(kind: string, file: string): string {
  const prepared = transformed.get(`${kind}:${normal(file)}`);
  if (prepared === undefined)
    throw Object.assign(
      new Error(`tslaws sandbox: ${file} was not prepared before the law started, so it is not in the reviewed set`),
      { code: 'ERR_TSLAWS_SANDBOX' },
    );
  if ('error' in prepared) throw new Error(prepared.error);
  return prepared.code;
}

function load(outDir: string, law: ManifestLaw, env: ImportMetaEnv, fresh: boolean): Law {
  const key = `${outDir}\0${law.file}\0${law.symbol ?? law.name}`;
  const known = loaded.get(key);
  if (!fresh && known !== undefined) return known;
  setImportMetaEnv(env);
  installLoaderHooks();
  useTransforms({
    source: (file) => lookup('ts', file),
    plugin: (file, _cwd, _plugins, format) => lookup(format, file),
  });
  installLawRuntime(JSON.parse(readFileSync(join(outDir, runtimeFile), 'utf8')) as LawRuntime);
  // Before the guard: the resolver loads TypeScript, which needs Node modules that no law may load.
  loadResolver();
  // From here on only reviewed files load. Installed after the runtime's own hooks, so it sees what they resolve.
  if (!guarded) {
    guarded = true;
    installGuard(guard);
    lockDown();
  }
  // The process outlives a check, and the code may have been recompiled since the last one.
  for (const file of Object.keys(require.cache)) if (file.startsWith(outDir)) delete require.cache[file];
  const fn = (require(jsPath(outDir, law.file)) as Record<string, Law | undefined>)[law.symbol ?? law.name];
  if (typeof fn !== 'function') throw new Error('compiled module does not export the law');
  loaded.set(key, fn);
  return fn;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The parent is the only reason to run: when its channel closes, so does this process.
// It ends by draining, not by `process.exit` (which joins V8's background threads and can hang, see #78); a law that keeps
// the loop busy is cut off after a moment by the kill captured before the laws could take it away.
const killSelf = process.kill.bind(process);
process.on('disconnect', () => {
  process.exitCode = 0;
  setTimeout(() => killSelf(process.pid, 'SIGKILL'), 3000).unref();
});

process.on('message', async (request: HostRequest) => {
  if (typeof request !== 'object' || request === null) return;
  if (request.type === 'configure') {
    // Once, and first: before any law code is loaded. A later one is not the parent's.
    if (secret !== undefined || typeof request.token !== 'string' || request.token.length < 16) return;
    secret = request.token;
    guard.configure(request.guard);
    for (const [key, code] of Object.entries(request.transforms)) transformed.set(key, code);
    return;
  }
  if (secret === undefined || request.token !== secret) return;
  const { id } = request;
  let fn: Law;
  try {
    fn = load(request.outDir, request.law, request.env, request.type === 'run');
  } catch (error) {
    send({ id, error: message(error), phase: 'load' } satisfies HostReply);
    return;
  }
  try {
    if (request.type === 'holds') {
      let holds: boolean;
      try {
        holds = (await fn(...request.inputs)) !== false;
      } catch (error) {
        holds = isDiscard(error);
      }
      send({ id, holds } satisfies HostReply);
      return;
    }
    const generators = request.plans.map(arbitraryOf);
    const outcome = summarise(await runLaw(fn, generators, request.options), request.options);
    send({ id, outcome, async: fn.constructor.name === 'AsyncFunction' } satisfies HostReply);
  } catch (error) {
    send({ id, error: message(error), phase: 'run' } satisfies HostReply);
  }
});
