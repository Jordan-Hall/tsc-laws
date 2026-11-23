// Local HTTP ESM server for browser laws: gives every browser law a real `http://127.0.0.1:<port>` origin
// (localStorage, History API, Cookies, WebCrypto, relative fetch, native ESM), caches esbuild bundles once per
// `.browser.laws.ts` file instead of once per law, bundles a browser fast-check runner for zero-IPC in-browser
// property testing, and optionally reuses a project's Vite dev server middleware when configured.
import { existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, relative as pathRelative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundleWith, type Plugin } from 'esbuild';
import { explainBundleError, loadBundlerPlugins } from './bundlerPlugins.ts';
import { lawEnv, readConfig } from './coverage.ts';
import { compiledDirOf } from './lawRuntime.ts';
import { importMetaEnvGlobal } from './runtimeEnv.ts';

export interface BundledLawFile {
  id: string;
  js: string;
  css: string;
  cwd: string;
}

const assetExtensions = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
];

function projectModulesPlugin(cwd: string): Plugin {
  return {
    name: 'tslaws-project-modules',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === 'tslaws' || args.kind === 'entry-point' || /^[a-zA-Z]:/.test(args.path))
          return undefined;
        const found = await build.resolve(args.path, { kind: args.kind, resolveDir: cwd, pluginData: 'tslaws' });
        if (found.errors.length === 0)
          return { path: found.path, external: found.external, sideEffects: found.sideEffects };
        return args.path === 'axe-core' ? { path: 'axe-core', external: true } : undefined;
      });
    },
  };
}

function sourceFilesPlugin(cwd: string): Plugin {
  const out = join(cwd, '.tslaws', 'out');
  const project = compiledDirOf(cwd);
  return {
    name: 'tslaws-source-files',
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.resolveDir !== out && !args.resolveDir.startsWith(out + sep)) return undefined;
        const inOut = resolve(args.resolveDir, args.path);
        if (existsSync(inOut)) return undefined;
        const source = join(cwd, pathRelative(project, inOut));
        return existsSync(source) && !source.endsWith('.js') ? { path: source } : undefined;
      });
    },
  };
}

function bundlerTsconfig(cwd: string): { tsconfig: string } | { tsconfigRaw: string } | object {
  const setting = readConfig(cwd).tsconfig;
  if (setting === false) return { tsconfigRaw: '{}' };
  return setting === undefined ? {} : { tsconfig: resolve(cwd, setting) };
}

// Per-file bundle cache: keyed by `(cwd, jsFile, mtimeMs, size, plugins)` so a file with 20 laws bundles once.
const bundleCache = new Map<string, { stamp: string; bundle: Promise<BundledLawFile> }>();
const bundlesById = new Map<string, BundledLawFile>();
let nextBundleId = 1;

function fileStamp(cwd: string, jsFile: string): string {
  const config = readConfig(cwd);
  const plugins = (config.bundlerPlugins ?? []).join(',');
  try {
    const st = statSync(jsFile);
    return `${st.size}:${st.mtimeMs}:${plugins}:${String(config.tsconfig ?? '')}`;
  } catch {
    return `${Date.now()}:${plugins}`;
  }
}

