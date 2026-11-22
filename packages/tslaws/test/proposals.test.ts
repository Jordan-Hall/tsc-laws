// Proposals in .tslaws/proposals: writing is confined to that directory, imports are stored where they resolve, and
// `promote` is a person's act that moves a proposal into the tree without touching the lock. Pure file work: no
// compiler needed. Needs `npm run build`.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { promoteCommand, proposeCommand } from '../dist/cli.js';
import { grantFor } from '../dist/delegation.js';
import { discoverProposals } from '../dist/lawFiles.js';
import { defaultTarget, parseLawFile, promoteProposal, promotionTarget } from '../dist/promote.js';
import {
  addProposal,
  assertImportsAllowed,
  importsForTarget,
  normaliseProposal,
  ProposalError,
  proposalName,
  toStoredImports,
} from '../dist/proposals.js';

// The real path: the Windows runner's temp directory is an 8.3 short name that realpath expands.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tslaws-proposals-')));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
// A project is a git repository: an import is allowed only when git can say its file is not ignored.
function project(files: Record<string, string> = {}, repo = true): string {
  const cwd = join(root, `p${(n += 1)}`);
  mkdirSync(cwd, { recursive: true });
  if (repo) spawnSync('git', ['init', '-q'], { cwd });
  files = { 'src/cart.ts': 'export const total = (n: number): number => n;\n', ...files };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  return cwd;
}

const source = [
  "import type { int } from 'tslaws';",
  "import { total } from './src/cart';",
  'export law totalKeeps(n: int) { return total(n) === n; }',
  '',
].join('\n');

const tree = (cwd: string): string[] =>
  readdirSync(cwd, { recursive: true, encoding: 'utf8' })
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => !f.startsWith('.tslaws') && f !== '.git' && !f.startsWith('.git/') && f !== '.gitignore')
    .sort();

describe('import storage', () => {
  it('stores ./ imports relative to the proposals directory and leaves other imports alone', () => {
    const text = [
      "import { a } from './src/a';",
      "import type { B } from './src/nested/b';",
      "import { p } from 'tslaws/browser';",
      "import { up } from '../../already/stored';",
      "export * from './src/c';",
      "const lazy = () => import('./src/d');",
      '',
    ].join('\n');
    const stored = toStoredImports(text);
    assert.deepEqual(stored.split('\n').slice(0, 6), [
      "import { a } from '../../src/a';",
      "import type { B } from '../../src/nested/b';",
      "import { p } from 'tslaws/browser';",
      "import { up } from '../../already/stored';",
      "export * from '../../src/c';",
      "const lazy = () => import('../../src/d');",
    ]);
    assert.equal(toStoredImports(stored), stored);
  });

  it('refuses a root-relative import that leaves the project', () => {
    assert.throws(() => toStoredImports("import { x } from './../outside';"), /leaves the project/);
  });

  it('rewrites a stored proposal for the directory it moves to', () => {
    const stored =
      "import { a } from '../../src/a';\nimport { p } from 'tslaws/browser';\nimport { r } from '../../root';\n";
    assert.equal(
      importsForTarget(stored, 'src/cart'),
      "import { a } from '../a';\nimport { p } from 'tslaws/browser';\nimport { r } from '../../root';\n",
    );
    assert.equal(
      importsForTarget(stored, 'src'),
      "import { a } from './a';\nimport { p } from 'tslaws/browser';\nimport { r } from '../root';\n",
    );
    assert.equal(
      importsForTarget(stored, ''),
      "import { a } from './src/a';\nimport { p } from 'tslaws/browser';\nimport { r } from './root';\n",
    );
  });
});

