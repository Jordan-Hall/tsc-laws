// Law file names: a proposed file keeps the kind of the accepted file it proposes. Pure, so no compiler or browser needed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBrowserLawFile } from '../dist/browser.js';
import { importsBoth, isE2eLawFile, lawMode } from '../dist/e2e.js';
import { acceptedLawName, isProposedLawFile } from '../dist/lawNames.js';

const e2eImport = "import { open } from 'tslaws/e2e';\n";

describe('proposed law file names', () => {
  it('recognise a proposal of any kind', () => {
    for (const file of [
      'src/a.proposed.laws.ts',
      'src/shell-layout.browser.proposed.laws.ts',
      'src/shop.e2e.proposed.laws.ts',
    ]) {
      assert.equal(isProposedLawFile(file), true, file);
    }
    for (const file of ['src/a.laws.ts', 'src/a.browser.laws.ts', 'src/a.e2e.laws.ts', 'src/a.ts']) {
      assert.equal(isProposedLawFile(file), false, file);
    }
  });

  it('map to the accepted name of the same kind', () => {
    assert.equal(acceptedLawName('src/a.proposed.laws.ts'), 'src/a.laws.ts');
    assert.equal(acceptedLawName('src/shell-layout.browser.proposed.laws.ts'), 'src/shell-layout.browser.laws.ts');
    assert.equal(acceptedLawName('src/shop.e2e.proposed.laws.ts'), 'src/shop.e2e.laws.ts');
    assert.equal(acceptedLawName('src/a.browser.laws.ts'), 'src/a.browser.laws.ts');
  });
});

describe('law file kinds', () => {
  it('treat a proposed browser law as a browser law', () => {
    assert.equal(isBrowserLawFile('src/a.browser.laws.ts'), true);
    assert.equal(isBrowserLawFile('src/a.browser.proposed.laws.ts'), true);
    assert.equal(isBrowserLawFile('src/a.proposed.laws.ts'), false);
    assert.equal(isBrowserLawFile('src/a.e2e.proposed.laws.ts'), false);
    assert.equal(lawMode('src/a.browser.proposed.laws.ts', ''), 'component');
  });

  it('treat a proposed e2e law as an end-to-end law', () => {
    assert.equal(isE2eLawFile('src/a.e2e.laws.ts'), true);
    assert.equal(isE2eLawFile('src/a.e2e.proposed.laws.ts'), true);
    assert.equal(isE2eLawFile('src/a.browser.proposed.laws.ts'), false);
    assert.equal(lawMode('src/a.e2e.proposed.laws.ts', ''), 'e2e');
  });

  it('keep a plain proposed file a node law', () => {
    assert.equal(lawMode('src/a.proposed.laws.ts', ''), 'node');
    assert.equal(lawMode('src/a.proposed.laws.ts', e2eImport), 'node');
  });

  it('let a proposed browser file that imports tslaws/e2e run end to end, as an accepted one does', () => {
    assert.equal(lawMode('src/a.browser.laws.ts', e2eImport), 'e2e');
    assert.equal(lawMode('src/a.browser.proposed.laws.ts', e2eImport), 'e2e');
  });

  it('spot a file that imports both levels', () => {
    assert.equal(importsBoth(`${e2eImport}import { mount } from 'tslaws/browser';\n`), true);
    assert.equal(importsBoth(e2eImport), false);
  });
});
