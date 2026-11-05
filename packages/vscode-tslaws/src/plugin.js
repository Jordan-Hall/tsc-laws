'use strict';

// The tsserver plugin lives in `ts-plugin/` in the extension. tsserver looks for a plugin that an extension contributes
// (`typescriptServerPlugins`) in `<extension>/node_modules/<name>`, and `vsce package --no-dependencies` leaves the root
// node_modules out of the .vsix. So the extension puts the plugin where tsserver looks, once, and says when it did so
// the TypeScript server can be restarted to load it. Pure apart from the `fs` and `path` it is given.

const PLUGIN_NAME = 'tslaws-ts-plugin';

/**
 * @param {{fs: typeof import('node:fs'), path: typeof import('node:path'), extensionPath: string}} io
 * @returns {{state: 'current' | 'installed' | 'missing' | 'error', changed: boolean, target?: string, error?: string}}
 */
function ensurePlugin({ fs, path, extensionPath }) {
  const source = path.join(extensionPath, 'ts-plugin');
  const target = path.join(extensionPath, 'node_modules', PLUGIN_NAME);
  try {
    if (!fs.existsSync(source)) return { state: 'missing', changed: false };
    let changed = false;
    for (const file of fs.readdirSync(source)) {
      const from = path.join(source, file);
      if (file.startsWith('.') || !fs.statSync(from).isFile()) continue;
      const text = fs.readFileSync(from);
      let current = null;
      try {
        current = fs.readFileSync(path.join(target, file));
      } catch {
        // not there yet
      }
      if (current !== null && Buffer.compare(current, text) === 0) continue;
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, file), text);
      changed = true;
    }
    return { state: changed ? 'installed' : 'current', changed, target };
  } catch (error) {
    return { state: 'error', changed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = { ensurePlugin, PLUGIN_NAME };