describe('writing proposals', () => {
  it('writes inside .tslaws/proposals, merges by law name and imports once', () => {
    const cwd = project();
    const first = addProposal(cwd, 'cart.ts', source);
    assert.equal(first.file, '.tslaws/proposals/cart.ts');
    assert.deepEqual(first.laws, ['totalKeeps']);
    const text = readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8');
    assert.match(text, /from '\.\.\/\.\.\/src\/cart'/);
    addProposal(cwd, '.tslaws/proposals/cart.ts', source);
    addProposal(
      cwd,
      'cart.ts',
      "import { total } from './src/cart';\nexport law other(n: number) { return total(n) === total(n); }\n",
    );
    const merged = readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8');
    assert.equal(merged.split('export law').length, 3);
    assert.equal(merged.split("from '../../src/cart'").length, 2);
    assert.deepEqual(discoverProposals(cwd), ['.tslaws/proposals/cart.ts']);
    // The tree itself gained nothing.
    assert.deepEqual(tree(cwd), ['src', 'src/cart.ts']);
  });

  it('keeps only imports, laws and helper declarations, and needs a law', () => {
    const cwd = project();
    assert.throws(
      () => addProposal(cwd, 'a.ts', `${source}\nrequire('fs').rmSync('x');\n`),
      /only imports, law declarations and top-level const, function, type and interface declarations; found `require/,
    );
    assert.throws(() => addProposal(cwd, 'a.ts', "import { total } from './src/cart';\n"), /at least one law/);
    assert.throws(() => addProposal(cwd, 'a.ts', source, 'nope'), /must contain `export law nope`/);
    assert.deepEqual(discoverProposals(cwd), []);
  });

  describe('helpers', () => {
    it('refuses a helper that could run code, in propose, and writes nothing', () => {
      const cwd = project();
      for (const helper of [
        'const boot = start();',
        'const when = new Date();',
        'const q = sql`select 1`;',
        'class Maker {}',
        'const o = { ...other };',
        'const o = { [sideEffect()]() {} };',
        'const o = { [Symbol.dispose]() {} };',
        'using r = acquire();',
      ])
        assert.throws(() => addProposal(cwd, 'a.ts', `${helper}\n${source}`), /is refused|only imports, law/, helper);
      assert.deepEqual(discoverProposals(cwd), []);
      assert.throws(
        () => addProposal(cwd, 'a.ts', `const boot = start();\n${source}`),
        /helper 'boot' is refused: const 'boot' is initialised with a call `start\(\)`.*Helpers may only be function, type and interface declarations/,
      );
    });

    const helperSource = [
      "import { total } from './src/cart';",
      '',
      '/** How many items a generated cart holds. */',
      'const size = (n: number): number => Math.abs(Math.trunc(n)) % 50;',
      '',
      '// A cart line.',
      'interface Line { price: number }',
      'export type Cart = Line[];',
      '/** Builds a cart. */',
      'export function cartOf(n: number): Cart {',
      '  return Array.from({ length: size(n) }, () => ({ price: 1 }));',
      '}',
      '',
      'export law totalIsNeverNegative(n: number) { return total(cartOf(n).length) >= 0; }',
      '',
    ].join('\n');

    it('stores the helpers with their comments, after the imports and before the laws', () => {
      const cwd = project();
      const written = addProposal(cwd, 'cart.ts', helperSource);
      assert.deepEqual(written.laws, ['totalIsNeverNegative']);
      assert.deepEqual(written.helpers, ['size', 'Line', 'Cart', 'cartOf']);
      const text = readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8');
      assert.match(text, /from '\.\.\/\.\.\/src\/cart'/);
      assert.ok(text.includes('/** How many items a generated cart holds. */\nconst size ='), text);
      assert.ok(text.includes('// A cart line.\ninterface Line'), text);
      assert.ok(text.indexOf('import') < text.indexOf('const size'));
      assert.ok(text.indexOf('function cartOf') < text.indexOf('export law totalIsNeverNegative'));
      assert.equal(text.split('const size').length, 2);
    });

    it('keeps an identical helper once, replaces a changed one, and keeps the laws already there', () => {
      const cwd = project();
      addProposal(cwd, 'cart.ts', helperSource);
      addProposal(
        cwd,
        'cart.ts',
        'const size = (n: number): number => Math.abs(Math.trunc(n)) % 50;\nexport law other(n: number) { return size(n) >= 0; }\n',
      );
      let text = readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8');
      assert.equal(text.split('const size').length, 2);
      assert.ok(text.includes('/** How many items a generated cart holds. */\nconst size ='), text);
      addProposal(
        cwd,
        'cart.ts',
        'const size = (n: number): number => Math.abs(Math.trunc(n)) % 10;\nexport law third(n: number) { return size(n) < 10; }\n',
      );
      text = readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8');
      assert.equal(text.split('const size').length, 2);
      assert.ok(text.includes('% 10'));
      assert.ok(!text.includes('% 50'));
      assert.deepEqual(
        parseLawFile(text).laws.map((l) => l.name),
        ['totalIsNeverNegative', 'other', 'third'],
      );
      assert.deepEqual(
        parseLawFile(text).declarations.flatMap((d) => d.names),
        ['Line', 'Cart', 'cartOf', 'size'],
      );
    });

    it('refuses to replace one name of a declaration that binds several, and writes nothing', () => {
      const cwd = project();
      const law = 'export law pair(n: number) { return a + b === 3; }\n';
      addProposal(cwd, 'pair.ts', `const a = 1, b = 2;\n${law}`);
      const file = join(cwd, '.tslaws/proposals/pair.ts');
      const before = readFileSync(file, 'utf8');
      assert.throws(
        () => addProposal(cwd, 'pair.ts', 'const a = 5;\nexport law other(n: number) { return a === 5; }\n'),
        /'b' is declared together with 'a'/,
      );
      assert.equal(readFileSync(file, 'utf8'), before);
      // Sending every name of the statement again is a replacement.
      addProposal(cwd, 'pair.ts', 'const a = 1, b = 3;\nexport law other(n: number) { return a + b === 4; }\n');
      const text = readFileSync(file, 'utf8');
      assert.equal(text.split('const a').length, 2);
      assert.ok(text.includes('b = 3'));
    });

    it('refuses every top-level statement that is not a helper, and writes nothing', () => {
      const cwd = project();
      for (const stray of [
        "doSomething('x');",
        "require('fs').rmSync('x');",
        'let counter = 0;',
        'var shared = 1;',
        'if (true) { go(); }',
        'for (;;) {}',
        '{ go(); }',
        'export default 1;',
        'export { total };',
        "export * from './src/cart';",
        'class Thing { static { go(); } }',
        'enum Mode { A }',
        'namespace N { go(); }',
        'await go();',
        'const ok = 1;\nsideEffect();',
      ]) {
        assert.throws(() => addProposal(cwd, 'a.ts', `${source}\n${stray}\n`), ProposalError, stray);
        assert.throws(() => addProposal(cwd, 'a.ts', `${stray}\n${source}`), ProposalError, stray);
      }
      assert.deepEqual(discoverProposals(cwd), []);
      assert.ok(!existsSync(join(cwd, '.tslaws/proposals/a.ts')));
    });

    it('still checks the imports and the file name of a proposal that has helpers', () => {
      const cwd = project();
      assert.throws(
        () =>
          addProposal(
            cwd,
            'a.ts',
            `import { x } from './../outside';\nconst h = 1;\nexport law a(n: number) { return h === 1; }\n`,
          ),
        /leaves the project/,
      );
      assert.throws(() => addProposal(cwd, '../a.ts', helperSource), /not a proposal file/);
      assert.deepEqual(discoverProposals(cwd), []);
    });

    it('promotes with the helpers its laws use', async () => {
      const cwd = project();
      addProposal(cwd, 'cart.ts', `${helperSource}\nconst unused = 1;\n`);
      const out: string[] = [];
      const result = await promoteProposal(
        {
          cwd,
          checkFile: async () => new Map(),
          ask: async (q) => (q.includes('code to ') ? 'y' : ''),
          out: (t) => void out.push(t),
        },
        '.tslaws/proposals/cart.ts',
      );
      assert.equal(result.target, 'src/cart.laws.ts');
      assert.match(out.join(''), /helpers \(4\):\n/);
      assert.match(out.join(''), /const size = \(n: number\)/);
      const moved = readFileSync(join(cwd, 'src/cart.laws.ts'), 'utf8');
      assert.match(moved, /const size =/);
      assert.match(moved, /function cartOf/);
      assert.match(moved, /interface Line/);
      assert.match(moved, /from '\.\/cart'/);
      assert.match(moved, /export law totalIsNeverNegative/);
    });
  });

  it('refuses every name that is not a plain .ts file in the directory', () => {
    const cwd = project();
    for (const file of [
      '../x.ts',
      'src/cart.laws.ts',
      '.tslaws/out/x.ts',
      '.tslaws/proposals/sub/x.ts',
      '.tslaws/proposals/../x.ts',
      '/etc/x.ts',
      'C:\\x.ts',
      'x.js',
      'x.d.ts',
      '.dot.ts',
      'tsc-laws.lock',
      '',
    ]) {
      assert.throws(() => addProposal(cwd, file, source), ProposalError, file);
    }
    assert.deepEqual(tree(cwd), ['src', 'src/cart.ts']);
    assert.equal(proposalName('a.ts'), '.tslaws/proposals/a.ts');
  });

  it('refuses a proposals directory that is a link out of the project', () => {
    const cwd = project();
    const outside = join(root, `outside${n}`);
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(cwd, '.tslaws'), { recursive: true });
    symlinkSync(outside, join(cwd, '.tslaws', 'proposals'), 'junction');
    assert.throws(() => addProposal(cwd, 'a.ts', source), /link that leaves the project/);
    assert.deepEqual(readdirSync(outside), []);
  });

  it('refuses a .tslaws directory that is a link out of the project', () => {
    const cwd = project();
    const outside = join(root, `outside-tslaws${n}`);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(cwd, '.tslaws'), 'junction');
    assert.throws(() => addProposal(cwd, 'a.ts', source), /link that leaves the project/);
    assert.deepEqual(readdirSync(outside), []);
  });

  it('refuses a proposal file that is a link, and never writes through it', (t) => {
    const cwd = project();
    const victim = join(root, `victim${n}.ts`);
    writeFileSync(victim, 'original\n');
    mkdirSync(join(cwd, '.tslaws', 'proposals'), { recursive: true });
    try {
      symlinkSync(victim, join(cwd, '.tslaws', 'proposals', 'a.ts'), 'file');
    } catch {
      t.skip('this account cannot create file symlinks');
      return;
    }
    assert.throws(() => addProposal(cwd, 'a.ts', source), /is a link/);
    assert.equal(readFileSync(victim, 'utf8'), 'original\n');
    assert.deepEqual(discoverProposals(cwd), []);
  });

  it('stores the imports of a file placed there by hand, and nothing else', () => {
    const cwd = project();
    mkdirSync(join(cwd, '.tslaws', 'proposals'), { recursive: true });
    writeFileSync(join(cwd, '.tslaws/proposals/by-hand.ts'), source);
    assert.equal(normaliseProposal(cwd, '.tslaws/proposals/by-hand.ts'), true);
    assert.match(readFileSync(join(cwd, '.tslaws/proposals/by-hand.ts'), 'utf8'), /'\.\.\/\.\.\/src\/cart'/);
    assert.equal(normaliseProposal(cwd, '.tslaws/proposals/by-hand.ts'), false);
    assert.throws(() => normaliseProposal(cwd, 'src/cart.ts'), ProposalError);
  });
});

describe('promoting a proposal', () => {
  const host = (cwd: string, answers: string[], out: string[]) => ({
    cwd,
    checkFile: async () => new Map([['totalKeeps', 'tested']]),
    // The path question takes the next answer; the question about added import or helper code is answered y.
    ask: async (q: string) => (q.includes('code to ') ? 'y' : (answers.shift() ?? 'n')),
    out: (t: string) => void out.push(t),
  });

  it('suggests a path beside the source the proposal imports, else under laws/', () => {
    const cwd = project();
    addProposal(cwd, 'cart.ts', source);
    assert.equal(defaultTarget(cwd, '.tslaws/proposals/cart.ts'), 'src/cart.laws.ts');
    addProposal(cwd, 'plain.ts', 'export law ok(n: number) { return n === n; }\n');
    assert.equal(defaultTarget(cwd, '.tslaws/proposals/plain.ts'), 'laws/plain.laws.ts');
    addProposal(cwd, 'tree.laws.ts', source);
    assert.equal(defaultTarget(cwd, '.tslaws/proposals/tree.laws.ts'), 'src/tree.laws.ts');
  });

  it('moves it to the confirmed path, rewrites its imports, removes it and leaves the lock alone', async () => {
    const cwd = project({ 'tsc-laws.lock': '{"version":1,"laws":{},"exempt":[]}\n' });
    addProposal(cwd, 'cart.ts', source);
    const out: string[] = [];
    const result = await promoteProposal(host(cwd, [''], out), '.tslaws/proposals/cart.ts');
    assert.equal(result.target, 'src/cart.laws.ts');
    const moved = readFileSync(join(cwd, 'src/cart.laws.ts'), 'utf8');
    assert.match(moved, /from '\.\/cart'/);
    assert.doesNotMatch(moved, /\.\.\/\.\.\//);
    assert.match(moved, /export law totalKeeps/);
    assert.deepEqual(discoverProposals(cwd), []);
    assert.equal(readFileSync(join(cwd, 'tsc-laws.lock'), 'utf8'), '{"version":1,"laws":{},"exempt":[]}\n');
  });

  function hostFor(cwd: string, answers: string[], output: string[]) {
    return host(cwd, answers, output);
  }

  it('shows each law with its result and the lock reminder', async () => {
    const cwd = project();
    addProposal(cwd, 'cart.ts', source);
    const output: string[] = [];
    await promoteProposal(hostFor(cwd, [''], output), 'cart.ts');
    assert.match(output.join(''), /totalKeeps {2}\[tested\]/);
    assert.match(output.join(''), /The lock is unchanged/);
  });

  it('takes another path the person types, or --to, and rewrites imports for it', async () => {
    const cwd = project();
    addProposal(cwd, 'cart.ts', source);
    const output: string[] = [];
    const typed = await promoteProposal(hostFor(cwd, ['laws/deep/er/cart.laws.ts'], output), 'cart.ts');
    assert.equal(typed.target, 'laws/deep/er/cart.laws.ts');
    assert.match(readFileSync(join(cwd, 'laws/deep/er/cart.laws.ts'), 'utf8'), /from '\.\.\/\.\.\/\.\.\/src\/cart'/);
    addProposal(cwd, 'again.ts', source);
    const flagged = await promoteProposal(hostFor(cwd, ['y'], output), 'again.ts', 'specs/again.laws.ts');
    assert.equal(flagged.target, 'specs/again.laws.ts');
    assert.match(readFileSync(join(cwd, 'specs/again.laws.ts'), 'utf8'), /from '\.\.\/src\/cart'/);
  });

  it('merges into an existing laws file and refuses a name that is taken', async () => {
    const cwd = project({
      'src/cart.laws.ts':
        "import { total } from './cart';\nexport law existing(n: number) { return total(n) === n; }\n",
    });
    addProposal(cwd, 'cart.ts', source);
    const output: string[] = [];
    await promoteProposal(hostFor(cwd, [''], output), 'cart.ts');
    const merged = readFileSync(join(cwd, 'src/cart.laws.ts'), 'utf8');
    assert.ok(merged.includes('export law existing') && merged.includes('export law totalKeeps'));
    assert.equal(merged.split("from './cart'").length, 2);
    addProposal(cwd, 'clash.ts', source);
    await promoteProposal(hostFor(cwd, ['src/cart.laws.ts'], output), 'clash.ts');
    assert.match(output.join(''), /law 'totalKeeps' already exists in the accepted file; nothing moved/);
    assert.deepEqual(discoverProposals(cwd), ['.tslaws/proposals/clash.ts']);
  });

  it('moves nothing when the person declines, or names a path it refuses', async () => {
    const cwd = project();
    addProposal(cwd, 'cart.ts', source);
    const output: string[] = [];
    assert.deepEqual(await promoteProposal(hostFor(cwd, ['n'], output), 'cart.ts'), {});
    for (const bad of [
      '../out.laws.ts',
      'node_modules/x/a.laws.ts',
      '.tslaws/a.laws.ts',
      'src/notlaws.ts',
      '/abs/a.laws.ts',
      'src/a.proposed.laws.ts',
    ]) {
      assert.deepEqual(await promoteProposal(hostFor(cwd, [bad], output), 'cart.ts'), {}, bad);
    }
    assert.deepEqual(discoverProposals(cwd), ['.tslaws/proposals/cart.ts']);
    assert.deepEqual(tree(cwd), ['src', 'src/cart.ts']);
    assert.match(output.join(''), /nothing moved/);
  });

  it('refuses to promote a hand-written proposal whose import names unreviewed code, even when asked yes', async () => {
    const cwd = project();
    mkdirSync(join(cwd, '.tslaws/proposals'), { recursive: true });
    for (const [name, spec] of [
      ['nm', '../../node_modules/pkg/index.js'],
      ['up', '../../../outside'],
      ['own', './sibling'],
    ] as const) {
      writeFileSync(
        join(cwd, `.tslaws/proposals/${name}.ts`),
        `import { x } from '${spec}';\nexport law l${name}(n: number) { return x === n; }\n`,
      );
      const output: string[] = [];
      const yes = { ...host(cwd, ['src/hand.laws.ts'], output), yes: true };
      assert.deepEqual(await promoteProposal(yes, `${name}.ts`), {}, name);
      assert.match(output.join(''), /an import must name code that is inside the project.*nothing moved/s, name);
      assert.ok(!existsSync(join(cwd, 'src/hand.laws.ts')), name);
    }
  });

  it('accepts a path the laws setting names', () => {
    const cwd = project({ 'tslaws.json': JSON.stringify({ laws: ['specs/**/*.ts'] }) });
    assert.equal(promotionTarget(cwd, 'specs/cart.ts'), 'specs/cart.ts');
    assert.throws(() => promotionTarget(cwd, 'other/cart.ts'), /would not be found as a laws file/);
  });

  it('refuses a target reached through a link out of the project', () => {
    const cwd = project();
    const outside = join(root, `promote-out${n}`);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(cwd, 'linked'), 'junction');
    assert.throws(() => promotionTarget(cwd, 'linked/a.laws.ts'), /outside the project/);
  });
});

describe('an import must name reviewed code, however the specifier is spelled', () => {
  const imp = (specifier: string): string =>
    `import { x } from '${specifier.replaceAll('\\', '\\\\').replaceAll('\t', '\\t')}';\n`;
  const refused = /an import must name code that is inside the project/;
  const check = (cwd: string, specifier: string, fromDir = '.tslaws/proposals'): void =>
    assertImportsAllowed(cwd, imp(specifier), fromDir);

  it('allows a file inside the project, one that does not exist yet and a package', () => {
    const cwd = project();
    check(cwd, '../../src/cart');
    check(cwd, '../../src/not/yet/written');
    check(cwd, 'some-package');
    check(cwd, './sibling', 'src');
  });

  it('refuses any specifier with %, ? or # (percent escapes, queries, fragments, # aliases)', () => {
    const cwd = project();
    for (const bad of [
      '../../%2e%74slaws/proposals/evil',
      '../../.tslaws%2Fproposals/evil',
      '../../node%5Fmodules/pkg/index.js',
      '../../src/cart?x=1',
      '../../src/cart#frag',
      '#internal',
      'pkg?query',
      '../../src/car%74',
    ])
      assert.throws(() => check(cwd, bad), refused, bad);
  });

  it('refuses a control character in a specifier', () => {
    assert.throws(() => check(project(), '../../src/ca\trt'), refused);
  });

  it('compares the reserved directory names without regard to case', () => {
    const cwd = project();
    for (const bad of [
      '../../.TSLAWS/proposals/evil',
      '../../Node_Modules/pkg/index.js',
      '../../src/../.Git/config',
      '../proposals/../../.TsLaws/x',
    ])
      assert.throws(() => check(cwd, bad), /resolves into/, bad);
  });

  it('reads a path as a URL does: backslashes, dot segments and extra slashes cannot hide a reserved directory', () => {
    const cwd = project();
    for (const bad of ['..\\..\\node_modules\\pkg\\index.js', '.././../src/./../node_modules/pkg', '..//..//.tslaws/x'])
      assert.throws(() => check(cwd, bad), /resolves into/, bad);
    assert.throws(() => check(cwd, '//host/share/x'), refused);
    assert.throws(() => check(cwd, 'C:\\Windows\\x'), refused);
  });

  it('refuses a path that reaches a reserved directory through a link, and a file that does not exist yet there', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true });
    symlinkSync(join(cwd, 'node_modules', 'pkg'), join(cwd, 'src', 'alias'), 'junction');
    assert.throws(() => check(cwd, '../../src/alias/index.js'), /resolves into node_modules/);
    assert.throws(() => check(cwd, '../../src/alias/not/yet/there.js'), /resolves into node_modules/);
    assert.throws(() => check(cwd, '../../node_modules/new/pkg'), /resolves into node_modules/);
    const outside = join(root, `outside-import${n}`);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(cwd, 'src', 'out'), 'junction');
    assert.throws(() => check(cwd, '../../src/out/file.js'), /resolves outside the project/);
    assert.throws(() => check(cwd, '../../src/out/not/yet.js'), /resolves outside the project/);
  });

  it('refuses a git-ignored file, including one that does not exist yet', () => {
    const cwd = project({ '.gitignore': 'gen/\n', 'gen/rates.ts': 'export const rate = 1;\n' });
    assert.throws(() => check(cwd, '../../gen/rates'), /git ignores/);
    assert.throws(() => check(cwd, '../../gen/new'), /git ignores/);
    check(cwd, '../../src/cart');
  });

  it('refuses when the project is not in a git repository, because git cannot say what is ignored', () => {
    const cwd = project({}, false);
    assert.throws(() => check(cwd, '../../src/cart'), /could not be checked against git/);
    check(cwd, 'some-package');
  });

  it('refuses when git is not installed', () => {
    const cwd = project();
    const saved = process.env.PATH;
    process.env.PATH = join(root, 'no-such-bin');
    try {
      assert.throws(() => check(cwd, '../../src/cart'), /could not be checked against git/);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('the promote and propose commands', () => {
  const ctxFor = (over: Record<string, unknown> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      ctx: {
        isTTY: true,
        env: {},
        out: (t: string) => void out.push(t),
        err: (t: string) => void err.push(t),
        ...over,
      },
    };
  };

  it('promote refuses without a terminal, under CI, as an agent and with TSLAWS_AGENT, changing nothing', async () => {
    const cwd = project();
    addProposal(cwd, 'cart.ts', source);
    const before = readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8');
    for (const over of [
      { isTTY: false },
      { env: { CI: '1' } },
      { env: { TSLAWS_AGENT: '1' } },
      { env: { TSLAWS_AGENT: '' } },
    ]) {
      const { err, ctx } = ctxFor({ ask: async () => '', checkFile: async () => new Map(), ...over });
      assert.equal(await promoteCommand(cwd, new Map(), ['cart.ts'], ctx), 1, JSON.stringify(over));
      assert.match(err.join(''), /needs a person at a terminal/);
    }
    assert.equal(readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8'), before);
    assert.ok(!existsSync(join(cwd, 'src/cart.laws.ts')));
  });

  it('promote is not covered by a delegation of accept', async () => {
    const cwd = project();
    const home = join(root, `home${n}`);
    mkdirSync(home, { recursive: true });
    assert.equal(typeof grantFor(cwd, 3600_000, new Date(), home), 'object');
    addProposal(cwd, 'cart.ts', source);
    const { err, ctx } = ctxFor({ isTTY: false, home, ask: async () => '', checkFile: async () => new Map() });
    assert.equal(await promoteCommand(cwd, new Map(), ['cart.ts'], ctx), 1);
    assert.match(err.join(''), /needs a person at a terminal/);
    assert.deepEqual(discoverProposals(cwd), ['.tslaws/proposals/cart.ts']);
  });

  it('promote moves the proposal for a person at a terminal', async () => {
    const cwd = project();
    addProposal(cwd, 'cart.ts', source);
    const { out, ctx } = ctxFor({
      ask: async (q: string) => (q.includes('code to ') ? 'y' : ''),
      checkFile: async () => new Map([['totalKeeps', 'tested']]),
    });
    assert.equal(await promoteCommand(cwd, new Map(), ['cart.ts'], ctx), 0);
    assert.ok(existsSync(join(cwd, 'src/cart.laws.ts')));
    assert.match(out.join(''), /moved to src\/cart\.laws\.ts/);
    assert.ok(!existsSync(join(cwd, 'tsc-laws.lock')));
  });

  it('promote shows helper code first, asks, and writes nothing on a refusal', async () => {
    const cwd = project();
    addProposal(cwd, 'cart.ts', `const size = 3;\n${source}\nexport law again(n: number) { return size > 0; }\n`);
    const stored = readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8');
    const refused = ctxFor({
      ask: async (q: string) => (q.includes('code to ') ? 'n' : ''),
      checkFile: async () => new Map(),
    });
    assert.equal(await promoteCommand(cwd, new Map(), ['cart.ts'], refused.ctx), 0);
    assert.match(refused.out.join(''), /helpers \(1\):\nconst size = 3;/);
    assert.match(refused.out.join(''), /nothing moved/);
    assert.ok(!existsSync(join(cwd, 'src/cart.laws.ts')));
    assert.equal(readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8'), stored);
  });

  it('promote --yes adds helper code without asking, still prints it, and still needs a terminal', async () => {
    const cwd = project();
    addProposal(cwd, 'cart.ts', `const size = 3;\n${source}\nexport law again(n: number) { return size > 0; }\n`);
    const asked: string[] = [];
    const yes = ctxFor({ ask: async (q: string) => (asked.push(q), ''), checkFile: async () => new Map() });
    assert.equal(await promoteCommand(cwd, new Map([['yes', true]]), ['cart.ts'], yes.ctx), 0);
    assert.match(yes.out.join(''), /helpers \(1\):\nconst size = 3;/);
    assert.ok(
      asked.every((q) => !q.includes('code to ')),
      asked.join('|'),
    );
    assert.match(readFileSync(join(cwd, 'src/cart.laws.ts'), 'utf8'), /const size = 3;/);
    // --yes does not let promote run where it was refused before.
    const other = project();
    addProposal(other, 'cart.ts', source);
    for (const over of [{ isTTY: false }, { env: { CI: '1' } }, { env: { TSLAWS_AGENT: '1' } }]) {
      const { err, ctx } = ctxFor({ ask: async () => 'y', checkFile: async () => new Map(), ...over });
      assert.equal(await promoteCommand(other, new Map([['yes', true]]), ['cart.ts'], ctx), 1, JSON.stringify(over));
      assert.match(err.join(''), /needs a person at a terminal/);
    }
    assert.ok(!existsSync(join(other, 'src/cart.laws.ts')));
  });

  it('promote refuses a helper that could run code in a hand-written proposal, even with --yes', async () => {
    const cwd = project();
    mkdirSync(join(cwd, '.tslaws/proposals'), { recursive: true });
    writeFileSync(
      join(cwd, '.tslaws/proposals/cart.ts'),
      "import { total } from '../../src/cart';\nconst boot = process.exit();\nexport law a(n: number) { return boot === undefined && total(n) === n; }\n",
    );
    const { out, ctx } = ctxFor({ ask: async () => 'y', checkFile: async () => new Map() });
    assert.equal(await promoteCommand(cwd, new Map([['yes', true]]), ['cart.ts'], ctx), 0);
    assert.match(out.join(''), /helper 'boot' is refused: const 'boot' is initialised with a call/);
    assert.ok(!existsSync(join(cwd, 'src/cart.laws.ts')));
    assert.ok(existsSync(join(cwd, '.tslaws/proposals/cart.ts')));
  });

  it('promote lists the proposals when none is named, and refuses a name outside the directory', async () => {
    const cwd = project();
    addProposal(cwd, 'cart.ts', source);
    const listed = ctxFor({ ask: async () => '' });
    assert.equal(await promoteCommand(cwd, new Map(), [], listed.ctx), 1);
    assert.match(listed.err.join(''), /\.tslaws\/proposals\/cart\.ts/);
    const outside = ctxFor({ ask: async () => '' });
    assert.equal(await promoteCommand(cwd, new Map(), ['src/cart.ts'], outside.ctx), 1);
    assert.match(outside.err.join(''), /not a proposal file/);
    assert.ok(existsSync(join(cwd, 'src/cart.ts')));
  });

  it('propose writes from stdin or --from, for anyone, and never touches the lock or the tree', async () => {
    const cwd = project({ 'tsc-laws.lock': 'LOCK\n' });
    for (const env of [{}, { CI: '1' }, { TSLAWS_AGENT: '1' }]) {
      const { out, ctx } = ctxFor({ isTTY: false, env, stdin: async () => source });
      assert.equal(await proposeCommand(cwd, new Map(), ['cart.ts'], ctx), 0);
      assert.match(out.join(''), /\.tslaws\/proposals\/cart\.ts: 1 law \(totalKeeps\)/);
    }
    writeFileSync(join(cwd, 'draft.txt'), source.replace('totalKeeps', 'fromFile'));
    const file = ctxFor({ isTTY: true });
    assert.equal(await proposeCommand(cwd, new Map([['from', 'draft.txt']]), ['cart.ts'], file.ctx), 0);
    assert.match(readFileSync(join(cwd, '.tslaws/proposals/cart.ts'), 'utf8'), /fromFile/);
    assert.equal(readFileSync(join(cwd, 'tsc-laws.lock'), 'utf8'), 'LOCK\n');
    assert.deepEqual(tree(cwd), ['draft.txt', 'src', 'src/cart.ts', 'tsc-laws.lock']);
  });

  it('propose refuses paths outside the directory and a missing source', async () => {
    const cwd = project();
    for (const file of ['../x.ts', 'src/cart.ts', 'src/new.laws.ts', '/abs.ts']) {
      const { err, ctx } = ctxFor({ isTTY: false, stdin: async () => source });
      assert.equal(await proposeCommand(cwd, new Map(), [file], ctx), 1, file);
      assert.match(err.join(''), /not a proposal file/);
    }
    const tty = ctxFor({ isTTY: true });
    assert.equal(await proposeCommand(cwd, new Map(), ['a.ts'], tty.ctx), 1);
    assert.match(tty.err.join(''), /stdin/);
    const missing = ctxFor({ isTTY: true });
    assert.equal(await proposeCommand(cwd, new Map([['from', 'nope.txt']]), ['a.ts'], missing.ctx), 1);
    assert.deepEqual(tree(cwd), ['src', 'src/cart.ts']);
  });

  it('promote still moves an in-tree *.proposed.laws.ts file, without a deprecation notice', async () => {
    const cwd = project({
      'src/cart.proposed.laws.ts':
        "import { total } from './cart';\nexport law old(n: number) { return total(n) === n; }\n",
    });
    const { out, ctx } = ctxFor({ ask: async () => 'y', checkFile: async () => new Map() });
    assert.equal(await promoteCommand(cwd, new Map(), ['src/cart.proposed.laws.ts'], ctx), 0);
    assert.doesNotMatch(out.join(''), /deprecated/);
    assert.ok(existsSync(join(cwd, 'src/cart.laws.ts')));
    assert.ok(!existsSync(join(cwd, 'src/cart.proposed.laws.ts')));
  });
});
