// Builds the reference scanner, parser, binder, and checker drivers and the tsgo command line from upstream.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve('../../upstream/typescript-go');
const expected = JSON.parse(readFileSync('../../upstream.json', 'utf8')).commit;
const revision = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.stdout.trim() !== expected) throw new Error('Upstream revision does not match upstream.json');
mkdirSync(root + '/internal/checkhost', { recursive: true });
for (const file of ['checkhost.go', 'tsc.go', 'project.go', 'api.go'])
  copyFileSync('checkhost/' + file, root + '/internal/checkhost/' + file);
// The tsgo command line, the reference for the translated tsc.
const tsgo = spawnSync('go', ['build', '-o', resolve('dist/tsgo'), './cmd/tsgo'], { cwd: root, stdio: 'inherit' });
if (tsgo.status !== 0) process.exitCode = tsgo.status ?? 1;
for (const name of ['scan-oracle', 'parse-oracle', 'bind-oracle', 'check-oracle']) {
  mkdirSync(root + '/cmd/' + name, { recursive: true });
  copyFileSync('oracles/' + name + '/main.go', root + '/cmd/' + name + '/main.go');
  const built = spawnSync('go', ['build', '-o', resolve('dist/' + name), './cmd/' + name], {
    cwd: root,
    stdio: 'inherit',
  });
  if (built.status !== 0) process.exitCode = built.status ?? 1;
}
