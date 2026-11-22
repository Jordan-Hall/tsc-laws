// The process a sandboxed law runs in (see sandbox.ts, which starts it under Node's permission model). It loads one law
// at a time, runs its property test or replays one input, and answers over IPC with plain data. It starts no process
// or thread, writes nothing and loads only what the parent reviewed (sandboxGuard.ts): a file that needs transforming
// (TypeScript source, a project format) was transformed by the parent and is looked up here.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { installLawRuntime, runtimeFile, useTransforms, type LawRuntime } from './lawRuntime.ts';
import { arbitraryOf, type Plan } from './plan.ts';
import { isDiscard, jsPath, runLaw, summarise } from './propertyRun.ts';
import { installLoaderHooks, setImportMetaEnv, type ImportMetaEnv } from './runtimeEnv.ts';
import { Guard, installGuard, normal, type GuardConfig } from './sandboxGuard.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

/** A reviewed file as the parent transformed it, or why it could not. */
export type Prepared = { code: string } | { error: string };

/** What the parent sends. `configure` comes first and again whenever the reviewed set changes. */
export type HostRequest =
  | { type: 'configure'; guard: GuardConfig; transforms: Record<string, Prepared> }
  | {
      type: 'run';
      id: number;
      outDir: string;
      law: ManifestLaw;
      plans: Plan[];
      options: CheckOptions;
      env: ImportMetaEnv;
    }
  | { type: 'holds'; id: number; outDir: string; law: ManifestLaw; inputs: unknown[]; env: ImportMetaEnv };

/** What it answers: `phase` says whether the law could not be loaded or failed while it ran. */
export type HostReply =
  | { id: number; outcome: unknown; async: boolean }
  | { id: number; holds: boolean }
  | { id: number; error: string; phase: 'load' | 'run' };

// Compiled laws are CommonJS, loaded with `require` so that a recompiled law can be dropped from `require.cache`.
const require = createRequire(import.meta.url);
type Law = (...args: unknown[]) => unknown;

const guard = new Guard();
const transformed = new Map<string, Prepared>();
const loaded = new Map<string, Law>();
let guarded = false;

// The channel is the only way out. Keep it, and take it from the code that runs here so it cannot answer for the host.
const send = process.send!.bind(process);

const forbidden = (what: string): never => {
  throw Object.assign(new Error(`tslaws sandbox: ${what} is not available to a law`), { code: 'ERR_TSLAWS_SANDBOX' });
};

/** Removes the ways around the guard that need no permission: the internals, signals, the channel and the network. */
function lockDown(): void {
  const builtin = process.getBuiltinModule?.bind(process);
  const hide = (target: object, name: string, value: unknown): void => {
    Object.defineProperty(target, name, { value, writable: false, configurable: false });
  };
  if (builtin !== undefined)
    hide(process, 'getBuiltinModule', (id: string) => {
      guard.builtin(id, undefined);
      return builtin(id);
    });
  hide(process, 'binding', () => forbidden('process.binding'));
  hide(process, 'dlopen', () => forbidden('process.dlopen'));
  hide(process, 'kill', () => forbidden('process.kill'));
  hide(process, 'send', undefined);
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
process.on('disconnect', () => process.exit(0));

process.on('message', async (request: HostRequest) => {
  if (request.type === 'configure') {
    guard.configure(request.guard);
    transformed.clear();
    for (const [key, code] of Object.entries(request.transforms)) transformed.set(key, code);
    return;
  }
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
