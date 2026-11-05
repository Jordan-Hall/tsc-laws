import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeFake, makeSpawn } from './fake-vscode.mjs';

const require = createRequire(import.meta.url);
const { ensurePlugin, PLUGIN_NAME } = require('../src/plugin.js');
const { activateExtension } = require('../src/host.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

function extensionFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tslaws-ext-'));
  fs.cpSync(path.join(here, '..', 'ts-plugin'), path.join(dir, 'ts-plugin'), { recursive: true });
  return dir;
}

test('the manifest contributes the plugin, for workspace TypeScript versions too', () => {
  assert.deepEqual(pkg.contributes.typescriptServerPlugins, [
    { name: PLUGIN_NAME, enableForWorkspaceTypeScriptVersions: true },
  ]);
  assert.ok(pkg.activationEvents.includes('onLanguage:typescript'));
  const plugin = JSON.parse(fs.readFileSync(path.join(here, '..', 'ts-plugin', 'package.json'), 'utf8'));
  assert.equal(plugin.name, PLUGIN_NAME);
  assert.ok(fs.existsSync(path.join(here, '..', 'ts-plugin', plugin.main)));
});

test('the plugin folder is shipped: ignore rules leave ts-plugin and src in', () => {
  const rules = fs.readFileSync(path.join(here, '..', '.vscodeignore'), 'utf8').split(/\r?\n/);
  assert.ok(!rules.some((r) => /^(\/)?ts-plugin/.test(r)));
  assert.ok(!rules.some((r) => /^(\/)?src/.test(r)));
});

test('ensurePlugin puts the plugin where tsserver looks, once', () => {
  const dir = extensionFolder();
  try {
    const first = ensurePlugin({ fs, path, extensionPath: dir });
    assert.equal(first.state, 'installed');
    assert.equal(first.changed, true);
    const target = path.join(dir, 'node_modules', PLUGIN_NAME);
    assert.deepEqual(fs.readdirSync(target).sort(), ['index.js', 'package.json', 'transform.js']);
    assert.equal(ensurePlugin({ fs, path, extensionPath: dir }).state, 'current');
    // an updated plugin is copied again
    fs.appendFileSync(path.join(dir, 'ts-plugin', 'transform.js'), '\n// new\n');
    assert.equal(ensurePlugin({ fs, path, extensionPath: dir }).changed, true);
    assert.match(fs.readFileSync(path.join(target, 'transform.js'), 'utf8'), /\/\/ new/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensurePlugin reports a missing source and a folder it cannot write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tslaws-ext-'));
  try {
    assert.equal(ensurePlugin({ fs, path, extensionPath: dir }).state, 'missing');
    const denied = {
      ...fs,
      mkdirSync: () => {
        throw new Error('read-only');
      },
    };
    fs.cpSync(path.join(here, '..', 'ts-plugin'), path.join(dir, 'ts-plugin'), { recursive: true });
    const r = ensurePlugin({ fs: denied, path, extensionPath: dir });
    assert.equal(r.state, 'error');
    assert.match(r.error, /read-only/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activation installs the plugin and restarts the TypeScript server only when it changed something', () => {
  const dir = extensionFolder();
  try {
    for (const expected of [1, 0]) {
      const fake = makeFake({ root: dir });
      const { spawn } = makeSpawn(() => {});
      activateExtension(fake.vscode, { subscriptions: [], extensionPath: dir }, { spawn, fs });
      assert.equal(fake.executed.filter(([id]) => id === 'typescript.restartTsServer').length, expected);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
