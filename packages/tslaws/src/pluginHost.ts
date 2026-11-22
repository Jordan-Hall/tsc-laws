// Source formats for laws that run in Node. Compiled laws are CommonJS and load through `require`, which cannot read a
// project format (`.tsrx`, `.svelte`). The project's `bundlerPlugins` (esbuild plugins) can, but they are asynchronous
// and `require` is not. A helper thread loads the plugins and runs esbuild on one file at a time; the requiring thread
// blocks on a shared flag (`Atomics.wait`) until the answer arrives, so the loader stays synchronous and each file is
// transformed by exactly the plugin that handles it in the browser. One helper per project, started on first need.
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import { explainNodeLoadError } from './bundlerPlugins.ts';

interface Host {
  worker: Worker;
  port: MessagePort;
  signal: Int32Array;
}

type Answer = { code: string } | { error: string; missingLoader?: boolean };

const hosts = new Map<string, Host>();
const waitLimitMs = 120_000;

function startHost(cwd: string, plugins: readonly string[]): Host {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const worker = new Worker(new URL(`./pluginWorker${extension}`, import.meta.url), {
    workerData: { cwd, plugins, port: port2, signal },
    transferList: [port2],
  });
  // Neither the helper nor its port may keep the process alive once the laws are done.
  worker.unref();
  port1.unref();
  return { worker, port: port1, signal };
}

/**
 * The source Node can run for `file`, a file in a format only the project's bundler plugins know: CommonJS for `require`,
 * an ES module for `import()`.
 */
export function transformPluginFile(
  file: string,
  cwd: string,
  plugins: readonly string[],
  format: 'cjs' | 'esm' = 'cjs',
): string {
  const key = `${cwd}\0${plugins.join('\0')}`;
  let host = hosts.get(key);
  if (host === undefined) {
    host = startHost(cwd, plugins);
    hosts.set(key, host);
  }
  Atomics.store(host.signal, 0, 0);
  host.worker.postMessage({ file, format });
  const waited = Atomics.wait(host.signal, 0, 0, waitLimitMs);
  const message = receiveMessageOnPort(host.port)?.message as Answer | undefined;
  if (waited === 'timed-out' || message === undefined)
    throw new Error(`cannot load "${file}": the bundlerPlugins helper did not answer within ${waitLimitMs / 1000}s`);
  if ('error' in message)
    throw message.missingLoader === true ? explainNodeLoadError(file, message.error) : new Error(message.error);
  return message.code;
}
