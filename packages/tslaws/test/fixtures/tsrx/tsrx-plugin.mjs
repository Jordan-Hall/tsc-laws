// An esbuild plugin that loads `.tsrx` templates with the compiler from @crown/tsrx, for the bundlerPlugins setting.
//
// CROWN_TSRX_DIST names the compiler's build output (the `dist` directory of packages/framework/tsrx in the Crown
// repository), as a directory path or a file URL. The compiled output imports `@crown/framework/*`, which resolves
// from the Crown checkout: CROWN_ROOT, or the directory four levels above `dist`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

// What @crown/tsrx's Bun plugin does: the compiler emits TSX for the framework's classic factory.
const factoryImport =
  "import { createElement as __crownJsx, Fragment as __crownFragment } from '@crown/framework/tsx';\n";

function distDirectory() {
  const value = process.env.CROWN_TSRX_DIST;
  if (value === undefined || value === '') throw new Error('CROWN_TSRX_DIST is not set');
  const directory = value.startsWith('file:') ? fileURLToPath(value) : resolve(value);
  if (!existsSync(join(directory, 'index.js')))
    throw new Error(
      `CROWN_TSRX_DIST (${directory}) has no index.js: build @crown/tsrx first (\`bun run build\` in packages/framework/tsrx)`,
    );
  return directory;
}

export default async function tsrxPlugin() {
  const dist = distDirectory();
  const { compile, accessibilityFailures } = await import(pathToFileURL(join(dist, 'index.js')).href);
  const crownRoot = process.env.CROWN_ROOT ?? resolve(dist, '../../../..');
  return {
    name: 'crown-tsrx',
    setup(build) {
      // The compiled output (and a law that mounts it) imports @crown/framework, which lives in the Crown checkout,
      // not beside the template. esbuild ignores nodePaths set here, so resolve those imports from there. The laws are
      // compiled to CommonJS, so the import arrives as require(); the framework's exports offer only "import".
      build.onResolve({ filter: /^@crown\// }, async (args) => {
        if (args.pluginData !== undefined) return undefined; // a nested resolve from another plugin
        const found = await build.resolve(args.path, {
          kind: 'import-statement',
          resolveDir: crownRoot,
          pluginData: 'crown-tsrx',
        });
        return found.errors.length === 0 ? { path: found.path, external: found.external } : undefined;
      });
      build.onLoad({ filter: /\.tsrx$/ }, async (args) => {
        const output = compile(readFileSync(args.path, 'utf8'), args.path, { target: 'universal' });
        const failures = accessibilityFailures(args.path, output.a11y, () => {});
        if (failures) throw failures;
        const { code } = await transform(output.code, {
          loader: 'tsx',
          jsx: 'transform',
          jsxFactory: '__crownJsx',
          jsxFragment: '__crownFragment',
          sourcefile: args.path,
        });
        return { contents: factoryImport + code, loader: 'js', resolveDir: dirname(args.path) };
      });
    },
  };
}
