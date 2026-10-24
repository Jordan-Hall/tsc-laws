// `tslaws ui`: a local dashboard for the laws, in the manner of Vitest's UI. A sidebar tree of files and laws with
// status filters and search, a detail pane (report, source, diagnostics), and live reruns when a file changes.
// It listens on 127.0.0.1 only and offers no way to accept laws: that stays a person's act at a terminal.
import { spawn } from 'node:child_process';
import { readFileSync, watch } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, join, resolve, sep } from 'node:path';
import type { CheckReport } from './check.ts';
import { hintFor } from './hints.ts';
import { page } from './uiPage.ts';
import type { LawEvent, LawResult, LawStatus } from './types.ts';

export interface UiOptions {
  cwd: string;
  port: number;
  open: boolean;
  /** Runs the check of the project, of just these law files, or (with `laws`, in one file) of just these laws. */
  run: (files: string[] | undefined, onEvent: (event: LawEvent) => void, laws?: string[]) => Promise<CheckReport>;
  log: (line: string) => void;
}

const passingStatuses = new Set(['proved', 'bounded', 'tested']);
const failingStatuses = new Set(['failed', 'error', 'open']);
const statusWindow = 5;
const historyLimit = 20;

/** A law is flaky when its last five statuses include both a passing and a failing one. */
export function isFlaky(statuses: readonly string[] | undefined): boolean {
  const last = (statuses ?? []).slice(-statusWindow);
  return last.some((s) => passingStatuses.has(s)) && last.some((s) => failingStatuses.has(s));
}

interface HistoryEntry {
  at: number;
  ok: boolean;
  durationMs: number;
  counts: Record<string, number>;
}

interface State {
  project: string;
  running: boolean;
  runs: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  /** The last runs of the whole project, oldest first. */
  history: HistoryEntry[];
  report?: {
    ok: boolean;
    compileOk: boolean;
    compileDiagnostics: string;
    lockMissing: boolean;
    results: (Omit<LawResult, 'status'> & {
      status: LawStatus | 'pending' | 'running';
      hint?: string;
      durationMs?: number;
      flaky?: boolean;
    })[];
  };
  sources: Record<string, string>;
  /** Counts the frames received of each browser law, so the page knows when to reload the picture. */
  frames: Record<string, number>;
}

const ignored = new Set(['node_modules', '.tslaws', '.git']);

function sourceOf(cwd: string, file: string): string | undefined {
  const full = resolve(cwd, file);
  // Only files inside the project are served.
  if (!full.startsWith(cwd + sep)) return undefined;
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return undefined;
  }
}

function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true })
      .on('error', () => undefined)
      .unref();
  } catch {
    // The URL is printed either way.
  }
}

