// A project can write its laws as keywords (needs the tsc-laws compiler) or as calls (stock TypeScript), not a mix of both.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../dist/compile.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-mixed-'));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const keyword = "export law keywordLaw(a: number) {\n  return a === a;\n}\n";
const call = "import { law } from 'tslaws';\nlaw('call law', (a: number) => a === a);\n";

function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

describe('one syntax per project', () => {
  it('refuses keyword laws beside call laws, naming both files', () => {
    const dir = project('mixed', { 'a.laws.ts': keyword, 'b.laws.ts': call });
    assert.throws(
      () => readManifest('tsc.exe', ['a.laws.ts', 'b.laws.ts'], dir),
      (error: Error) => /mixes the two ways/.test(error.message) && error.message.includes('a.laws.ts') && error.message.includes('b.laws.ts'),
    );
  });

  it('reads call laws alone without the custom compiler', () => {
    const dir = project('calls', { 'b.laws.ts': call });
    assert.deepEqual(readManifest('tsc.exe', ['b.laws.ts'], dir).map((l) => l.name), ['call law']);
  });
});