/** Bundles `jsFile` once per file version and registers it with the local HTTP server. */
export async function bundleLawFile(jsFile: string, cwd: string): Promise<BundledLawFile> {
  const key = `${resolve(cwd)}\0${resolve(jsFile)}`;
  const stamp = fileStamp(cwd, jsFile);
  const cached = bundleCache.get(key);
  if (cached !== undefined && cached.stamp === stamp) return cached.bundle;
  const id = `b${nextBundleId++}`;
  const promise = (async (): Promise<BundledLawFile> => {
    const projectPlugins = await loadBundlerPlugins(cwd, readConfig(cwd).bundlerPlugins);
    try {
      const result = await bundleWith({
        plugins: [...projectPlugins, sourceFilesPlugin(cwd), projectModulesPlugin(cwd)],
        entryPoints: [jsFile],
        bundle: true,
        write: false,
        outdir: join(cwd, '.tslaws', 'bundle'),
        loader: Object.fromEntries(assetExtensions.map((extension) => [extension, 'dataurl' as const])),
        format: 'iife',
        globalName: '__lawModule',
        platform: 'browser',
        target: 'es2022',
        absWorkingDir: cwd,
        ...bundlerTsconfig(cwd),
        logLevel: 'silent',
        define: {
          'process.env.NODE_ENV': '"development"',
          global: 'globalThis',
          'import.meta.env': `globalThis.${importMetaEnvGlobal}`,
        },
      });
      const emitted = (extension: string): string =>
        result.outputFiles
          .filter((file) => file.path.endsWith(extension))
          .map((file) => file.text)
          .join('\n');
      const bundled: BundledLawFile = { id, js: emitted('.js'), css: emitted('.css'), cwd };
      bundlesById.set(id, bundled);
      return bundled;
    } catch (error) {
      bundleCache.delete(key);
      throw explainBundleError(error as Error);
    }
  })();
  bundleCache.set(key, { stamp, bundle: promise });
  return promise;
}

// Browser-bundled fast-check + plan + regression runner, built once per process and served at `/__tslaws/fc-runner.js`.
let fcRunnerPromise: Promise<string> | undefined;

function buildFcRunner(): Promise<string> {
  if (fcRunnerPromise !== undefined) return fcRunnerPromise;
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const planPath = join(dir, `plan${ext}`);
  const regressionsPath = join(dir, `regressions${ext}`);
  const entry = `
import * as fc from 'fast-check';
import { arbitraryOf } from ${JSON.stringify(planPath)};
import { decodeExample, encodeExample } from ${JSON.stringify(regressionsPath)};

window.__runPropertyInBrowser = async (spec) => {
  const generators = spec.plans.map(arbitraryOf);
  const none = generators.length === 0;
  const property = fc.asyncProperty(
    ...(none ? [fc.constant(undefined)] : generators),
    async (...args) => {
      const res = await window.__runLaw(spec.symbol, none ? [] : args, false, 0, true);
      if (res.discarded) {
        fc.pre(false);
        return true;
      }
      if (res.error) {
        const err = new Error(res.error.message);
        err.name = res.error.name || 'Error';
        if (res.error.stack) err.stack = res.error.stack;
        throw err;
      }
      return res.ok !== false;
    },
  );
  const examples = !none && Array.isArray(spec.regressionExamples) && spec.regressionExamples.length > 0
    ? spec.regressionExamples.map(decodeExample)
    : undefined;
  const details = await fc.check(property, {
    numRuns: none ? 1 : spec.runs,
    seed: spec.seed,
    maxSkipsPerRun: 100,
    ...(examples ? { examples } : {}),
  });
  let encoded;
  if (details.failed && details.counterexample !== null) {
    try { encoded = encodeExample(details.counterexample); } catch {}
  }
  const message = details.errorInstance instanceof Error ? details.errorInstance.message : undefined;
  const stack = details.errorInstance instanceof Error ? details.errorInstance.stack : undefined;
  return {
    failed: details.failed,
    numRuns: details.numRuns,
    seed: details.seed,
    counterexample: details.counterexample === null ? undefined : fc.stringify(details.counterexample),
    rawCounterexample: details.failed && details.counterexample !== null ? details.counterexample : undefined,
    encoded,
    regression: encoded !== undefined && Array.isArray(spec.regressionExamples) && spec.regressionExamples.includes(encoded),
    message,
    stack,
  };
};
`;
  fcRunnerPromise = bundleWith({
    stdin: { contents: entry, resolveDir: dir, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    // Stub out node:crypto / node:fs / node:path imported transitively by regressions.ts (only encodeExample/decodeExample are used).
    plugins: [
      {
        name: 'tslaws-node-stubs',
        setup(build) {
          build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-stub' }));
          build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
            contents: [
              'export const createHash = () => ({ update() { return this; }, digest() { return ""; } });',
              'export const existsSync = () => false;',
              'export const mkdirSync = () => undefined;',
              'export const readdirSync = () => [];',
              'export const readFileSync = () => "";',
              'export const rmSync = () => undefined;',
              'export const writeFileSync = () => undefined;',
              'export const join = (...p) => p.join("/");',
              'export const posix = { join: (...p) => p.join("/"), normalize: (p) => p };',
              'export const win32 = { join: (...p) => p.join("\\\\"), normalize: (p) => p };',
              'export const performance = globalThis.performance;',
              'export default {};',
            ].join('\n'),
          }));
        },
      },
    ],
  }).then((res) => res.outputFiles[0]!.text);
  fcRunnerPromise.catch(() => {
    fcRunnerPromise = undefined;
  });
  return fcRunnerPromise;
}