/** Serves the dashboard until Ctrl+C. Resolves 0. */
export async function serveUi(options: UiOptions): Promise<number> {
  const cwd = resolve(options.cwd);
  const state: State = { project: basename(cwd), running: false, runs: 0, history: [], sources: {}, frames: {} };
  const latestFrame = new Map<string, Buffer>();
  let pushTimer: NodeJS.Timeout | undefined;
  const clients = new Set<ServerResponse>();
  let queued = false;

  const push = (): void => {
    const data = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) client.write(data);
  };
  // Events can arrive many times a second; the page hears of them at most ten times a second.
  const pushSoon = (): void => {
    if (pushTimer !== undefined) return;
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      push();
    }, 100);
  };
  const keyOf = (file: string, name: string): string => `${file}::${name}`;
  // The last statuses of each law over full runs, and how long each law's last run took.
  const statuses = new Map<string, string[]>();
  const durations = new Map<string, number>();
  const decorate = <R extends LawResult>(r: R): R & { hint?: string; durationMs?: number; flaky: boolean } => {
    const key = keyOf(r.file, r.name);
    return { ...r, hint: hintFor(r), durationMs: durations.get(key), flaky: isFlaky(statuses.get(key)) };
  };

  interface Request {
    file?: string;
    law?: string;
  }
  let next: Request = {};
  const cycle = async (request: Request = {}): Promise<void> => {
    if (state.running) {
      queued = true;
      next = request;
      return;
    }
    let current = request;
    do {
      const only = current.file;
      const law = only === undefined ? undefined : current.law;
      const isLaw = (r: { file: string; name: string }): boolean => r.file === only && r.name === law;
      queued = false;
      state.running = true;
      state.error = undefined;
      push();
      const started = Date.now();
      try {
        const previous = state.report?.results ?? [];
        const heldBack =
          only === undefined || state.report === undefined
            ? []
            : previous.filter((r) => (law === undefined ? r.file !== only : !isLaw(r)));
        const startedAt = new Map<string, number>();
        const live = (event: LawEvent): void => {
          if (event.type === 'frame') {
            const key = keyOf(event.file, event.name);
            latestFrame.set(key, event.jpeg);
            state.frames[key] = (state.frames[key] ?? 0) + 1;
          } else if (event.type === 'plan') {
            const planned = event.laws
              .filter((l) => law === undefined || isLaw(l))
              .map((l) => ({ ...l, status: 'pending' as const, method: 'waiting' }));
            state.report = {
              ok: false,
              compileOk: true,
              compileDiagnostics: '',
              lockMissing: false,
              results: [...heldBack, ...planned],
            };
          } else if (state.report !== undefined) {
            const list = state.report.results;
            if (event.type === 'start') {
              startedAt.set(keyOf(event.file, event.name), Date.now());
              const at = list.findIndex((r) => r.file === event.file && r.name === event.name);
              if (at >= 0) list[at] = { ...list[at]!, status: 'running', method: 'running' };
            } else {
              const at = list.findIndex((r) => r.file === event.result.file && r.name === event.result.name);
              const key = keyOf(event.result.file, event.result.name);
              const t0 = startedAt.get(key);
              if (t0 !== undefined) durations.set(key, Date.now() - t0);
              else durations.delete(key);
              const next = decorate(event.result);
              if (at >= 0) list[at] = next;
              else list.push(next);
            }
          }
          pushSoon();
        };
        const report = await options.run(
          only === undefined ? undefined : [only],
          live,
          law === undefined ? undefined : [law],
        );
        let fresh: NonNullable<State['report']>['results'] = report.results.map(decorate);
        // One file's rerun replaces that file's results and keeps the others (and the coverage verdicts) as they were.
        // One law's rerun replaces just that law's entry.
        const kept = heldBack;
        if (law !== undefined) {
          fresh = fresh.filter(isLaw);
          // A run that produced no result for the law (a compile failure) leaves its old entry alone.
          if (fresh.length === 0) fresh = previous.filter(isLaw);
        }
        state.report = {
          ok: report.ok && kept.every((r) => ['proved', 'bounded', 'tested'].includes(r.status)),
          compileOk: report.compileOk,
          compileDiagnostics: report.compileDiagnostics,
          lockMissing: report.lockMissing,
          results: only === undefined ? fresh : [...kept, ...fresh.filter((r) => r.method !== 'coverage')],
        };
        if (only === undefined) {
          for (const r of state.report.results) {
            const list = [...(statuses.get(keyOf(r.file, r.name)) ?? []), r.status].slice(-statusWindow);
            statuses.set(keyOf(r.file, r.name), list);
            r.flaky = isFlaky(list);
          }
          const counts: Record<string, number> = {};
          for (const r of state.report.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
          state.history = [
            ...state.history,
            { at: Date.now(), ok: state.report.ok, durationMs: Date.now() - started, counts },
          ].slice(-historyLimit);
        }
        const sources: Record<string, string> = {};
        for (const file of new Set(state.report.results.map((r) => r.file))) {
          const text = sourceOf(cwd, file);
          if (text !== undefined) sources[file] = text;
        }
        state.sources = sources;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        for (const r of state.report?.results ?? []) {
          if (r.status === 'pending' || r.status === 'running')
            Object.assign(r, { status: 'error', method: 'run', message: `the run stopped: ${state.error}` });
        }
      }
      state.runs += 1;
      state.durationMs = Date.now() - started;
      state.finishedAt = Date.now();
      state.running = false;
      push();
      current = next;
    } while (queued);
  };

  const hostOk = (request: IncomingMessage): boolean =>
    /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? '');

  const server = createServer((request, response) => {
    // A page on another origin must not drive the dashboard (DNS rebinding, cross-site posts).
    if (!hostOk(request)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
    } else if (request.method === 'GET' && url.pathname === '/api/state') {
      response
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify(state));
    } else if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
    } else if (request.method === 'GET' && url.pathname === '/api/frame') {
      const frame = latestFrame.get(keyOf(url.searchParams.get('file') ?? '', url.searchParams.get('name') ?? ''));
      if (frame === undefined) response.writeHead(404).end('not found');
      else response.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).end(frame);
    } else if (request.method === 'GET' && url.pathname === '/api/screenshot') {
      // Only the PNGs the runner writes are served.
      const file = resolve(cwd, url.searchParams.get('path') ?? '');
      if (!file.startsWith(join(cwd, '.tslaws', 'screenshots') + sep) || !file.endsWith('.png')) {
        response.writeHead(404).end('not found');
        return;
      }
      try {
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(readFileSync(file));
      } catch {
        response.writeHead(404).end('not found');
      }
    } else if (request.method === 'POST' && url.pathname === '/api/run') {
      const origin = request.headers.origin;
      if (
        request.headers['x-tslaws'] !== '1' ||
        (origin !== undefined && new URL(origin).host !== request.headers.host)
      ) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const file = url.searchParams.get('file') ?? undefined;
      void cycle({ file, law: file === undefined ? undefined : (url.searchParams.get('law') ?? undefined) });
      response.writeHead(202).end('started');
    } else {
      response.writeHead(404).end('not found');
    }
  });

  const listen = (port: number): Promise<number> =>
    new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', fail);
        done((server.address() as { port: number }).port);
      });
    });
  let port: number;
  try {
    port = await listen(options.port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    port = await listen(0);
  }
  const url = `http://127.0.0.1:${port}/`;
  options.log(`tslaws ui: ${url}  (Ctrl+C exits)`);
  if (options.open) openInBrowser(url);

  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
    const name = filename === null ? null : String(filename);
    if (name === null || !name.endsWith('.ts') || name.split(/[\\/]/).some((part) => ignored.has(part))) return;
    clearTimeout(timer);
    timer = setTimeout(() => void cycle(), 300);
  });

  void cycle();
  return new Promise<number>((done) => {
    process.once('SIGINT', () => {
      clearTimeout(timer);
      watcher.close();
      for (const client of clients) client.end();
      server.close();
      done(0);
    });
  });
}
