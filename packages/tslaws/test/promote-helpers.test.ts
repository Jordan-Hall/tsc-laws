// Helper code is shown and confirmed before `promote` copies it, and a helper that could run code is refused.
// Pure file work: no compiler needed. Needs `npm run build`.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertImportStatements, helperProblem, parseLawFile, planAccepted, promoteFiles } from '../dist/promote.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-promote-helpers-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

const helperText = [
  "import { rate } from './rates';",
  '/** The step. */',
  'const step = (n: number): number => n + 1;',
  'export law grows(n: number) => step(n) > n && rate > 0;',
  '',
].join('\n');

async function run(
  name: string,
  text: string,
  over: { answers?: string[]; yes?: boolean } = {},
): Promise<{ output: string; asked: string[]; dir: string }> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'p.proposed.laws.ts'), text);
  const answers = over.answers ?? ['y', 'y'];
  const asked: string[] = [];
  let output = '';
  await promoteFiles(
    {
      cwd: dir,
      checkFile: async () => new Map(),
      ask: async (q) => {
        asked.push(q);
        return answers.shift() ?? 'n';
      },
      out: (t) => (output += t),
      yes: over.yes,
    },
    ['p.proposed.laws.ts'],
  );
  return { output, asked, dir };
}

describe('helper code is shown and confirmed before promote copies it', () => {
  it('prints every import and helper in full before asking, then writes them on y', async () => {
    const { output, asked, dir } = await run('shown', helperText);
    assert.match(output, /imports \(1\):\nimport \{ rate \} from '\.\/rates';/);
    assert.match(output, /helpers \(1\):\n\/\*\* The step\. \*\/\nconst step = \(n: number\): number => n \+ 1;/);
    assert.ok(output.indexOf('const step') < output.indexOf('1 law moved'));
    assert.match(asked[asked.length - 1]!, /add this helper code to p\.laws\.ts\? \[y\/N\]/);
    assert.match(readFileSync(join(dir, 'p.laws.ts'), 'utf8'), /const step =/);
  });

  it('writes nothing when the person declines the helper code', async () => {
    const { output, dir } = await run('declined', helperText, { answers: ['y', 'n'] });
    assert.match(output, /nothing promoted from p\.proposed\.laws\.ts/);
    assert.ok(!existsSync(join(dir, 'p.laws.ts')));
    assert.equal(readFileSync(join(dir, 'p.proposed.laws.ts'), 'utf8'), helperText);
  });

  it('treats an empty answer as no', async () => {
    const { dir } = await run('empty', helperText, { answers: ['y', ''] });
    assert.ok(!existsSync(join(dir, 'p.laws.ts')));
  });

  it('with yes, still prints the code but does not ask about it', async () => {
    const { output, asked, dir } = await run('yes', helperText, { answers: ['y'], yes: true });
    assert.match(output, /const step =/);
    assert.match(output, /adding it \(--yes\)/);
    assert.deepEqual(asked, ['promote grows? [y/N] ']);
    assert.match(readFileSync(join(dir, 'p.laws.ts'), 'utf8'), /const step =/);
  });

  it('lists the imports of a law that needs no helper, without a second question', async () => {
    const { output, asked } = await run(
      'imports-only',
      "import { rate } from './rates';\nexport law positive() => rate > 0;\n",
      { answers: ['y'] },
    );
    assert.match(output, /imports \(1\):/);
    assert.equal(asked.length, 1);
  });

  it('planAccepted returns the new imports and the copied helpers, and leaves out what the accepted file has', () => {
    const parsed = parseLawFile(helperText);
    const plan = planAccepted(undefined, parsed.imports, parsed.laws, parsed.declarations);
    assert.deepEqual(plan.imports, ["import { rate } from './rates';"]);
    assert.deepEqual(
      plan.declarations.map((d) => d.names),
      [['step']],
    );
    const again = planAccepted(plan.text, parsed.imports, [{ ...parsed.laws[0]!, name: 'other' }], parsed.declarations);
    assert.deepEqual(again.imports, []);
    assert.deepEqual(again.declarations, []);
  });
});

