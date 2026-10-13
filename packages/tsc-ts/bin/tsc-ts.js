#!/usr/bin/env node
// Runs the native tsc-ts executable from this platform's package. The lib
// files sit next to the executable, where it looks for them.
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { executableName, hostDescription, hostPlatform, packageName } from './platforms.js';

const platform = hostPlatform();
if (platform === undefined) fail(`no native executable for ${hostDescription()}`);

const name = packageName(platform);
let root;
try {
  root = dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
} catch {
  fail(`${name} is not installed; reinstall tsc-ts with optional dependencies enabled`);
}

const executable = join(root, 'lib', executableName());
if (process.platform !== 'win32') {
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    try {
      chmodSync(executable, 0o755);
    } catch {
      // spawnSync reports the error.
    }
  }
}

const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) fail(`could not run ${executable}: ${result.error.message}`);
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;

function fail(message) {
  process.stderr.write(`tsc-ts: ${message}\n`);
  process.exit(1);
}
