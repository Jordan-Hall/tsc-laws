// Regenerates src/tsgo and src/go/runtime.ts from the pinned TypeScript-Go checkout.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { patches } from './scriptc-patches.mjs';

const packages = ['parser', 'binder', 'checker', 'checkhost', 'api/encoder'];
const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
// build:oracle copies the relater bridge into the checkout; keep it out of the translation.
rmSync('../../upstream/typescript-go/internal/checker/relater_oracle.go', { force: true });
// The test host lives in this repository and is translated with the checker.
mkdirSync('../../upstream/typescript-go/internal/checkhost', { recursive: true });
for (const file of ['checkhost.go', 'tsc.go', 'project.go']) {
  copyFileSync('checkhost/' + file, '../../upstream/typescript-go/internal/checkhost/' + file);
}
run(
  'go',
  [
    'run',
    '.',
    // A portable target without embedded files: libs are read from disk at run time.
    '-goos',
    'wasip1',
    '-tags',
    'noembed',
    '-upstream',
    resolve('../../upstream/typescript-go'),
    '-overlay',
    resolve('overlay'),
    '-out',
    resolve('src/tsgo'),
    ...packages,
  ],
  resolve('../gots'),
);
const oxfmt = resolve('../../node_modules/.bin/oxfmt');
run(oxfmt, ['src/tsgo', 'src/go/runtime.ts'], resolve('.'));
for (const { file, within, from, to, count = 1 } of patches) {
  let text = readFileSync(file, 'utf8');
  let start = 0;
  let end = text.length;
  if (within) {
    start = text.indexOf(within);
    end = text.indexOf('\n}\n', start) + 3;
    if (start < 0 || end < 3) throw new Error(`scriptc patch: ${within} not found in ${file}`);
  }
  const parts = text.slice(start, end).split(from);
  if (parts.length - 1 !== count) {
    throw new Error(`scriptc patch for ${file} matched ${parts.length - 1} times, expected ${count}: ${from}`);
  }
  text = text.slice(0, start) + parts.join(to) + text.slice(end);
  writeFileSync(file, text);
}
// Patches can change line lengths.
run(oxfmt, [...new Set(patches.map((p) => p.file))], resolve('.'));
