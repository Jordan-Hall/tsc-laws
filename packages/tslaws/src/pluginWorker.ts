import { dirname } from 'node:path';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { build, type Plugin } from 'esbuild';
import { loadBundlerPlugins } from './bundlerPlugins.ts';
import { importMetaEnvGlobal } from './runtimeEnv.ts';

// The helper thread of pluginHost.ts: loads the project's bundler plugins once, then turns one file at a time into
// CommonJS with esbuild and the plugins. It answers on a port and then raises the shared flag the caller waits on.
const { cwd, plugins, port, signal } = workerData as {
  cwd: string;
  plugins: string[];
  port: MessagePort;
  signal: Int32Array;
};

let loaded: Promise<Plugin[]> | undefined;

async function transform(file: string): Promise<{ code: string }> {
  loaded ??= loadBundlerPlugins(cwd, plugins);
  const result = await build({
    entryPoints: [file],
    // Not bundled: an import in the output stays a `require`, so a module shared with the laws is the same instance.
    bundle: false,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    sourcemap: 'inline',
    outdir: dirname(file),
    plugins: await loaded,
    define: { 'import.meta.env': `globalThis.${importMetaEnvGlobal}` },
    logLevel: 'silent',
  });
  // A stylesheet has no meaning in Node: a plugin that answers with CSS leaves the module empty.
  const script = result.outputFiles.find((output) => /\.[cm]?js$/.test(output.path));
  return { code: script?.text ?? 'module.exports = {};' };
}

parentPort!.on('message', async ({ file }: { file: string }) => {
  try {
    port.postMessage(await transform(file));
  } catch (error) {
    const message = (error as Error).message;
    port.postMessage({ error: message, missingLoader: /No loader is configured for "/.test(message) });
  }
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