describe('helpers that could run code are refused', () => {
  const refused: [string, string, string, RegExp][] = [
    ['a call', 'boot', 'const boot = start();', /initialised with a call `start\(\)`/],
    ['new', 'when', 'const when = new Date();', /a new expression/],
    ['a tagged template', 'q', 'const q = sql`select 1`;', /a tagged template/],
    ['await', 'v', 'const v = await load();', /an await/],
    ['an assignment', 'b', 'const b = (a = 2);', /an assignment/],
    ['an update', 'c', 'const c = i++;', /an update/],
    ['delete', 'd', 'const d = delete globalThis.x;', /a delete/],
    ['import()', 'm', "const m = import('node:fs');", /an import\(\)/],
    ['an accessor', 'o', 'const o = { get x() { return run(); } };', /an accessor/],
    ['a spread', 'o', 'const o = { ...other };', /a spread/],
    ['a property read', 'p', 'const p = process.env;', /may run code/],
    ['a call inside an object', 'o', 'const o = { a: [1, run()] };', /a call `run\(\)`/],
    ['a computed method name', 'o', 'const o = { [sideEffect()]() {} };', /a computed key `\[sideEffect\(\)\]`/],
    ['a Symbol.dispose method', 'o', 'const o = { [Symbol.dispose]() {} };', /a dispose method/],
    ['a Symbol.asyncDispose method', 'o', 'const o = { async [Symbol.asyncDispose]() {} };', /a dispose method/],
    ['a computed key in a nested object', 'o', 'const o = { a: { b: [{ [run()]: 1 }] } };', /a computed key/],
    ['a computed property in an array of methods', 'o', 'const o = [{ [k]: () => 1 }];', /a computed key/],
    ['a setter', 'o', 'const o = { set x(v: number) { run(v); } };', /an accessor/],
    ['a spread of a call', 'o', 'const o = { ...run() };', /a spread/],
    ['an array spread of a call', 'o', 'const o = [...run()];', /a spread/],
    ['a class expression', 'C', 'const C = class { static x = run(); static { run(); } };', /may run code/],
    ['a using declaration', 'r', 'using r = acquire();', /are allowed helpers/],
    ['a BigInt division by zero', 'v', 'const v = 1n / 0n;', /may run code/],
    ['a BigInt mixed with a number', 'v', 'const v = 1n + 1;', /may run code/],
    ['a unary plus on a BigInt', 'v', 'const v = +1n;', /may run code/],
    ['an in test on a primitive', 'v', "const v = 'a' in 'b';", /may run code/],
    ['an instanceof test on a primitive', 'v', 'const v = 1 instanceof 1;', /may run code/],
    ['a comma expression', 'c', 'const c = (1, run());', /may run code/],
    ['a conditional', 'c', 'const c = ready ? run() : 1;', /may run code/],
    ['a property read in a method key', 'o', 'const o = { [a.b]: 1 };', /a computed key/],
    ['a call inside a template', 't', 'const t = `a${run()}`;', /a substitution/],
    ['a destructuring', 'a', 'const { a } = pick();', /destructuring/],
    ['a class', 'Maker', 'class Maker {}', /a class is not an allowed helper/],
    ['an enum', 'Colour', 'enum Colour { Red }', /an enum is not an allowed helper/],
    ['a namespace', 'N', 'namespace N { export const x = 1; }', /a namespace is not an allowed helper/],
  ];
  for (const [label, name, helper, message] of refused) {
    it(`promote refuses ${label}, writes nothing and asks nothing about it`, async () => {
      const text = `${helper}\nexport law uses() => typeof ${name} !== 'undefined';\n`;
      const { output, asked, dir } = await run(`refuse-${label.replaceAll(/\W+/g, '-')}`, text, {
        answers: ['y', 'y'],
        yes: true,
      });
      assert.match(output, message);
      assert.match(output, /nothing promoted from p\.proposed\.laws\.ts/);
      assert.match(output, /Helpers may only be function, type and interface declarations/);
      assert.equal(asked.length, 1);
      assert.ok(!existsSync(join(dir, 'p.laws.ts')));
      assert.equal(readFileSync(join(dir, 'p.proposed.laws.ts'), 'utf8'), text);
    });
  }

  it('an import() expression is a helper to refuse, not an import statement', () => {
    const parsed = parseLawFile("const m = import('node:fs');\nexport law a() => typeof m === 'object';\n");
    assert.deepEqual(parsed.imports, []);
    assert.deepEqual(
      parsed.declarations.map((d) => d.names),
      [['m']],
    );
  });

  it('assertImportStatements refuses anything that is not one import statement', () => {
    assertImportStatements(["import a from 'a';", "import './side-effect';", "import b = require('b');"]);
    assert.throws(() => assertImportStatements(["import('x');"]), /is not an import statement/);
    assert.throws(() => assertImportStatements(["import a from 'a'; run();"]), /is not an import statement/);
  });

  it('a side-effecting initialiser is not run or copied, even with --yes', async () => {
    const dir = join(root, 'side-effect');
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, 'ran.txt').replaceAll('\\', '/');
    const text = [
      "import { writeFileSync } from 'node:fs';",
      `const boot = writeFileSync('${marker}', 'x');`,
      'export law uses() => boot === undefined;',
      '',
    ].join('\n');
    const { output } = await run('side-effect', text, { answers: ['y'], yes: true });
    assert.match(output, /helper 'boot' is refused: const 'boot' is initialised with a call/);
    assert.ok(!existsSync(join(dir, 'p.laws.ts')));
    assert.ok(!existsSync(join(dir, 'ran.txt')));
  });

  it('does not refuse a helper no promoted law uses, nor one the accepted file already has', () => {
    const parsed = parseLawFile('const unused = start();\nconst ok = 1;\nexport law a() => ok === 1;\n');
    const plan = planAccepted(undefined, parsed.imports, parsed.laws, parsed.declarations);
    assert.deepEqual(
      plan.declarations.map((d) => d.names),
      [['ok']],
    );
    const have = 'const same = start();\n\nexport law first() => true;\n';
    const next = parseLawFile('const same = start();\nexport law second() => same === undefined;\n');
    assert.deepEqual(planAccepted(have, next.imports, next.laws, next.declarations).declarations, []);
  });

  it('refuses await using and using by their flags, not only by name', () => {
    assert.match(helperProblem('using r = acquire();') ?? '', /are allowed helpers/);
    assert.match(helperProblem('await using r = acquire();') ?? '', /./);
    assert.match(helperProblem('let l = 1;') ?? '', /are allowed helpers/);
    assert.match(helperProblem('var v = 1;') ?? '', /are allowed helpers/);
  });

  it('still allows functions, types, interfaces and consts of literals, functions, objects and arrays', () => {
    for (const helper of [
      'function f() { return run(); }',
      'type T = { a: number };',
      'interface I { a: number }',
      'const n = -1;',
      'const big = -1n;',
      'const sum = 1 + 2 * 3 + "a";',
      'const s = `plain`;',
      'const s2 = `a${1 + 2}`;',
      'const r = /x/g;',
      'const fn = function () { return run(); };',
      'const arrow = (): number => run();',
      'const table = { a: 1, b: [1, 2, { c: "x" }], m() { return run(); }, k: () => run(), ["key"]: 2 };',
      'const frozen = [1, 2, 3] as const;',
      'const alias = table;',
      'const withDefault = (a = run(), { b = run() } = {}) => a;',
      'const keyed = { ["lit"]() {}, [1]() {}, async f() {}, *g() {} };',
      'const typed = { a: 1 } satisfies { a: number };',
    ])
      assert.equal(helperProblem(helper), undefined, helper);
  });
});
