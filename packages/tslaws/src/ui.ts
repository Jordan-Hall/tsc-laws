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
import type { LawResult } from './types.ts';

export interface UiOptions {
  cwd: string;
  port: number;
  open: boolean;
  /** Runs the check of the project, or of just these law files. */
  run: (files?: string[]) => Promise<CheckReport>;
  log: (line: string) => void;
}

interface State {
  project: string;
  running: boolean;
  runs: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  report?: {
    ok: boolean;
    compileOk: boolean;
    compileDiagnostics: string;
    lockMissing: boolean;
    results: (LawResult & { hint?: string })[];
  };
  sources: Record<string, string>;
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
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // The URL is printed either way.
  }
}

/** Serves the dashboard until Ctrl+C. Resolves 0. */
export async function serveUi(options: UiOptions): Promise<number> {
  const cwd = resolve(options.cwd);
  const state: State = { project: basename(cwd), running: false, runs: 0, sources: {} };
  const clients = new Set<ServerResponse>();
  let queued = false;

  const push = (): void => {
    const data = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) client.write(data);
  };

  const cycle = async (only?: string): Promise<void> => {
    if (state.running) {
      queued = true;
      return;
    }
    do {
      queued = false;
      state.running = true;
      state.error = undefined;
      push();
      const started = Date.now();
      try {
        const report = await options.run(only === undefined ? undefined : [only]);
        const fresh = report.results.map((r) => ({ ...r, hint: hintFor(r) }));
        // One file's rerun replaces that file's results and keeps the others (and the coverage verdicts) as they were.
        const kept = only === undefined || state.report === undefined ? [] : state.report.results.filter((r) => r.file !== only);
        state.report = {
          ok: report.ok && kept.every((r) => ['proved', 'bounded', 'tested'].includes(r.status)),
          compileOk: report.compileOk,
          compileDiagnostics: report.compileDiagnostics,
          lockMissing: report.lockMissing,
          results: only === undefined ? fresh : [...kept, ...fresh.filter((r) => r.method !== 'coverage')],
        };
        const sources: Record<string, string> = {};
        for (const file of new Set(state.report.results.map((r) => r.file))) {
          const text = sourceOf(cwd, file);
          if (text !== undefined) sources[file] = text;
        }
        state.sources = sources;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      }
      state.runs += 1;
      state.durationMs = Date.now() - started;
      state.finishedAt = Date.now();
      state.running = false;
      push();
    } while (queued);
  };

  const hostOk = (request: IncomingMessage): boolean => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? '');

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
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(state));
    } else if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
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
      if (request.headers['x-tslaws'] !== '1' || (origin !== undefined && new URL(origin).host !== request.headers.host)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      void cycle(url.searchParams.get('file') ?? undefined);
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
