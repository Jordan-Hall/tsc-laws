// `tslaws promote`: the pure core and the people-only refusal. Needs `npm run build`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acceptedPathFor,
  buildAccepted,
  buildRemaining,
  dedupeImports,
  parseLawFile,
  promoteFiles,
} from '../dist/promote.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-promote-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

const proposed = `import { add } from './math';
import type { Point } from './math';

export law addCommutes(a: number, b: number) => add(a, b) === add(b, a);

// a comment with a } brace and "export law fake"
export law proved addIdentity(a: number) {
  const s = \`\${a} } {\`;
  if (s.length < 0) return false;
  return add(a, 0) === a;
}

export law last(p: Point) => p.x === p.x;
`;

describe('parseLawFile', () => {
  it('finds imports and both law forms, skipping braces in strings, comments and templates', () => {
    const parsed = parseLawFile(proposed);
    assert.deepEqual(parsed.imports, ["import { add } from './math';", "import type { Point } from './math';"]);
    assert.deepEqual(
      parsed.laws.map((l) => l.name),
      ['addCommutes', 'addIdentity', 'last'],
    );
    assert.equal(parsed.laws[0]!.text, 'export law addCommutes(a: number, b: number) => add(a, b) === add(b, a);');
    assert.ok(parsed.laws[1]!.text.startsWith('export law proved addIdentity'));
    assert.ok(parsed.laws[1]!.text.endsWith('}'));
    assert.equal(parsed.laws[2]!.text, 'export law last(p: Point) => p.x === p.x;');
  });

  it('ignores ordinary exports', () => {
    assert.deepEqual(parseLawFile('export const law = 1;\nexport function f() { return 1; }\n').laws, []);
  });
});

describe('acceptedPathFor', () => {
  it('maps foo.proposed.laws.ts to foo.laws.ts', () => {
    assert.equal(acceptedPathFor('src/foo.proposed.laws.ts'), 'src/foo.laws.ts');
    assert.equal(acceptedPathFor('src/foo.laws.ts'), undefined);
  });
});

describe('building files', () => {
  const parsed = parseLawFile(proposed);

  it('creates the accepted file with the imports', () => {
    const text = buildAccepted(undefined, parsed.imports, [parsed.laws[0]!]);
    assert.equal(text, `${parsed.imports.join('\n')}\n\n${parsed.laws[0]!.text}\n`);
  });

  it('appends to an existing file and keeps imports de-duplicated', () => {
    const existing = "import { add } from './math';\n\nexport law old(a: number) => add(a, 0) === a;\n";
    const text = buildAccepted(existing, parsed.imports, [parsed.laws[0]!, parsed.laws[2]!]);
    assert.equal(text.split("import { add } from './math'").length, 2);
    assert.ok(text.includes("import type { Point } from './math';"));
    assert.deepEqual(
      parseLawFile(text).laws.map((l) => l.name),
      ['old', 'addCommutes', 'last'],
    );
    assert.ok(text.indexOf('import type') < text.indexOf('export law old'));
  });

  it('refuses a name the accepted file already has', () => {
    const existing = 'export law last(p: number) => true;\n';
    assert.throws(() => buildAccepted(existing, [], [parsed.laws[2]!]), /already exists/);
  });

  it('removes promoted laws from the proposed file, or all of it when none is left', () => {
    const remaining = buildRemaining(proposed, ['addCommutes', 'last'])!;
    assert.deepEqual(
      parseLawFile(remaining).laws.map((l) => l.name),
      ['addIdentity'],
    );
    assert.ok(!remaining.includes('addCommutes'));
    assert.equal(buildRemaining(proposed, ['addCommutes', 'addIdentity', 'last']), undefined);
  });

  it('dedupes imports ignoring whitespace', () => {
    assert.deepEqual(dedupeImports(['import {a} from "x";'], ['import  {a}  from "x";', 'import b from "y";']), [
      'import {a} from "x";',
      'import b from "y";',
    ]);
  });
});

describe('promoteFiles', () => {
  it('moves the approved laws, deletes an emptied proposed file and never writes the lock', async () => {
    const dir = join(root, 'flow');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'math.proposed.laws.ts'), proposed);
    writeFileSync(join(dir, 'src', 'one.proposed.laws.ts'), 'export law only(a: number) => a === a;\n');
    const answers = ['y', 'n', 'y', 'y'];
    let output = '';
    const count = await promoteFiles(
      {
        cwd: dir,
        checkFile: async () => new Map([['addCommutes', 'tested']]),
        ask: async () => answers.shift() ?? 'n',
        out: (t) => (output += t),
      },
      ['src/math.proposed.laws.ts', 'src/one.proposed.laws.ts'],
    );
    assert.equal(count, 3);
    const accepted = readFileSync(join(dir, 'src', 'math.laws.ts'), 'utf8');
    assert.deepEqual(
      parseLawFile(accepted).laws.map((l) => l.name),
      ['addCommutes', 'last'],
    );
    assert.deepEqual(
      parseLawFile(readFileSync(join(dir, 'src', 'math.proposed.laws.ts'), 'utf8')).laws.map((l) => l.name),
      ['addIdentity'],
    );
    assert.ok(!existsSync(join(dir, 'src', 'one.proposed.laws.ts')));
    assert.ok(existsSync(join(dir, 'src', 'one.laws.ts')));
    assert.ok(!existsSync(join(dir, 'tsc-laws.lock')));
    assert.match(output, /\[tested\]/);
    assert.match(output, /tslaws accept/);
  });
});

describe('promote command', () => {
  it('refuses without a terminal, under CI and as an agent, and changes nothing', () => {
    const dir = join(root, 'refuse');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.proposed.laws.ts'), 'export law a(n: number) => n === n;\n');
    for (const env of [{}, { CI: '1' }, { TSLAWS_AGENT: '1' }]) {
      const run = spawnSync(process.execPath, [join(here, '..', 'bin', 'tslaws.js'), 'promote', '--all'], {
        cwd: dir,
        input: 'y\ny\n',
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /needs a person at a terminal/);
    }
    assert.ok(existsSync(join(dir, 'a.proposed.laws.ts')));
    assert.ok(!existsSync(join(dir, 'a.laws.ts')));
  });
});
