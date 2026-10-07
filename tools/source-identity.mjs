import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const checkerSources = [
  'src/cli.ts',
  'src/checker/flags.ts',
  'src/checker/types.ts',
  'src/checker/relater.ts',
  'src/checker/relation-cache.ts',
  'src/checker/arena.ts',
  'src/checker/inference.ts',
  'src/checker/indexed-types.ts',
  'src/checker/variance.ts',
  'src/checker/mapped-types.ts',
  'src/checker/conditional-types.ts',
  'src/checker/tuple-types.ts',
  'src/checker/template-types.ts',
  'src/checker/js-string.ts',
  'src/checker/index-signatures.ts',
  'src/checker/string-mappings.ts',
  'src/checker/case-mappings.ts',
];
export const oracleSources = ['tools/oracle/bridge.go', 'tools/oracle/main.go'];

export function sourceIdentity(paths) {
  const hash = createHash('sha256');
  for (const path of paths)
    hash
      .update(path + '\0')
      .update(readFileSync(path))
      .update('\0');
  return hash.digest('hex');
}
