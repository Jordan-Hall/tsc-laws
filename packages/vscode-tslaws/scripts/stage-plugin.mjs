// Copies the tsserver plugin to node_modules/tslaws-ts-plugin, where tsserver looks for a plugin that an extension
// contributes (`typescriptServerPlugins`). It runs before the extension is packaged (`vscode:prepublish`), and the tests
// use it to build the folder VS Code would hand to tsserver. node_modules is ignored by git, so the source stays in ts-plugin/.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'ts-plugin');
const files = ['index.js', 'transform.js', 'package.json'];

/** @param {string} root the extension folder; the plugin lands in `root/node_modules/tslaws-ts-plugin` */
export function stagePlugin(root) {
  const target = join(root, 'node_modules', 'tslaws-ts-plugin');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of files) cpSync(join(source, file), join(target, file));
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`staged ${stagePlugin(join(here, '..'))}`);
