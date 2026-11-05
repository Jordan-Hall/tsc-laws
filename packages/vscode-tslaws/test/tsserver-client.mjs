// A real tsserver process, started the way VS Code starts it for an extension's plugin: `--globalPlugins` names the plugin
// and `--pluginProbeLocations` the extension folder whose node_modules holds it. No GUI.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ensurePlugin } = require('../src/plugin.js');
export const tsserverPath = require.resolve('typescript/lib/tsserver.js');
const here = path.dirname(fileURLToPath(import.meta.url));
export const tslawsPackage = path.resolve(here, '../../tslaws');
export const tslawsBuilt = fs.existsSync(path.join(tslawsPackage, 'dist', 'api.d.ts'));

/** A scratch project with `files` (relative path to text), a tsconfig, and `tslaws` linked when it is built. */
export function makeProject(files, { link = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tslaws-plugin-')));
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        types: [],
      },
      include: ['src'],
    }),
  );
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  if (link && tslawsBuilt) {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.symlinkSync(tslawsPackage, path.join(root, 'node_modules', 'tslaws'), 'junction');
  }
  return {
    root,
    file: (rel) => path.join(root, rel).replaceAll('\\', '/'),
    write,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * @param {{plugin?: boolean}} [options] `plugin: false` starts the same tsserver without the plugin, for contrast.
 */
export function startTsserver({ plugin = true } = {}) {
  const extension = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tslaws-ext-')));
  fs.cpSync(path.join(here, '..', 'ts-plugin'), path.join(extension, 'ts-plugin'), { recursive: true });
  ensurePlugin({ fs, path, extensionPath: extension });
  const args = [tsserverPath, '--suppressDiagnosticEvents', '--disableAutomaticTypingAcquisition'];
  if (plugin) args.push('--globalPlugins', 'tslaws-ts-plugin', '--pluginProbeLocations', extension);
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const pending = new Map();
  const events = [];
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const m = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString());
      if (m === null) return;
      const length = Number(m[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
      buffer = buffer.subarray(headerEnd + 4 + length);
      const message = JSON.parse(body);
      if (message.type === 'response' && pending.has(message.request_seq)) {
        pending.get(message.request_seq)(message);
        pending.delete(message.request_seq);
      } else if (message.type === 'event') events.push(message);
    }
  });
  let seq = 0;
  /** Sends a request and resolves with the response `body`; rejects when the server says it failed. */
  const request = (command, args = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`tsserver ${command} timed out\n${stderr}`)), 60000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.success) resolve(message.body);
        else reject(new Error(`tsserver ${command} failed: ${message.message}`));
      });
      child.stdin.write(JSON.stringify({ seq: id, type: 'request', command, arguments: args }) + '\n');
    });
  return {
    request,
    events,
    stderr: () => stderr,
    async open(file, projectRootPath) {
      await request('open', { file, projectRootPath });
    },
    async close() {
      child.stdin.end();
      child.kill();
      fs.rmSync(extension, { recursive: true, force: true });
    },
  };
}

/** line and offset (both 1-based, as tsserver speaks them) of `needle`'s first (or `nth`) occurrence in `text`. */
export function locate(text, needle, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`${needle} not in text`);
  const before = text.slice(0, at).split('\n');
  return { line: before.length, offset: before[before.length - 1].length + 1 };
}
