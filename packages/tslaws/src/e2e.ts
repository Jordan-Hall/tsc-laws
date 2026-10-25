// End-to-end laws: a whole running app, driven from outside through a real browser. The law runs in this process;
// the runner starts the app's dev server, gives every generated input a fresh browser context, and shrinks failures
// to a minimal counterexample like any other law.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type * as fc from 'fast-check';
import { launch, resolveEngine } from './browser.ts';
import { withE2e } from './e2eApi.ts';
import { runProperty, summarise, type PropertyOutcome } from './property.ts';
import type { CheckOptions } from './types.ts';

/** `a.e2e.laws.ts` is an accepted alias: it always drives a running app. */
export function isE2eLawFile(file: string): boolean {
  return /\.e2e\.laws\.[cm]?ts$/.test(file);
}

const importsOf = (module: string): RegExp => new RegExp(`(?:from|import)\\s*['"]${module}['"]`);

/** Whether a law file imports both helper sets, which would put one file at two levels. */
export function importsBoth(text: string): boolean {
  return importsOf('tslaws/e2e').test(text) && importsOf('tslaws/browser').test(text);
}

/**
 * The level a law file runs at. `*.browser.laws.ts` is a component law (in a page) unless it imports from
 * `tslaws/e2e`, which makes it an end-to-end law (in Node, driving a running app); `*.e2e.laws.ts` is always e2e.
 */
export function lawMode(file: string, text: string): 'node' | 'component' | 'e2e' {
  if (isE2eLawFile(file)) return 'e2e';
  if (!/\.browser\.laws\.[cm]?ts$/.test(file)) return 'node';
  return importsOf('tslaws/e2e').test(text) ? 'e2e' : 'component';
}

export interface E2eServerConfig {
  /** Shell command that starts the app. It runs from your project, like a package script. */
  command: string;
  /** Address that answers (any status below 500) once the app is up. */
  url: string;
  /** How long to wait for `url`. Default 60000. */
  timeoutMs?: number;
  /** Use a server that already answers at `url` instead of starting one. Default false. */
  reuseExisting?: boolean;
  /** Directory the command runs in, relative to the project. Default the project. */
  cwd?: string;
}

export interface E2eConfig {
  baseURL?: string;
  server?: E2eServerConfig;
  /** Generated inputs per law. Default 10. */
  runs?: number;
  /** Longest a law may take overall. Default 120000. */
  timeoutMs?: number;
}

const topKeys = ['baseURL', 'server', 'runs', 'timeoutMs'];
const serverKeys = ['command', 'url', 'timeoutMs', 'reuseExisting', 'cwd'];

