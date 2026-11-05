// An esbuild plugin that loads `.tsrx` templates with the public Ripple compiler (@tsrx/ripple), for the
// bundlerPlugins setting. The compiled output imports the `ripple` runtime, which esbuild resolves from node_modules.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compile } from '@tsrx/ripple';

export default function tsrxPlugin() {
  return {
    name: 'tsrx',
    setup(build) {
      build.onLoad({ filter: /\.tsrx$/ }, (args) => {
        const { code } = compile(readFileSync(args.path, 'utf8'), args.path, { mode: 'client' });
        return { contents: code, loader: 'js', resolveDir: dirname(args.path) };
      });
    },
  };
}
