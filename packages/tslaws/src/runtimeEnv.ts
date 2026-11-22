// What laws need at run time to load project code written for a bundler: `import.meta.env`, and relative imports without
// an extension in TypeScript files that Node loads itself. Nothing here loads the TypeScript compiler, so a property worker
// can import it.
import nodeModule from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The global that `import.meta.env` is rewritten to, in compiled laws, bundles and natively loaded TypeScript. */
export const importMetaEnvGlobal = '__tslawsImportMetaEnv';

/**
 * What esbuild's `define` should make of `import.meta` in a module of `file` that loads as CommonJS, where `import.meta`
 * does not exist: `env` is the runner's global, `url`, `filename` and `dirname` name the file, as they do in an ES module.
 */
export function importMetaDefines(file: string): Record<string, string> {
  const meta = { url: pathToFileURL(file).href, filename: file, dirname: dirname(file) };
  return {
    'import.meta': JSON.stringify(meta),
    'import.meta.url': JSON.stringify(meta.url),
    'import.meta.filename': JSON.stringify(meta.filename),
    'import.meta.dirname': JSON.stringify(meta.dirname),
    'import.meta.env': `globalThis.${importMetaEnvGlobal}`,
  };
}

/** The value of `import.meta.env` in every place a law runs. */
export type ImportMetaEnv = Record<string, string | boolean>;

/** The keys that are booleans, as in Vite; every other name is a string. */
const booleanKeys = new Set(['DEV', 'PROD', 'SSR']);

/** The `env` setting of tslaws.json: a name to a string, or to a boolean for `DEV`, `PROD` and `SSR` (and only those). */
export function parseEnvConfig(raw: unknown): Record<string, string | boolean> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error(`tslaws.json: "env" must be an object of names to strings, got ${JSON.stringify(raw)}`);
  for (const [key, value] of Object.entries(raw)) {
    const want = booleanKeys.has(key) ? 'boolean' : 'string';
    if (typeof value !== want)
      throw new Error(`tslaws.json: "env.${key}" must be a ${want}, got ${JSON.stringify(value)}`);
  }
  return raw as Record<string, string | boolean>;
}

/** The prefix of the `process.env` entries a page may see: Vite's convention for values that are safe to ship. */
const publicPrefix = 'VITE_';

/**
 * The environment of a law: every `process.env` entry in Node, but in a page only those that start with `VITE_` (a page
 * runs project and dependency code that could send what it reads, so credentials in the process stay out), then `MODE`
 * (`test`), `DEV` (true), `PROD` (false), `SSR` (true in Node, false in a page) and `BASE_URL` (`/`), then the `env` of
 * tslaws.json, which overrides all of it. `MODE` and `BASE_URL` keep the value `process.env` gives them.
 */
export function importMetaEnvOf(
  configured: Record<string, string | boolean> | undefined,
  surface: 'node' | 'browser',
  processEnv: NodeJS.ProcessEnv = process.env,
): ImportMetaEnv {
  const env: ImportMetaEnv = {};
  for (const [key, value] of Object.entries(processEnv))
    if (value !== undefined && (surface === 'node' || key.startsWith(publicPrefix))) env[key] = value;
  return {
    ...env,
    MODE: processEnv.MODE ?? 'test',
    DEV: true,
    PROD: false,
    SSR: surface === 'node',
    BASE_URL: processEnv.BASE_URL ?? '/',
    ...configured,
  };
}

/** Sets `import.meta.env` for everything loaded afterwards in this thread. */
export function setImportMetaEnv(env: ImportMetaEnv): void {
  (globalThis as Record<string, unknown>)[importMetaEnvGlobal] = env;
}

const sourceFile = /\.[cm]?tsx?$/;
const unresolved = ['.ts', '.tsx', '.mts', '.js', '/index.ts', '/index.tsx'];
const javascriptEnding = /\.[cm]?jsx?$/;
const slash = (path: string): string => path.replaceAll(String.fromCharCode(92), '/');

/** Whether `url` is project TypeScript: a TypeScript file that is not inside a dependency. */
function isProjectSource(url: string | undefined): boolean {
  if (url === undefined || !url.startsWith('file:')) return false;
  const path = slash(fileURLToPath(url));
  return sourceFile.test(path) && !path.includes('/node_modules/');
}

let installed: boolean | undefined;

/**
 * Teaches Node's own loading of TypeScript two things a bundler does: a relative import without an extension
 * (`export * from './database'`) finds the `.ts` file, and `import.meta.env` reads the environment of the laws. Both
 * apply to project TypeScript only, never to anything under `node_modules`. A third hook resolves a package whose
 * `exports` offer only an `import` condition when a law (compiled to CommonJS) requires it, as an ES import would; the
 * original error stands when that fails too. Needs `module.registerHooks`
 * (Node 22.15, 23.5 or later); on an older Node the hooks are skipped and such imports fail as they did before.
 * Returns whether the hooks are in place. Registers once per thread.
 */
export function installLoaderHooks(): boolean {
  if (installed !== undefined) return installed;
  installed = false;
  const { registerHooks } = nodeModule;
  if (typeof registerHooks !== 'function') return installed;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const { conditions } = context;
        if (
          (error as { code?: string }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' &&
          conditions.includes('require') &&
          !conditions.includes('import')
        ) {
          try {
            return nextResolve(specifier, {
              ...context,
              conditions: conditions.map((condition) => (condition === 'require' ? 'import' : condition)),
            });
          } catch {
            throw error;
          }
        }
        if (!specifier.startsWith('.') || !isProjectSource(context.parentURL)) throw error;
        const stem = specifier.replace(javascriptEnding, '');
        const candidates = unresolved.map((ending) => `${specifier}${ending}`);
        // `./a.js` names a `.ts` file in TypeScript, as `./a` does for a bundler.
        if (stem !== specifier) candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`);
        for (const candidate of candidates) {
          try {
            return nextResolve(candidate, context);
          } catch {
            // The next candidate.
          }
        }
        throw error;
      }
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (loaded.source === undefined || loaded.source === null || !isProjectSource(url)) return loaded;
      const text = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
      if (!text.includes('import.meta.env')) return loaded;
      return { ...loaded, source: text.replace(/\bimport\.meta\.env\b/g, `globalThis.${importMetaEnvGlobal}`) };
    },
  });
  installed = true;
  return installed;
}

/** Everything a law needs before its module loads: the hooks and the environment. */
export function prepareRuntime(env: ImportMetaEnv): void {
  installLoaderHooks();
  setImportMetaEnv(env);
}
