import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { oracleSources, sourceIdentity } from './source-identity.mjs';
const root = resolve('../../upstream/typescript-go');
const expected = JSON.parse(readFileSync('../../upstream.json', 'utf8')).commit;
const revision = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.stdout.trim() !== expected) throw new Error('Upstream revision does not match upstream.json');
mkdirSync(root + '/cmd/relater-oracle', { recursive: true });
mkdirSync('dist', { recursive: true });
// tsgo's oracles compile internal/checker, bridge included, so turbo.json runs tsgo's build:oracle after this one. The
// file usually exists already (the upstream checkout is cached), and copying over it truncates it first; the rename
// keeps a build that does run at the same time from reading it half written. Go ignores files starting with a dot.
copyFileSync('oracle/bridge.go', root + '/internal/checker/.relater_oracle.go.tmp');
renameSync(root + '/internal/checker/.relater_oracle.go.tmp', root + '/internal/checker/relater_oracle.go');
copyFileSync('oracle/main.go', root + '/cmd/relater-oracle/main.go');
const result = spawnSync('go', ['build', '-o', resolve('dist/tsgo-oracle'), './cmd/relater-oracle'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, GOARCH: process.arch === 'arm64' ? 'arm64' : 'amd64' },
});
process.exitCode = result.status ?? 1;
if (result.status === 0)
  writeFileSync(
    'dist/oracle-build.json',
    JSON.stringify({ revision: expected, sourceSha256: sourceIdentity(oracleSources), arch: process.arch }) + '\n',
  );
