// Fetches TypeScript-Go at the pinned commit, and TypeScript's test cases at
// the commit it pins, as shallow sparse checkouts under upstream/.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const identity = JSON.parse(readFileSync('upstream.json', 'utf8'));

function git(args) {
  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('git failed: ' + args.join(' '));
}

function checkout(dir, url, commit, paths) {
  if (!existsSync(dir + '/.git')) {
    mkdirSync(dir, { recursive: true });
    git(['-C', dir, 'init', '-q']);
    git(['-C', dir, 'remote', 'add', 'origin', url]);
  }
  git(['-C', dir, 'sparse-checkout', 'set', '--cone', ...paths]);
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.stdout.trim() !== commit) {
    git(['-C', dir, 'fetch', '--depth', '1', '--filter=blob:none', 'origin', commit]);
  }
  git(['-C', dir, 'checkout', '-q', '--detach', commit]);
}

const root = resolve('upstream/typescript-go');
// _scripts holds ast.json, the AST schema scripts/generate-ast.mjs reads. The enums and API options of
// TypeScript 7's API package are the source of tsc-ts's public API types (scripts/generate-api.mjs).
checkout(root, identity.repository, identity.commit, [
  'internal',
  'cmd',
  '_scripts',
  '_packages/native-preview/src/enums',
  '_packages/native-preview/src/api',
]);
console.log('Pinned upstream: ' + identity.commit);

const tsCommit = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD:_submodules/TypeScript'], {
  encoding: 'utf8',
}).stdout.trim();
checkout(resolve('upstream/TypeScript'), 'https://github.com/microsoft/TypeScript.git', tsCommit, [
  'tests/cases/compiler',
  'tests/cases/conformance',
]);
console.log('TypeScript test cases: ' + tsCommit);
