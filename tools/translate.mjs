// Regenerates src/tsgo and src/go/runtime.ts from the pinned TypeScript-Go checkout.
import { copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const packages = ['parser', 'binder', 'checker', 'tststest'];
const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
// The test host lives in this repository and is translated with the checker.
mkdirSync('upstream/typescript-go/internal/tststest', { recursive: true });
copyFileSync('tools/checkhost/checkhost.go', 'upstream/typescript-go/internal/tststest/checkhost.go');
run(
  'go',
  ['run', '.', '-upstream', resolve('upstream/typescript-go'), '-out', resolve('src/tsgo'), ...packages],
  resolve('tools/gots'),
);
run(resolve('node_modules/.bin/oxfmt'), ['src/tsgo', 'src/go/runtime.ts'], resolve('.'));
