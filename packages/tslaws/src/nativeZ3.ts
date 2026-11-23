// Optional native Z3 backend: uses a persistent pooled `z3 -in -smt2` process with `(reset)` between queries when a
// native `z3` binary is available (`TSLAWS_Z3` or `z3` on PATH). Faster and far less memory-hungry than the
// WebAssembly build in `smtWorker.ts`, lifting the 4-worker RAM cap. Falls back seamlessly to WASM when absent or
// when `TSLAWS_Z3=wasm`.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { SolverCrash } from './chc.ts';
import { jobs, lowerPriority, WorkerPool } from './pool.ts';

const sentinel = '__TSLAWS_Z3_DONE__';
const modelSentinel = '__TSLAWS_Z3_VALS__';

let detectedPath: string | null | undefined;
let detectedEnv: string | undefined;

/** Resolves the native `z3` binary path if installed and enabled, else undefined. */
export function nativeZ3Path(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.TSLAWS_Z3?.trim();
  if (configured === 'wasm' || configured === '0' || configured === 'false') return undefined;
  if (detectedPath !== undefined && detectedEnv === configured) return detectedPath ?? undefined;
  detectedEnv = configured;
  const candidate = configured !== undefined && configured !== '' ? configured : 'z3';
  try {
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (probe.error === undefined && probe.status === 0 && /Z3 version/i.test(probe.stdout ?? '')) {
      detectedPath = candidate;
      return candidate;
    }
  } catch {
    // Native Z3 is not available; fall back to WebAssembly.
  }
  detectedPath = null;
  return undefined;
}

/** Fingerprint of the active Z3 backend for proof cache keys. */
export function z3Fingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const bin = nativeZ3Path(env);
  if (bin === undefined) return 'z3-wasm';
  try {
    const st = statSync(bin);
    return `z3-native:${bin}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `z3-native:${bin}`;
  }
}

class NativeZ3Process {
  private readonly child: ChildProcess;
  private buffer = '';
  private alive = true;
  private waiter:
    | {
        marker: string;
        resolve: (text: string) => void;
        reject: (error: Error) => void;
      }
    | undefined;

  constructor(binary: string) {
    this.child = spawn(binary, ['-in', '-smt2'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    lowerPriority(this.child.pid);
    this.child.unref();
    let stderr = '';
    this.child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    this.child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    const fail = (why: string): void => {
      this.alive = false;
      const pending = this.waiter;
      this.waiter = undefined;
      pending?.reject(new SolverCrash(`the native Z3 solver crashed: ${why}${stderr ? ` (${stderr.trim()})` : ''}`));
    };
    this.child.on('error', (error) => fail(error.message));
    this.child.on('exit', (code, signal) => fail(`exited with ${signal ?? `code ${code}`}`));
    this.child.stdin?.on('error', () => undefined);
  }

  private drain(): void {
    if (this.waiter === undefined) return;
    const token = `"${this.waiter.marker}"`;
    const idx = this.buffer.indexOf(token);
    if (idx < 0) return;
    const before = this.buffer.slice(0, idx).trim();
    const afterNl = this.buffer.indexOf('\n', idx + token.length);
    this.buffer = afterNl < 0 ? '' : this.buffer.slice(afterNl + 1);
    const { resolve } = this.waiter;
    this.waiter = undefined;
    resolve(before);
  }

  private sendAndWait(script: string, marker: string): Promise<string> {
    if (!this.alive || this.child.stdin === null) return Promise.reject(new SolverCrash('native Z3 process closed'));
    return new Promise((resolve, reject) => {
      this.waiter = { marker, resolve, reject };
      this.child.stdin!.write(`${script}\n(echo "${marker}")\n`);
      this.drain();
    });
  }

  async solve(query: string, values: string): Promise<{ out: string; vals: string }> {
    const out = await this.sendAndWait(`(reset)\n${query}`, sentinel);
    const vals = out.startsWith('sat') && values !== '' ? await this.sendAndWait(values, modelSentinel) : '';
    return { out, vals };
  }

  terminate(): void {
    this.alive = false;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // Already exited.
    }
  }
}

let poolBinary: string | undefined;
let pool: WorkerPool<NativeZ3Process> | undefined;

function poolFor(binary: string): WorkerPool<NativeZ3Process> {
  if (pool !== undefined && poolBinary === binary) return pool;
  pool?.close();
  poolBinary = binary;
  pool = new WorkerPool(() => new NativeZ3Process(binary), jobs, 10000);
  return pool;
}

/** Terminates idle native Z3 processes (e.g. after a solver crash). */
export function closeNativeZ3(): void {
  pool?.close();
}

/** Runs one SMT-LIB query against a pooled native Z3 process; rejects with `Unsupported` on timeout. */
export async function solveNative(
  binary: string,
  query: string,
  values: string,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<{ out: string; vals: string }> {
  const activePool = poolFor(binary);
  const proc = await activePool.acquire();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        activePool.discard(proc);
        reject(onTimeout());
      }, timeoutMs + 3000);
    });
    const reply = await Promise.race([proc.solve(query, values), timeout]);
    if (!timedOut) activePool.release(proc);
    return reply;
  } catch (error) {
    if (!timedOut) activePool.discard(proc);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
