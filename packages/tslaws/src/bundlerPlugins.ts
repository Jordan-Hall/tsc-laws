// Bundler plugins: a project teaches the browser bundler a source format (`.tsrx`, `.svelte`, ...) by listing esbuild
// plugin modules under `bundlerPlugins` in tslaws.json. Each module default-exports an esbuild Plugin, or a function
// (sync or async) that takes `{ cwd }` and returns one.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'esbuild';

/** What a plugin factory receives. */
export interface BundlerPluginContext {
  /** The project root: the directory holding tslaws.json. */
  cwd: string;
}

export type BundlerPluginExport = Plugin | ((context: BundlerPluginContext) => Plugin | Promise<Plugin>);

/** The setting the messages name. */
export const bundlerPluginsSetting = 'bundlerPlugins';

/**
 * Loads each listed module (paths relative to `cwd`, where tslaws.json lives) with a dynamic import of its file URL.
 * Throws one error naming the setting and the module when a module is missing, throws while loading or in its
 * factory, or does not export a plugin, so the law file reports an `error` rather than the run crashing.
 */
export async function loadBundlerPlugins(cwd: string, paths: readonly string[] | undefined): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const path of paths ?? []) {
    const file = isAbsolute(path) ? path : resolve(cwd, path);
    const fail = (why: string): never => {
      throw new Error(`tslaws.json ${bundlerPluginsSetting}: cannot use "${path}" (${file}): ${why}`);
    };
    if (!existsSync(file)) fail('no such file; paths are relative to the directory of tslaws.json');
    let exported: unknown;
    try {
      exported = ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
    } catch (error) {
      return fail(`it failed to load: ${(error as Error).message}`);
    }
    let plugin: unknown = exported;
    if (typeof exported === 'function') {
      try {
        plugin = await (exported as (context: BundlerPluginContext) => unknown)({ cwd });
      } catch (error) {
        return fail(`its plugin function threw: ${(error as Error).message}`);
      }
    }
    const candidate = plugin as Partial<Plugin> | null;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate.name !== 'string' ||
      typeof candidate.setup !== 'function'
    )
      fail('its default export must be an esbuild plugin ({ name, setup }) or a function returning one');
    plugins.push(plugin as Plugin);
  }
  return plugins;
}

/**
 * Rewrites an esbuild failure into advice when the cause is a source format the bundler has no loader for (the usual
 * sign that a `bundlerPlugins` entry is missing). Other messages pass through unchanged.
 */
export function explainBundleError(error: Error): Error {
  const match = /No loader is configured for "(\.[^"]+)" files/.exec(error.message);
  if (match === null) return error;
  const extension = match[1]!;
  const advice =
    `the browser bundler cannot load "${extension}" files. Add a bundler plugin for that extension in tslaws.json ` +
    `"${bundlerPluginsSetting}", for example { "${bundlerPluginsSetting}": ["./tools/${extension.slice(1)}-plugin.mjs"] }, ` +
    `where the module default-exports an esbuild plugin whose onLoad({ filter: /\${extension}$/ }) returns the compiled ` +
    `JavaScript (see "Bundler plugins" in docs/laws.md)`;
  return new Error(`${advice}. esbuild said: ${error.message.split('\n')[0]}`);
}
