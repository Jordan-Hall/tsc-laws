// The level of a laws file comes from what it imports, followed through the project's own modules. Pure file work:
// no compiler or browser needed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { coverFiles, parseConfig } from '../dist/coverage.js';
import { discoverLaws, discoverProposals, isLawsFile } from '../dist/lawFiles.js';
import { classifyLawFile, runtimeSpecifiers } from '../dist/lawKinds.js';

const root = mkdtempSync(join(tmpdir(), 'tslaws-kinds-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string>): string {
  const cwd = join(root, `p${(n += 1)}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  return cwd;
}

const law = 'export law ok(n: number) { return n === n; }\n';
const browserImport = "import { mount } from 'tslaws/browser';\n";
const e2eImport = "import { open } from 'tslaws/e2e';\n";

describe('law kind by imports', () => {
  it('makes a file that imports neither API a Node law', () => {
    const cwd = project({ 'src/a.laws.ts': `import { assume } from 'tslaws';\n${law}` });
    const v = classifyLawFile(cwd, 'src/a.laws.ts');
    assert.equal(v.kind, 'node');
    assert.deepEqual(v.notices, []);
    assert.equal(v.error, undefined);
  });

  it('makes a file that imports tslaws/browser a browser law, whatever its name', () => {
    const cwd = project({ 'src/ui.laws.ts': browserImport + law, 'src/other.ts': browserImport });
    assert.equal(classifyLawFile(cwd, 'src/ui.laws.ts').kind, 'browser');
    assert.equal(classifyLawFile(cwd, 'src/other.ts').kind, 'browser');
  });

  it('counts every adapter entry point as the browser API', () => {
    for (const adapter of ['dom', 'react', 'angular', 'element']) {
      const cwd = project({ 'src/a.laws.ts': `import { x } from 'tslaws/adapters/${adapter}';\n${law}` });
      assert.equal(classifyLawFile(cwd, 'src/a.laws.ts').kind, 'browser', adapter);
    }
  });

  it('makes a file that imports tslaws/e2e an end-to-end law', () => {
    const cwd = project({ 'src/shop.laws.ts': e2eImport + law });
    assert.equal(classifyLawFile(cwd, 'src/shop.laws.ts').kind, 'e2e');
  });

  it('follows a helper module', () => {
    const cwd = project({
      'src/a.laws.ts': `import { build } from './helpers/build';\n${law}`,
      'src/helpers/build.ts': `import { render } from './render';\nexport const build = render;\n`,
      'src/helpers/render.ts': `${browserImport}export const render = mount;\n`,
    });
    const v = classifyLawFile(cwd, 'src/a.laws.ts');
    assert.equal(v.kind, 'browser');
    assert.deepEqual(v.imports.browser, ['src/a.laws.ts', 'src/helpers/build.ts', 'src/helpers/render.ts']);
  });

  it('follows a re-export, a dynamic import and a require', () => {
    const cwd = project({
      'src/a.laws.ts': `export * from './reexport';\n${law}`,
      'src/reexport.ts': "export { thing } from './deep';\n",
      'src/deep.ts': `export const thing = async () => import('tslaws/browser');\n`,
      'src/b.laws.ts': `const h = require('./cjs');\n${law}`,
      'src/cjs.ts': `module.exports = require('tslaws/e2e');\n`,
    });
    assert.equal(classifyLawFile(cwd, 'src/a.laws.ts').kind, 'browser');
    assert.equal(classifyLawFile(cwd, 'src/b.laws.ts').kind, 'e2e');
  });

  it('ignores an import used only as a type', () => {
    const cwd = project({
      'src/a.laws.ts': `import type { Mounted } from 'tslaws/browser';\nimport { type A } from 'tslaws/adapters/dom';\nexport type { B } from 'tslaws/browser';\n${law}`,
    });
    assert.equal(classifyLawFile(cwd, 'src/a.laws.ts').kind, 'node');
  });

  it('does not follow modules inside node_modules, or a cycle forever', () => {
    const cwd = project({
      'src/a.laws.ts': `import { x } from './b';\nimport { y } from 'some-package';\n${law}`,
      'src/b.ts': "import { x } from './a.laws';\nexport const x = 1;\n",
      'node_modules/some-package/index.ts': browserImport,
    });
    assert.equal(classifyLawFile(cwd, 'src/a.laws.ts').kind, 'node');
  });

  it('refuses a file that reaches both levels, naming how each is reached', () => {
    const cwd = project({
      'src/a.laws.ts': `import { r } from './h';\n${e2eImport}${law}`,
      'src/h.ts': `${browserImport}export const r = mount;\n`,
    });
    const v = classifyLawFile(cwd, 'src/a.laws.ts');
    assert.match(v.error ?? '', /either component level \(tslaws\/browser\) or end-to-end \(tslaws\/e2e\), not both/);
    assert.match(v.error ?? '', /browser API reached through src\/h\.ts/);
    assert.match(v.error ?? '', /end-to-end API reached directly/);
  });
});

describe('name hints against imports', () => {
  it('say nothing when the name and the imports agree', () => {
    const cwd = project({ 'src/a.browser.laws.ts': browserImport + law, 'src/b.e2e.laws.ts': e2eImport + law });
    for (const file of ['src/a.browser.laws.ts', 'src/b.e2e.laws.ts']) {
      assert.deepEqual(classifyLawFile(cwd, file).notices, [], file);
    }
  });

  it('keep the named level, with a notice, when nothing imported says which level', () => {
    const cwd = project({ 'src/a.browser.laws.ts': law, 'src/b.e2e.laws.ts': law });
    const browser = classifyLawFile(cwd, 'src/a.browser.laws.ts');
    assert.equal(browser.kind, 'browser');
    assert.match(browser.notices[0] ?? '', /name says browser, but nothing it imports is the browser law API/);
    const e2e = classifyLawFile(cwd, 'src/b.e2e.laws.ts');
    assert.equal(e2e.kind, 'e2e');
    assert.match(e2e.notices[0] ?? '', /name says e2e/);
  });

  it('let a browser-named file that drives an app run end to end, with a notice', () => {
    const cwd = project({ 'src/a.browser.laws.ts': e2eImport + law });
    const v = classifyLawFile(cwd, 'src/a.browser.laws.ts');
    assert.equal(v.kind, 'e2e');
    assert.match(v.notices[0] ?? '', /name says browser, but it reaches the end-to-end API/);
  });

  it('refuse an e2e-named file that reaches the browser API only', () => {
    const cwd = project({ 'src/a.e2e.laws.ts': browserImport + law });
    const v = classifyLawFile(cwd, 'src/a.e2e.laws.ts');
    assert.match(v.error ?? '', /name says end-to-end, but it reaches the browser API directly/);
  });

  it('ignore the name of a proposal in the proposals directory', () => {
    const cwd = project({ '.tslaws/proposals/x.ts': browserImport + law });
    assert.equal(classifyLawFile(cwd, '.tslaws/proposals/x.ts').kind, 'browser');
  });
});

describe('runtime specifiers', () => {
  it('lists static, re-exported, required and dynamic modules, and skips type-only ones', () => {
    const text = [
      "import a from './a';",
      "import './side';",
      "import type { T } from './types';",
      "export * from './star';",
      "export type * from './only-types';",
      "import eq = require('./eq');",
      "const l = await import('./lazy');",
      "const r = require('./req');",
    ].join('\n');
    assert.deepEqual(
      runtimeSpecifiers(text).map((s) => s.value),
      ['./a', './side', './star', './eq', './lazy', './req'],
    );
  });
});

describe('discovering laws files', () => {
  it('finds every *.laws.ts, and apart from them the in-tree proposed names', () => {
    const cwd = project({
      'src/a.laws.ts': law,
      'src/b.proposed.laws.ts': law,
      'src/c.browser.proposed.laws.ts': law,
      'node_modules/x/y.laws.ts': law,
      '.tslaws/proposals/p.ts': law,
    });
    assert.deepEqual(discoverLaws(cwd), ['src/a.laws.ts']);
    assert.deepEqual(discoverLaws(cwd, true), ['src/b.proposed.laws.ts', 'src/c.browser.proposed.laws.ts']);
    assert.deepEqual(discoverProposals(cwd), ['.tslaws/proposals/p.ts']);
  });

  it('adds files the laws globs match that declare a top-level export law, and no others', () => {
    const cwd = project({
      'tslaws.json': JSON.stringify({ laws: ['specs/**/*.ts', '!specs/skip/**'] }),
      'specs/cart.ts': `import type { int } from 'tslaws';\n${law}`,
      'specs/helper.ts': 'export function help() { return 1; }\n// export law in a comment\n',
      'specs/skip/off.ts': law,
      'src/other.ts': law,
      'src/a.laws.ts': law,
    });
    assert.deepEqual(discoverLaws(cwd), ['specs/cart.ts', 'src/a.laws.ts']);
    assert.equal(isLawsFile(cwd, 'specs/cart.ts'), true);
    assert.equal(isLawsFile(cwd, 'specs/helper.ts'), false);
    assert.equal(isLawsFile(cwd, 'src/other.ts'), false);
  });

  it('keeps such files out of the covered sources', () => {
    const cwd = project({
      'tslaws.json': JSON.stringify({ laws: ['specs/**/*.ts'] }),
      'specs/cart.ts': law,
      'specs/helper.ts': 'export function help() { return 1; }\n',
    });
    assert.deepEqual(coverFiles(cwd, ['specs/**/*.ts']), ['specs/helper.ts']);
  });

  it('validates the laws setting in tslaws.json', () => {
    assert.deepEqual(parseConfig({ laws: ['a/**/*.ts', '!a/x.ts'] }).laws, ['a/**/*.ts', '!a/x.ts']);
    assert.throws(() => parseConfig({ laws: 'a/*.ts' }), /"laws" must be an array of project-relative globs/);
    assert.throws(() => parseConfig({ laws: [1] }), /"laws" must be an array/);
    assert.throws(() => parseConfig({ laws: [''] }), /"laws" must be an array/);
    assert.throws(() => parseConfig({ laws: ['/abs/*.ts'] }), /"laws" must be an array/);
  });
});
