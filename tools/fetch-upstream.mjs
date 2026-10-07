import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const identity = JSON.parse(readFileSync('upstream.json', 'utf8'));
const root = resolve('upstream/typescript-go');
function git(args) {
  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('git failed: ' + args.join(' '));
}
if (!existsSync(root + '/.git')) {
  mkdirSync('upstream', { recursive: true });
  git(['clone', '--filter=blob:none', '--no-checkout', identity.repository, root]);
  git(['-C', root, 'sparse-checkout', 'set', '--cone', 'internal', 'cmd']);
}
const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (head.stdout.trim() !== identity.commit) {
  git(['-C', root, 'fetch', '--depth', '1', 'origin', identity.commit]);
}
// A --no-checkout clone of the pinned tip already has the right HEAD but an
// empty working tree, so always check out the commit.
git(['-C', root, 'checkout', '--detach', identity.commit]);
console.log('Pinned upstream: ' + identity.commit);
