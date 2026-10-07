// Regenerates src/tsgo and src/go/runtime.ts from the pinned TypeScript-Go checkout.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const packages = ['parser', 'binder'];
const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(
  'go',
  ['run', '.', '-upstream', resolve('upstream/typescript-go'), '-out', resolve('src/tsgo'), ...packages],
  resolve('tools/gots'),
);
run(resolve('node_modules/.bin/oxfmt'), ['src/tsgo', 'src/go/runtime.ts'], resolve('.'));
