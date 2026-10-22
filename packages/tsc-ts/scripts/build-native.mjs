// Builds the native tsc-ts, dist/tsc (`npm run build:native`; `--dev` for `npm run build:native:dev`). On Windows it
// first compiles native/pipe-win32.c, the named pipe server of `tsc-ts --api --pipe`, with zig (the linker scriptc
// uses there) and links it through native/pipe-win32.ffi.json.
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dev = process.argv.includes('--dev');
const windows = process.platform === 'win32';

const require = createRequire(join(root, 'package.json'));
const scriptcPackage = require.resolve('scriptc/package.json');
const scriptc = join(dirname(scriptcPackage), JSON.parse(readFileSync(scriptcPackage, 'utf8')).bin.scriptc);

const args = ['build', 'src/main.ts'];
args.push(
  ...(dev
    ? ['--optimization=dev']
    : ['--optimization=speed', '--detached-exit', '--profile-use=profiles/tsc-ts.profdata']),
);
if (windows) {
  mkdirSync(join(root, 'dist'), { recursive: true });
  run('zig', ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-c', 'native/pipe-win32.c', '-o', 'dist/pipe-win32.o']);
  args.push('--ffi', 'native/pipe-win32.ffi.json');
}
run(scriptc, [...args, ...process.argv.slice(2).filter((arg) => arg !== '--dev'), '-o', 'dist/tsc']);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