/** Checks the `e2e` section of tslaws.json; unknown keys and wrong types are errors that say where. */
export function parseE2eConfig(raw: unknown): E2eConfig {
  const fail = (message: string): never => {
    throw new Error(`tslaws.json e2e: ${message}`);
  };
  const object = (value: unknown, where: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be an object`);
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, where: string): string => {
    if (typeof value !== 'string' || value === '') fail(`${where} must be a non-empty string`);
    return value as string;
  };
  const count = (value: unknown, where: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) fail(`${where} must be a positive integer`);
    return value as number;
  };
  const section = object(raw, 'it');
  for (const name of Object.keys(section))
    if (!topKeys.includes(name)) fail(`unknown option "${name}"; supported options are ${topKeys.join(', ')}`);
  const config: E2eConfig = {};
  if (section.baseURL !== undefined) config.baseURL = text(section.baseURL, '"baseURL"');
  if (section.runs !== undefined) config.runs = count(section.runs, '"runs"');
  if (section.timeoutMs !== undefined) config.timeoutMs = count(section.timeoutMs, '"timeoutMs"');
  if (section.server !== undefined) {
    const server = object(section.server, '"server"');
    for (const name of Object.keys(server))
      if (!serverKeys.includes(name))
        fail(`unknown option "server.${name}"; supported options are ${serverKeys.join(', ')}`);
    const parsed: E2eServerConfig = {
      command: text(server.command, '"server.command"'),
      url: text(server.url, '"server.url"'),
    };
    if (server.timeoutMs !== undefined) parsed.timeoutMs = count(server.timeoutMs, '"server.timeoutMs"');
    if (server.reuseExisting !== undefined) {
      if (typeof server.reuseExisting !== 'boolean') fail('"server.reuseExisting" must be true or false');
      parsed.reuseExisting = server.reuseExisting as boolean;
    }
    if (server.cwd !== undefined) parsed.cwd = text(server.cwd, '"server.cwd"');
    config.server = parsed;
  }
  return config;
}

// ---- the dev server ----

let child: ChildProcess | undefined;
let started: Promise<void> | undefined;
let startedFor: string | undefined;

/** Whether `url` answers with anything but a server error. */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Kills `process` and everything it started. */
function killTree(process_: ChildProcess): void {
  const pid = process_.pid;
  if (pid === undefined || process_.exitCode !== null || process_.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, 2000).unref();
  }
}

const onExit = (): void => {
  if (child !== undefined) killTree(child);
};
const onSignal = (): void => {
  onExit();
  process.exit(130);
};

/** Stops the server this run started, if any. Safe to call more than once. */
export async function stopServer(): Promise<void> {
  const running = child;
  child = undefined;
  started = undefined;
  startedFor = undefined;
  process.off('exit', onExit);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  if (running === undefined) return;
  const gone = new Promise<void>((done) => {
    if (running.exitCode !== null || running.signalCode !== null) done();
    else running.once('exit', () => done());
  });
  killTree(running);
  await Promise.race([gone, new Promise((done) => setTimeout(done, 5000))]);
}

/** Starts (once per check run) the server of `config` and waits for it; resolves to the base URL. */
export async function ensureServer(config: E2eConfig, cwd: string): Promise<string> {
  const server = config.server;
  const baseURL = config.baseURL ?? server?.url;
  if (baseURL === undefined) throw new Error('tslaws.json e2e: set "baseURL" or "server" for end-to-end laws');
  if (server === undefined) return baseURL;
  if (started === undefined || startedFor !== server.command) {
    startedFor = server.command;
    started = startServer(server, cwd);
  }
  await started;
  return baseURL;
}

async function startServer(server: E2eServerConfig, cwd: string): Promise<void> {
  const alive = await answers(server.url);
  if (alive) {
    if (server.reuseExisting === true) return;
    throw new Error(
      `${server.url} already answers, so \`${server.command}\` would clash with it: stop that server, or set e2e.server.reuseExisting to use it`,
    );
  }
  const process_ = spawn(server.command, {
    cwd: resolve(cwd, server.cwd ?? '.'),
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child = process_;
  process.once('exit', onExit);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let output = '';
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-2000);
  };
  process_.stdout?.on('data', keep);
  process_.stderr?.on('data', keep);
  let ended: string | undefined;
  process_.once('error', (error) => (ended = `could not start: ${error.message}`));
  process_.once('exit', (code, signal) => (ended = `exited with ${code ?? signal}`));
  const timeoutMs = server.timeoutMs ?? 60000;
  const deadline = Date.now() + timeoutMs;
  try {
    while (!(await answers(server.url))) {
      const tail = output.trim() === '' ? '' : `\n${output.trim().split('\n').slice(-8).join('\n')}`;
      if (ended !== undefined)
        throw new Error(`server \`${server.command}\` ${ended} before ${server.url} answered${tail}`);
      if (Date.now() > deadline)
        throw new Error(
          `server \`${server.command}\` did not answer at ${server.url} within ${timeoutMs / 1000}s${tail}`,
        );
      await new Promise((done) => setTimeout(done, 200));
    }
  } catch (error) {
    await stopServer();
    throw error;
  }
}

// ---- running a law ----

export interface E2eLaw {
  file: string;
  name: string;
  fn: (...args: unknown[]) => unknown;
  generators: fc.Arbitrary<unknown>[];
}

/** A browser that died under the machine, as opposed to a law that failed. */
const crashed = /Target (?:page, context or browser has been closed|crashed)|Page crashed|browser has been closed/;

