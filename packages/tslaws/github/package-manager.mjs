// What the tslaws composite action needs to know about the repository's package manager, as plain functions so the
// logic is tested (test/github-action.test.ts) instead of living in shell. Node only; no dependencies.
//
//   node package-manager.mjs detect <dir> [requested]   prints npm|pnpm|yarn|bun
//   node package-manager.mjs install <pm> <dir>         a frozen install in <dir>
//   node package-manager.mjs bin <dir>                  prints the path of tslaws' bin, resolved from <dir>
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const managers = ['npm', 'pnpm', 'yarn', 'bun'];

/** Lockfiles in the order they decide: a repository with two (a migration half done) goes with the first. */
const lockfiles = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

function readPackageManagerField(dir) {
  try {
    const field = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).packageManager;
    return typeof field === 'string' ? field : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The package manager to use in `dir`. `requested` is the action's input: a name, or `auto` (the default) to read it
 * from the lockfile, then the `packageManager` field of package.json, then fall back to npm.
 */
export function detect(dir, requested = 'auto') {
  const asked = String(requested || 'auto').toLowerCase();
  if (asked !== 'auto') {
    if (!managers.includes(asked))
      throw new Error(`package-manager must be auto, ${managers.join(', ')}; got "${requested}"`);
    return asked;
  }
  for (const [file, manager] of lockfiles) if (existsSync(join(dir, file))) return manager;
  const field = readPackageManagerField(dir)?.split('@')[0];
  return managers.includes(field) ? field : 'npm';
}

/** Yarn 2+ (Berry) is told from classic by its config file or the `packageManager` field. */
export function isYarnBerry(dir) {
  if (existsSync(join(dir, '.yarnrc.yml'))) return true;
  const version = /^yarn@(\d+)/.exec(readPackageManagerField(dir) ?? '')?.[1];
  return version !== undefined && Number(version) >= 2;
}

/** The command that installs exactly what the lockfile says and fails if the lockfile is out of date. */
export function installCommand(manager, dir = '.') {
  if (manager === 'npm') return { command: 'npm', args: ['ci'] };
  if (manager === 'pnpm') return { command: 'pnpm', args: ['install', '--frozen-lockfile'] };
  if (manager === 'bun') return { command: 'bun', args: ['install', '--frozen-lockfile'] };
  if (manager === 'yarn')
    return { command: 'yarn', args: ['install', isYarnBerry(dir) ? '--immutable' : '--frozen-lockfile'] };
  throw new Error(`unknown package manager "${manager}"`);
}

/**
 * Where tslaws' bin is, found the way Node finds a package from `dir` (so it works with hoisted, nested and pnpm's
 * symlinked layouts alike), never by guessing `node_modules/.bin`.
 */
export function resolveBin(dir) {
  const require = createRequire(join(resolve(dir), 'noop.js'));
  const manifest = require.resolve('tslaws/package.json', { paths: [resolve(dir)] });
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
  const relative = typeof bin === 'string' ? bin : bin?.tslaws;
  if (typeof relative !== 'string') throw new Error(`${manifest} has no "tslaws" bin`);
  return join(dirname(manifest), relative);
}

function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === 'detect') {
    process.stdout.write(`${detect(rest[0] ?? '.', rest[1])}\n`);
    return 0;
  }
  if (verb === 'install') {
    const [manager, dir = '.'] = rest;
    const { command, args } = installCommand(manager, dir);
    // shell: true so the .cmd shims of pnpm, yarn and bun run on Windows runners too; the arguments are fixed above.
    const run = spawnSync(command, args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    if (run.error) throw run.error;
    return run.status ?? 1;
  }
  if (verb === 'bin') {
    process.stdout.write(`${resolveBin(rest[0] ?? '.')}\n`);
    return 0;
  }
  process.stderr.write('usage: package-manager.mjs detect <dir> [requested] | install <pm> <dir> | bin <dir>\n');
  return 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