// Runs inside the page: clean DOM + storage + mocks before and after each input, revive generated functions.
export const pageHarnessScript = `
window.__runLaw = async (name, args, keep, pause, raw) => {
  const clean = async () => {
    for (const undo of (window.__tslawsCleanup || []).splice(0)) {
      try { await undo(); } catch (e) {}
    }
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
    document.body.innerHTML = '';
    if (typeof window.__tslawsBridge === 'function') {
      try { await window.__tslawsBridge({ action: 'resetMocks' }); } catch (e) {}
    }
  };
  const revive = (v) => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      if (Array.isArray(v.$tslawsFn)) {
        const samples = v.$tslawsFn;
        return (...a) => {
          let key = '';
          try { key = JSON.stringify(a) || ''; } catch (e) {}
          let h = 5381;
          for (let i = 0; i < key.length; i++) h = (Math.imul(h, 33) + key.charCodeAt(i)) | 0;
          return samples[(h >>> 0) % samples.length];
        };
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
    }
    return v;
  };
  await clean();
  try {
    const input = raw ? args : revive(args);
    const result = await window.__lawModule[name](...input);
    return { ok: result !== false };
  } catch (error) {
    if (error && error.name === 'LawDiscard') return { discarded: true };
    return {
      error: {
        name: error && error.name,
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? String(error.stack) : undefined,
      },
    };
  } finally {
    if (pause > 0) {
      window.__shown = true;
      await new Promise((done) => setTimeout(done, pause));
      window.__shown = false;
    }
    if (!keep) await clean();
  }
};
`;

const iframeHostHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>tslaws runner</title>
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}iframe{border:0;width:100%;height:100%;display:block;}</style>
</head>
<body>
<script>
window.__tslawsMountFrame = (src) => new Promise((resolve, reject) => {
  document.body.innerHTML = '';
  const frame = document.createElement('iframe');
  frame.name = 'tslaws-law-frame';
  frame.onload = () => resolve(true);
  frame.onerror = (e) => reject(e);
  frame.src = src;
  document.body.appendChild(frame);
});
</script>
</body>
</html>`;

interface ViteMiddlewareServer {
  middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  close(): Promise<void>;
}

const viteServers = new Map<string, Promise<ViteMiddlewareServer | undefined>>();

function hasViteConfig(cwd: string): boolean {
  return ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'].some((f) =>
    existsSync(join(cwd, f)),
  );
}

/** Starts Vite in middlewareMode for `cwd` when `vite` is requested/auto-detected and installed in the project. */
async function viteFor(cwd: string, mode: boolean | 'auto' | undefined): Promise<ViteMiddlewareServer | undefined> {
  if (mode === false || mode === undefined) return undefined;
  if (mode === 'auto' && !hasViteConfig(cwd)) return undefined;
  const root = resolve(cwd);
  const existing = viteServers.get(root);
  if (existing !== undefined) return existing;
  const starting = (async (): Promise<ViteMiddlewareServer | undefined> => {
    try {
      const req = createRequire(join(root, 'package.json'));
      const vite = req('vite') as {
        createServer: (opts: Record<string, unknown>) => Promise<ViteMiddlewareServer>;
      };
      return await vite.createServer({
        root,
        appType: 'custom',
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false, watch: null },
      });
    } catch {
      return undefined;
    }
  })();
  viteServers.set(root, starting);
  return starting;
}

let server: Server | undefined;
let serverUrl: Promise<string> | undefined;
let activeVite: ViteMiddlewareServer | undefined;

/** Ensures the local HTTP server for browser laws is listening and returns its base URL (`http://127.0.0.1:<port>`). */
export async function ensureBrowserServer(cwd?: string, viteMode?: boolean | 'auto'): Promise<string> {
  if (cwd !== undefined && viteMode !== undefined && viteMode !== false) {
    activeVite = await viteFor(cwd, viteMode);
  }
  if (serverUrl !== undefined) return serverUrl;
  serverUrl = new Promise<string>((resolveUrl, rejectUrl) => {
    const http = createServer((req, res) => {
      void handleRequest(req, res);
    });
    http.once('error', rejectUrl);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', rejectUrl);
      http.unref();
      server = http;
      const addr = http.address() as { port: number };
      resolveUrl(`http://127.0.0.1:${addr.port}`);
    });
  });
  return serverUrl;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/__tslaws/host') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(iframeHostHtml);
    return;
  }
  if (url.pathname === '/__tslaws/harness.js') {
    res
      .writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      .end(pageHarnessScript);
    return;
  }
  if (url.pathname === '/__tslaws/fc-runner.js') {
    try {
      const code = await buildFcRunner();
      res
        .writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        })
        .end(code);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
    return;
  }
  if (url.pathname === '/__tslaws/page') {
    const id = url.searchParams.get('id') ?? '';
    const bundle = bundlesById.get(id);
    if (bundle === undefined) {
      res.writeHead(404).end('unknown bundle');
      return;
    }
    const env = JSON.stringify(lawEnv(bundle.cwd, 'browser'));
    const style = bundle.css === '' ? '' : `<link rel="stylesheet" href="/__tslaws/style/${id}.css">`;
    const withFc = url.searchParams.get('fc') === '1' ? '<script src="/__tslaws/fc-runner.js"></script>' : '';
    const html = `<!doctype html><html><head><meta charset="utf-8">${style}<script>globalThis.${importMetaEnvGlobal} = ${env};</script></head><body><script src="/__tslaws/bundle/${id}.js"></script><script src="/__tslaws/harness.js"></script>${withFc}</body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
    return;
  }
  const styleMatch = /^\/__tslaws\/style\/([^/]+)\.css$/.exec(url.pathname);
  if (styleMatch !== null) {
    const bundle = bundlesById.get(styleMatch[1]!);
    if (bundle === undefined) {
      res.writeHead(404).end('');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' }).end(bundle.css);
    return;
  }
  const bundleMatch = /^\/__tslaws\/bundle\/([^/]+)\.js$/.exec(url.pathname);
  if (bundleMatch !== null) {
    const bundle = bundlesById.get(bundleMatch[1]!);
    if (bundle === undefined) {
      res.writeHead(404).end('');
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      .end(bundle.js);
    return;
  }
  if (activeVite !== undefined) {
    activeVite.middlewares(req, res, () => {
      if (!res.writableEnded) res.writeHead(404).end('not found');
    });
    return;
  }
  // Ignore favicon requests silently so the console stays clean.
  if (extname(url.pathname) === '.ico') {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(404).end('not found');
}

/** Stops the local browser HTTP server and any Vite middleware server. */
export async function closeBrowserServer(): Promise<void> {
  const http = server;
  server = undefined;
  serverUrl = undefined;
  activeVite = undefined;
  bundlesById.clear();
  bundleCache.clear();
  const vites = [...viteServers.values()];
  viteServers.clear();
  for (const v of vites) {
    try {
      await (await v)?.close();
    } catch {
      // Already closed.
    }
  }
  if (http !== undefined) {
    await new Promise<void>((done) => http.close(() => done()));
  }
}
