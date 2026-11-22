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
import { mergeProposal } from '../dist/mcp.js';

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

  it('keeps the kind of a browser or end-to-end proposal', () => {
    assert.equal(acceptedPathFor('src/foo.browser.proposed.laws.ts'), 'src/foo.browser.laws.ts');
    assert.equal(acceptedPathFor('src/foo.e2e.proposed.laws.ts'), 'src/foo.e2e.laws.ts');
    assert.equal(acceptedPathFor('src/foo.browser.laws.ts'), undefined);
    assert.equal(acceptedPathFor('src/foo.e2e.laws.ts'), undefined);
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
    // Three laws in math (the middle one declined), then the imports they add, then the one law of one.proposed.
    const answers = ['y', 'n', 'y', 'y', 'y'];
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

  it('moves a proposed browser or end-to-end law into the accepted file of the same kind', async () => {
    const dir = join(root, 'kinds');
    mkdirSync(join(dir, 'src'), { recursive: true });
    const browserLaw = [
      "import { mount } from 'tslaws/browser';",
      'export law mounts(n: number) => mount() !== undefined;',
      '',
    ].join('\n');
    const e2eLaw = [
      "import { open } from 'tslaws/e2e';",
      'export law opens(n: number) => open !== undefined;',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'src', 'shell-layout.browser.proposed.laws.ts'), browserLaw);
    writeFileSync(join(dir, 'src', 'shop.e2e.proposed.laws.ts'), e2eLaw);
    let output = '';
    const count = await promoteFiles(
      { cwd: dir, checkFile: async () => new Map(), ask: async () => 'y', out: (t) => (output += t) },
      ['src/shell-layout.browser.proposed.laws.ts', 'src/shop.e2e.proposed.laws.ts'],
    );
    assert.equal(count, 2);
    assert.deepEqual(
      parseLawFile(readFileSync(join(dir, 'src', 'shell-layout.browser.laws.ts'), 'utf8')).laws.map((l) => l.name),
      ['mounts'],
    );
    assert.deepEqual(
      parseLawFile(readFileSync(join(dir, 'src', 'shop.e2e.laws.ts'), 'utf8')).laws.map((l) => l.name),
      ['opens'],
    );
    assert.ok(!existsSync(join(dir, 'src', 'shell-layout.browser.proposed.laws.ts')));
    assert.ok(!existsSync(join(dir, 'src', 'shop.e2e.proposed.laws.ts')));
    assert.ok(!existsSync(join(dir, 'src', 'shell-layout.laws.ts')));
    assert.match(output, /moved to src\/shell-layout\.browser\.laws\.ts/);
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

describe('call-style laws', () => {
  const text = [
    "import { add } from './math';",
    '',
    "law('addition commutes', (a: number, b: number) => add(a, b) === add(b, a));",
    '',
    "// law('in a comment', (a: number) => true);",
    "law.proved('adding zero changes nothing', (a: number) => {",
    '  return add(a, 0) === a;',
    '});',
    '',
  ].join('\n');

  it('finds laws written as calls, by their name', () => {
    const parsed = parseLawFile(text);
    assert.deepEqual(
      parsed.laws.map((l) => l.name),
      ['addition commutes', 'adding zero changes nothing'],
    );
    assert.equal(parsed.imports.length, 1);
    assert.ok(parsed.laws[1]!.text.startsWith('law.proved('));
    assert.ok(parsed.laws[1]!.text.endsWith('});'));
  });

  it('replaces a call law of the same name when merging a proposal', () => {
    const merged = mergeProposal(
      text,
      [],
      [{ name: 'addition commutes', text: "law('addition commutes', (a: number) => true);" }],
    );
    assert.equal(parseLawFile(merged).laws.length, 2);
    assert.ok(merged.includes('(a: number) => true'));
    assert.ok(!merged.includes('add(a, b) === add(b, a)'));
  });
});

describe('helpers a promoted law uses', () => {
  const imports = ["import { LEVELS, type Level } from '../src/model';"];
  const promoteAll = (text: string, existing?: string): string => {
    const parsed = parseLawFile(text);
    return buildAccepted(existing, parsed.imports, parsed.laws, parsed.declarations);
  };
  const declared = (text: string): string[] => parseLawFile(text).declarations.flatMap((d) => d.names);

  it('finds helpers before and after the laws, with their names and the comments above them', () => {
    const text = [
      ...imports,
      'const before = 1;',
      'export law a(n: number) => n === before + after();',
      '/** Adds one. */',
      'function after() { return 1; }',
      '// keeps its own line',
      'const [x, { y }] = [1, { y: 2 }], z = 3;',
      'export law b(n: number) => n === n;',
      'export const ordinary = 1;',
      'doSomething();',
      '',
    ].join('\n');
    const { declarations } = parseLawFile(text);
    assert.deepEqual(
      declarations.map((d) => d.names),
      [['before'], ['after'], ['x', 'y', 'z'], ['ordinary']],
    );
    assert.equal(declarations[1]!.text, '/** Adds one. */\nfunction after() { return 1; }');
    assert.equal(declarations[2]!.text, '// keeps its own line\nconst [x, { y }] = [1, { y: 2 }], z = 3;');
    assert.ok(declarations[1]!.references.includes('after'));
  });

  it('leaves a comment that is separated by a blank line, or belongs to a law, out of the helper', () => {
    const text = '// about the law\nexport law a(n: number) => n === n;\n// about nothing\n\nconst h = 1;\n';
    assert.equal(parseLawFile(text).declarations[0]!.text, 'const h = 1;');
  });

  it('copies helpers declared before the laws, placed after the imports and before the laws', () => {
    const text = [
      ...imports,
      "const level = (n: number): Level => LEVELS[Math.abs(n) % LEVELS.length] ?? 'editors';",
      'export law covers(a: number) => level(a) === level(a);',
      '',
    ].join('\n');
    const out = promoteAll(text);
    assert.equal(
      out,
      [
        ...imports,
        '',
        "const level = (n: number): Level => LEVELS[Math.abs(n) % LEVELS.length] ?? 'editors';",
        '',
        'export law covers(a: number) => level(a) === level(a);',
        '',
      ].join('\n'),
    );
  });

  it('copies helpers declared after the laws, and keeps source order', () => {
    const text = [
      ...imports,
      'export law covers(a: number) { return second(a) === first(a); }',
      'const second = (n: number): number => first(n);',
      'const first = (n: number): number => n;',
      '',
    ].join('\n');
    const out = promoteAll(text);
    assert.deepEqual(declared(out), ['second', 'first']);
    assert.ok(out.indexOf('const first') < out.indexOf('export law'));
    assert.ok(out.indexOf('import') < out.indexOf('const second'));
  });

  it('copies helpers that other helpers use, transitively', () => {
    const text = [
      'export law a(n: number) => c(n) === 0;',
      'const base = 0;',
      'const b = (n: number): number => n * base;',
      'const c = (n: number): number => b(n);',
      'const unrelated = 7;',
      '',
    ].join('\n');
    assert.deepEqual(declared(promoteAll(text)), ['base', 'b', 'c']);
  });

  it('keeps the JSDoc comment of a helper', () => {
    const text =
      '/**\n * Picks a level.\n * @param n any number\n */\nfunction pick(n: number) { return n; }\nexport law a(n: number) => pick(n) === n;\n';
    const out = promoteAll(text);
    assert.ok(out.includes('/**\n * Picks a level.\n * @param n any number\n */\nfunction pick'));
  });

  it('copies type, interface, function and const helpers a law mentions', () => {
    const text = [
      'interface Viewer { level: number }',
      'type Flags = number;',
      'const Colour = { Red: 0, Blue: 1 } as const;',
      'function make(flags: Flags): Viewer { return { level: flags + Colour.Red }; }',
      'const person = (flags: Flags): Viewer => make(flags);',
      'export law a(f: number) => person(f).level === person(f).level;',
      'type Unused = string;',
      '',
    ].join('\n');
    const out = promoteAll(text);
    assert.deepEqual(declared(out), ['Viewer', 'Flags', 'Colour', 'make', 'person']);
    assert.ok(!out.includes('Unused'));
  });

  it('does not copy a helper no promoted law uses', () => {
    const text = 'const used = 1;\nconst unused = 2;\nexport law a(n: number) => n === used;\n';
    const out = promoteAll(text);
    assert.deepEqual(declared(out), ['used']);
    assert.ok(!out.includes('unused'));
  });

  it('does not copy a helper that only a law left behind uses', () => {
    const text =
      'const one = 1;\nconst two = 2;\nexport law a(n: number) => n === one;\nexport law b(n: number) => n === two;\n';
    const parsed = parseLawFile(text);
    const out = buildAccepted(undefined, parsed.imports, [parsed.laws[0]!], parsed.declarations);
    assert.deepEqual(declared(out), ['one']);
  });

  it('copies helpers for call-style laws', () => {
    const text = [
      "import { add } from './math';",
      'const twice = (n: number): number => add(n, n);',
      "law('doubling', (n: number) => twice(n) === add(n, n));",
      "law.proved('zero', () => twice(0) === 0);",
      'const unused = 1;',
      '',
    ].join('\n');
    const out = promoteAll(text);
    assert.deepEqual(declared(out), ['twice']);
    assert.deepEqual(
      parseLawFile(out).laws.map((l) => l.name),
      ['doubling', 'zero'],
    );
  });

  it('sees a helper used inside a template substitution', () => {
    const text =
      'const tag = (n: number) => `n${n}`;\nexport law a(n: number) { return `${tag(n)} } {`.length > 0; }\n';
    assert.deepEqual(declared(promoteAll(text)), ['tag']);
  });

  it('does not copy a helper whose name only appears as a property', () => {
    const text = 'const size = 1;\nexport law a(s: string) => s.size === s.size;\n';
    assert.deepEqual(declared(promoteAll(text)), []);
  });

  it('does not copy a helper the accepted file already has with the same text', () => {
    const existing = [
      ...imports,
      'const level = (n: number): number => n;',
      'export law old(a: number) => level(a) === a;',
      '',
    ].join('\n');
    const text = 'const level   =  (n: number): number =>\n  n;\nexport law fresh(a: number) => level(a) === a;\n';
    const out = promoteAll(text, existing);
    assert.equal(out.split('const level').length, 2);
    assert.deepEqual(
      parseLawFile(out).laws.map((l) => l.name),
      ['old', 'fresh'],
    );
  });

  it('places new helpers after the existing declarations of the accepted file', () => {
    const existing = [
      ...imports,
      'const mine = 1;',
      'export law old(a: number) => a === mine;',
      'const alsoMine = 2;',
      '',
    ].join('\n');
    const text = 'const added = 3;\nexport law fresh(a: number) => a === added;\n';
    const out = promoteAll(text, existing);
    assert.deepEqual(declared(out), ['mine', 'alsoMine', 'added']);
    assert.ok(out.indexOf('const added') > out.indexOf('const alsoMine'));
    assert.ok(out.indexOf('const added') < out.indexOf('export law fresh'));
  });

  it('refuses a helper of the same name with different text, and writes nothing', async () => {
    const existing = 'const level = (n: number): number => n + 1;\nexport law old(a: number) => level(a) > a;\n';
    const text = 'const level = (n: number): number => n;\nexport law fresh(a: number) => level(a) === a;\n';
    assert.throws(() => promoteAll(text, existing), /'level' is declared differently/);

    const dir = join(root, 'conflict');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'k.laws.ts'), existing);
    writeFileSync(join(dir, 'k.proposed.laws.ts'), text);
    let output = '';
    const count = await promoteFiles(
      { cwd: dir, checkFile: async () => new Map(), ask: async () => 'y', out: (t) => (output += t) },
      ['k.proposed.laws.ts'],
    );
    assert.equal(count, 0);
    assert.equal(readFileSync(join(dir, 'k.laws.ts'), 'utf8'), existing);
    assert.equal(readFileSync(join(dir, 'k.proposed.laws.ts'), 'utf8'), text);
    assert.match(output, /declared differently/);
  });

  it('treats helpers that differ inside a string or template literal as different', () => {
    const existing = "const sep = 'a b';\nexport law old(a: string) => a !== sep;\n";
    assert.throws(
      () => promoteAll("const sep = 'a  b';\nexport law fresh(a: string) => a !== sep;\n", existing),
      /'sep' is declared differently/,
    );
    assert.throws(
      () => promoteAll('const sep = `a  b`;\nexport law fresh(a: string) => a !== sep;\n', 'const sep = `a b`;\n'),
      /'sep' is declared differently/,
    );
  });

  it('still treats helpers that differ only in layout or comments as the same', () => {
    const existing = 'const sep = (n: number) =>\n  n + 1;\nexport law old(a: number) => sep(a) > a;\n';
    const text = 'const sep = (n: number) => n + 1; // note\nexport law fresh(a: number) => sep(a) > a;\n';
    assert.equal(declared(promoteAll(text, existing)).filter((n) => n === 'sep').length, 1);
  });

  it('refuses a helper whose name the accepted file imports', () => {
    const text = 'const helper = (n: number) => n;\nexport law fresh(a: number) => helper(a) === a;\n';
    for (const line of [
      "import { helper } from './helper';",
      "import * as helper from './helper';",
      "import tool, { other as helper } from './helper';",
      "import helper from './helper';",
    ])
      assert.throws(() => promoteAll(text, `${line}\n`), /'helper' is imported in the accepted file/);
  });

  it('refuses when a helper a law uses is missing from what would be written', () => {
    const parsed = parseLawFile('export law a(n: number) => n === ghost;\n');
    // A declaration whose copied text no longer declares its name: the safety net catches it.
    const broken = { names: ['ghost'], text: '/* ghost */', start: 0, end: 0, references: [] };
    assert.throws(
      () => buildAccepted(undefined, parsed.imports, parsed.laws, [broken]),
      /'ghost' is declared in the proposed file but would be missing/,
    );
  });

  it('moves helpers with the laws in promoteFiles and keeps them in a proposed file that keeps laws', async () => {
    const dir = join(root, 'partial');
    mkdirSync(dir, { recursive: true });
    const source = [
      'const one = 1;',
      'const two = (n: number): number => n + one;',
      'export law a(n: number) => two(n) > n;',
      'export law b(n: number) => two(n) !== n;',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'p.proposed.laws.ts'), source);
    const answers = ['y', 'n', 'y'];
    await promoteFiles(
      { cwd: dir, checkFile: async () => new Map(), ask: async () => answers.shift() ?? 'n', out: () => {} },
      ['p.proposed.laws.ts'],
    );
    const accepted = parseLawFile(readFileSync(join(dir, 'p.laws.ts'), 'utf8'));
    assert.deepEqual(
      accepted.declarations.flatMap((d) => d.names),
      ['one', 'two'],
    );
    assert.deepEqual(
      accepted.laws.map((l) => l.name),
      ['a'],
    );
    const left = parseLawFile(readFileSync(join(dir, 'p.proposed.laws.ts'), 'utf8'));
    assert.deepEqual(
      left.laws.map((l) => l.name),
      ['b'],
    );
    assert.deepEqual(
      left.declarations.flatMap((d) => d.names),
      ['one', 'two'],
    );
  });

  it('loses nothing a law uses when the proposed file is deleted', async () => {
    const dir = join(root, 'deleted');
    mkdirSync(dir, { recursive: true });
    const source = [
      "import { LEVELS, type Level } from './model';",
      'export law covers(a: number, b: number) {',
      '  const [x, y] = [level(a), level(b)];',
      '  return person(x).level === person(y).level || x !== y;',
      '}',
      "const level = (n: number): Level => LEVELS[Math.abs(n) % LEVELS.length] ?? 'editors';",
      '/** A viewer. */',
      'const person = (l: Level): { level: Level } => ({ level: l });',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'm.proposed.laws.ts'), source);
    await promoteFiles({ cwd: dir, checkFile: async () => new Map(), ask: async () => 'y', out: () => {} }, [
      'm.proposed.laws.ts',
    ]);
    assert.ok(!existsSync(join(dir, 'm.proposed.laws.ts')));
    const accepted = readFileSync(join(dir, 'm.laws.ts'), 'utf8');
    assert.deepEqual(
      parseLawFile(accepted).declarations.flatMap((d) => d.names),
      ['level', 'person'],
    );
    assert.ok(accepted.includes('/** A viewer. */\nconst person'));
  });
});
