// Law file names: a proposed file maps to the accepted name; the suffix is only a hint at the level. Pure, so no compiler or browser needed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptedLawName, isProposedLawFile, suffixKind } from '../dist/lawNames.js';

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

describe('law file kind hints', () => {
  it('read the level the name hints at, proposed or accepted', () => {
    assert.equal(suffixKind('src/a.browser.laws.ts'), 'browser');
    assert.equal(suffixKind('src/a.browser.proposed.laws.ts'), 'browser');
    assert.equal(suffixKind('src/a.e2e.laws.ts'), 'e2e');
    assert.equal(suffixKind('src/a.e2e.proposed.laws.ts'), 'e2e');
  });

  it('hint nothing for a plain name', () => {
    assert.equal(suffixKind('src/a.laws.ts'), undefined);
    assert.equal(suffixKind('src/a.proposed.laws.ts'), undefined);
    assert.equal(suffixKind('.tslaws/proposals/a.ts'), undefined);
  });
});
