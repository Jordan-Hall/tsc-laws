// The build cache: an unchanged project is not compiled again; a changed law or a changed dependency is.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../dist/compile.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-cache-'));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

function project(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dep.ts'), 'export const double = (n: number): number => n * 2;\n');
  writeFileSync(
    join(dir, 'a.laws.ts'),
    "import { law } from 'tslaws';\nimport { double } from './dep';\nlaw('doubling is even', (n: number) => double(n) % 2 === 0);\n",
  );
  return dir;
}

const stamp = (dir: string): number => statSync(join(dir, '.tslaws', 'out', 'dep.js')).mtimeMs;

describe('build cache', () => {
  it('reuses the output of an unchanged project', () => {
    const dir = project('same');
    const first = build('builtin', ['a.laws.ts'], dir);
    const before = stamp(dir);
    const second = build('builtin', ['a.laws.ts'], dir);
    assert.equal(stamp(dir), before, 'the output was written again');
    assert.equal(second.key, first.key);
    assert.equal(second.ok, true);
  });

  it('builds again when a file the compiler read changes', () => {
    const dir = project('dep');
    const first = build('builtin', ['a.laws.ts'], dir);
    writeFileSync(join(dir, 'dep.ts'), 'export const double = (n: number): number => n * 3;\n');
    const second = build('builtin', ['a.laws.ts'], dir);
    assert.notEqual(second.key, first.key);
    assert.match(readFileSync(join(dir, '.tslaws', 'out', 'dep.js'), 'utf8'), /n \* 3/);
  });

  it('builds again when only the modification time of a dependency changes', () => {
    const dir = project('mtime');
    const first = build('builtin', ['a.laws.ts'], dir);
    const when = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'dep.ts'), when, when);
    assert.notEqual(build('builtin', ['a.laws.ts'], dir).key, first.key);
  });

  it('builds again when the law text changes', () => {
    const dir = project('law');
    const first = build('builtin', ['a.laws.ts'], dir);
    writeFileSync(
      join(dir, 'a.laws.ts'),
      "import { law } from 'tslaws';\nimport { double } from './dep';\nlaw('doubling is even', (n: number) => double(n) % 2 !== 1);\n",
    );
    const second = build('builtin', ['a.laws.ts'], dir);
    assert.notEqual(second.key, first.key);
    assert.match(readFileSync(join(dir, '.tslaws', 'out', 'a.laws.js'), 'utf8'), /!== 1/);
  });

  it('gives a law that uses node modules and globals node types without asking for them', () => {
    const dir = join(root, 'node');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'a.laws.ts'),
      "import { basename } from 'node:path';\nimport { law } from 'tslaws';\nlaw('names are stable', (s: string) => basename(s) === basename(s) && typeof process.platform === 'string');\n",
    );
    const built = build('builtin', ['a.laws.ts'], dir);
    assert.equal(built.diagnostics, '');
    assert.equal(built.ok, true);
  });

  it('judges a law on every global the compiler would include by default', () => {
    const dir = join(root, 'globals');
    mkdirSync(join(dir, 'node_modules', '@types', 'fake'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '@types', 'fake', 'index.d.ts'), 'declare const fakeGlobal: number;\n');
    writeFileSync(join(dir, 'node_modules', '@types', 'fake', 'package.json'), '{"name":"@types/fake","version":"1.0.0","types":"index.d.ts"}');
    writeFileSync(
      join(dir, 'a.laws.ts'),
      "import { law } from 'tslaws';\nlaw('globals are visible', (n: number) => typeof document === 'undefined' && fakeGlobal === fakeGlobal && n === n);\n",
    );
    const built = build('builtin', ['a.laws.ts'], dir);
    assert.equal(built.diagnostics, '');
    assert.equal(built.ok, true);
  });

  it('still reports a type error that no setup fixes', () => {
    const dir = join(root, 'real-error');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.laws.ts'), "import { law } from 'tslaws';\nlaw('wrong', (n: number) => nope(n));\n");
    const built = build('builtin', ['a.laws.ts'], dir);
    assert.equal(built.ok, false);
    assert.match(built.diagnostics, /nope/);
  });

  it('still reports a type error on the second run', () => {
    const dir = project('error');
    writeFileSync(join(dir, 'dep.ts'), "export const double = (n: number): number => 'x';\n");
    const first = build('builtin', ['a.laws.ts'], dir);
    const second = build('builtin', ['a.laws.ts'], dir);
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(second.diagnostics, first.diagnostics);
  });
});
