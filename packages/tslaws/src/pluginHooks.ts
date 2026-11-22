// The module hooks for `bundlerPlugins` in node laws (the plugins themselves run in pluginHost.ts). `require` and
// `import()` reach a project format (`.tsrx`) by different roads, and the extension handler in lawRuntime.ts only
// serves `require`. `module.registerHooks` sits in front of both: it finds a template or stylesheet beside its source,
// and loads it through the plugins as a CommonJS module for `require` and an ES module for `import()`. Needs Node 22.15,
// 23.5 or later; on an older Node the extension handler still serves `require`.
import { extname } from 'node:path';
import nodeModule from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformPluginFile } from './pluginHost.ts';

/** What the hooks ask of the runtime: the project owning a file, and a relative import found beside the source. */
export interface PluginHookHost {
  ownerOf(file: string): { cwd: string; bundlerPlugins?: string[] } | undefined;
  beside(request: string, parent: { filename: string }): string | undefined;
}

const nodeExtensions = new Set(['', '.js', '.cjs', '.mjs', '.json', '.node', '.ts', '.tsx', '.mts', '.cts']);

/** Whether Node cannot load a file with this extension itself, so a plugin must. */
export const pluginExtensionNeeded = (extension: string): boolean => !nodeExtensions.has(extension.toLowerCase());

let installed: boolean | undefined;

/** Registers the hooks once per thread; returns whether they are in place. */
export function installPluginHooks(host: PluginHookHost): boolean {
  if (installed !== undefined) return installed;
  installed = false;
  const { registerHooks } = nodeModule;
  if (typeof registerHooks !== 'function') return installed;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : undefined;
        const file = parent === undefined ? undefined : host.beside(specifier, { filename: parent });
        if (file === undefined) throw error;
        return { url: pathToFileURL(file).href, shortCircuit: true };
      }
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const file = fileURLToPath(url);
      if (!pluginExtensionNeeded(extname(file))) return nextLoad(url, context);
      const owner = host.ownerOf(file);
      const commonjs = context.conditions.includes('require');
      const source = transformPluginFile(
        file,
        owner?.cwd ?? process.cwd(),
        owner?.bundlerPlugins ?? [],
        commonjs ? 'cjs' : 'esm',
      );
      return { format: commonjs ? 'commonjs' : 'module', source, shortCircuit: true };
    },
  });
  installed = true;
  return installed;
}