/** Runs `law` once in a fresh context; `keep` leaves the page open for a photograph. A crashed browser tab is tried again, twice at most. */
async function runOnce(
  law: E2eLaw,
  args: unknown[],
  contextOf: () => Promise<BrowserContext>,
  baseURL: string,
  options: CheckOptions,
  track: (page: Page) => void,
  keep?: { page?: Page; context?: BrowserContext },
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runAttempt(law, args, contextOf, baseURL, options, track, keep);
    } catch (error) {
      if (attempt >= 2 || !crashed.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

async function runAttempt(
  law: E2eLaw,
  args: unknown[],
  contextOf: () => Promise<BrowserContext>,
  baseURL: string,
  options: CheckOptions,
  track: (page: Page) => void,
  keep?: { page?: Page; context?: BrowserContext },
): Promise<unknown> {
  const context = await contextOf();
  let closing = true;
  try {
    const page = await context.newPage();
    track(page);
    if (keep !== undefined) {
      keep.page = page;
      keep.context = context;
      closing = false;
    }
    return await withE2e({ context, page, baseURL, cwd: options.cwd, onPage: track }, () => law.fn(...args));
  } finally {
    if (closing) await context.close().catch(() => undefined);
  }
}

/** Property-tests one end-to-end law; `'timeout'` when it does not finish within the time limit. */
export async function runE2eLaw(
  law: E2eLaw,
  options: CheckOptions,
  baseURL: string,
  timeoutMs: number,
): Promise<PropertyOutcome | 'timeout'> {
  const browser = await launch(resolveEngine(options.browser));
  const open = new Set<BrowserContext>();
  const contextOf = async (): Promise<BrowserContext> => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
    open.add(context);
    context.once('close', () => open.delete(context));
    return context;
  };
  let timedOut = false;
  let latest: Page | undefined;
  const track = (page: Page): void => {
    latest = page;
  };
  // While someone watches, photograph the newest page a few times a second.
  let framing = false;
  const frames = options.onEvent
    ? setInterval(() => {
        const page = latest;
        if (framing || page === undefined || page.isClosed()) return;
        framing = true;
        page
          .screenshot({ type: 'jpeg', quality: 55, timeout: 2000 })
          .then((jpeg) => options.onEvent?.({ type: 'frame', file: law.file, name: law.name, jpeg }))
          .catch(() => undefined)
          .finally(() => (framing = false));
      }, 120)
    : undefined;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timeout'>((done) => {
    timer = setTimeout(() => {
      timedOut = true;
      done('timeout');
    }, timeoutMs);
  });
  const call = async (...args: unknown[]): Promise<unknown> => {
    if (timedOut) throw new Error('timed out');
    return runOnce(law, args, contextOf, baseURL, options, track);
  };
  try {
    const finished = await Promise.race([runProperty(call, law.generators, options), limit]);
    if (finished === 'timeout') return 'timeout';
    const outcome = summarise(finished, options);
    if (finished.failed && finished.counterexample !== null)
      outcome.screenshot = await capture(law, finished.counterexample, contextOf, baseURL, options, track);
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (frames !== undefined) clearInterval(frames);
    latest = undefined;
    // A law that never finishes leaves its pages open; closing the contexts frees them.
    await Promise.all([...open].map((context) => context.close().catch(() => undefined)));
  }
}

/** Runs the counterexample once more, leaves the page as the law left it, and photographs it. Best effort. */
async function capture(
  law: E2eLaw,
  args: unknown[],
  contextOf: () => Promise<BrowserContext>,
  baseURL: string,
  options: CheckOptions,
  track: (page: Page) => void,
): Promise<string | undefined> {
  const kept: { page?: Page; context?: BrowserContext } = {};
  try {
    await runOnce(law, args, contextOf, baseURL, options, track, kept).catch(() => undefined);
    if (kept.page === undefined || kept.page.isClosed()) return undefined;
    const relative = `.tslaws/screenshots/${law.name.replace(/[^\w-]/g, '_')}.png`;
    mkdirSync(join(options.cwd, '.tslaws/screenshots'), { recursive: true });
    await kept.page.screenshot({ path: join(options.cwd, relative), timeout: 10000 });
    return relative;
  } catch {
    return undefined;
  } finally {
    await kept.context?.close().catch(() => undefined);
  }
}
