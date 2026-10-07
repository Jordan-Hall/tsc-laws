import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { oracleSources, sourceIdentity } from './source-identity.mjs';
const root = resolve('upstream/typescript-go');
const expected = JSON.parse(readFileSync('upstream.json', 'utf8')).commit;
const revision = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.stdout.trim() !== expected) throw new Error('Upstream revision does not match upstream.json');
mkdirSync(root + '/cmd/tsts-oracle', { recursive: true });
mkdirSync('dist', { recursive: true });
copyFileSync('tools/oracle/bridge.go', root + '/internal/checker/tsts_oracle.go');
copyFileSync('tools/oracle/main.go', root + '/cmd/tsts-oracle/main.go');
const result = spawnSync('go', ['build', '-o', resolve('dist/tsgo-oracle'), './cmd/tsts-oracle'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, GOARCH: process.arch === 'arm64' ? 'arm64' : 'amd64' },
});
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  // References for the translated scanner and parser.
  for (const name of ['scan-oracle', 'parse-oracle']) {
    mkdirSync(root + '/cmd/' + name, { recursive: true });
    copyFileSync('tools/' + name + '/main.go', root + '/cmd/' + name + '/main.go');
    const built = spawnSync('go', ['build', '-o', resolve('dist/' + name), './cmd/' + name], {
      cwd: root,
      stdio: 'inherit',
    });
    if (built.status !== 0) process.exitCode = built.status ?? 1;
  }
}
if (result.status === 0)
  writeFileSync(
    'dist/oracle-build.json',
    JSON.stringify({ revision: expected, sourceSha256: sourceIdentity(oracleSources), arch: process.arch }) + '\n',
  );
