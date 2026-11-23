// Coverage follows an ES module import the way it follows a plain `require`: the compiler wraps the `require` in an
// interop helper (`__importStar`, `__importDefault`, or esbuild's `__toESM`), and coverage unwraps it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import ts from 'typescript';
import { analyzeCoverage } from '../dist/coverage.js';

const root = mkdtempSync(join(tmpdir(), 'tslaws-esm-imports-'));
after(() => rmSync(root, { recursive: true, force: true }));

// The module under cover: a named export and a default export, both functions.
const widgetDts = 'export declare function Widget(): number;\nexport default Widget;\n';
const widgetJs = [
  '"use strict";',
  'Object.defineProperty(exports, "__esModule", { value: true });',
  'exports.Widget = Widget;',
  'function Widget() { return 1; }',
  'exports.default = Widget;',
  '',
].join('\n');

/** Writes `src/widget` and one compiled law whose body is `lawJs`; returns what coverage found uncovered. */
function uncoveredBy(name: string, lawJs: string): string[] {
  const cwd = join(root, name);
  const out = join(cwd, 'out');
  mkdirSync(join(out, 'src'), { recursive: true });
  writeFileSync(join(out, 'src', 'widget.js'), widgetJs);
  writeFileSync(join(out, 'src', 'widget.d.ts'), widgetDts);
  writeFileSync(join(out, 'src', 'a.laws.js'), lawJs);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'widget.ts'), 'export {};\n');
  const program = ts.createProgram([join(out, 'src', 'widget.d.ts')], { noEmit: true, types: [] });
  const report = analyzeCoverage({
    cwd,
    outDir: out,
    lawFiles: ['src/a.laws.ts'],
    coverFiles: ['src/widget.ts'],
    program,
  });
  return report.uncovered.map((u) => u.name);
}

const star = (helper: string, call: string): string =>
  `"use strict";\nconst widget_1 = ${helper};\nfunction law() { return ${call}; }\n`;
const interop = '__importStar(require("./widget"))';

describe('coverage of ES module imports', () => {
  it('counts nothing when the law never touches the module', () => {
    assert.deepEqual(uncoveredBy('none', '"use strict";\nfunction law() { return 1; }\n'), ['default', 'Widget']);
  });

  it('follows import D, { N as Named } from (__importStar)', () => {
    const law =
      '"use strict";\nconst widget_1 = __importStar(require("./widget"));\nfunction law() { return widget_1.default() + widget_1.Widget(); }\n';
    assert.deepEqual(uncoveredBy('default-and-named', law), []);
  });

  it('follows import * as M (__importStar)', () => {
    assert.deepEqual(uncoveredBy('namespace', star(interop, 'widget_1.Widget()')), ['default']);
    assert.deepEqual(uncoveredBy('namespace-default', star(interop, 'widget_1.default()')), ['Widget']);
  });

  it('follows import { default as D, N } (__importStar)', () => {
    const law =
      '"use strict";\nconst widget_1 = __importStar(require("./widget"));\nfunction law() { return (0, widget_1.default)() + (0, widget_1.Widget)(); }\n';
    // Calls through `(0, x.f)()` still read the property off the binding.
    assert.deepEqual(uncoveredBy('default-as', law), []);
  });

  it('follows import D from (__importDefault)', () => {
    assert.deepEqual(uncoveredBy('default', star('__importDefault(require("./widget"))', 'widget_1.default()')), [
      'Widget',
    ]);
  });

  it('follows esbuild __toESM, also nested in another helper', () => {
    assert.deepEqual(uncoveredBy('esbuild', star('__toESM(require("./widget"), 1)', 'widget_1.Widget()')), ['default']);
    assert.deepEqual(
      uncoveredBy('nested', star('__importStar(__importDefault(require("./widget")))', 'widget_1.Widget()')),
      ['default'],
    );
  });

  it('follows a helper reached through a namespace, as tslib emits it', () => {
    assert.deepEqual(uncoveredBy('tslib', star('tslib_1.__importStar(require("./widget"))', 'widget_1.Widget()')), [
      'default',
    ]);
  });

  it('still follows a plain require, and import X = require', () => {
    assert.deepEqual(uncoveredBy('plain', star('require("./widget")', 'widget_1.Widget() + widget_1.default()')), []);
    assert.deepEqual(uncoveredBy('plain-partial', star('require("./widget")', 'widget_1.Widget()')), ['default']);
  });

  it('ignores a helper around a require that is not relative', () => {
    assert.deepEqual(uncoveredBy('bare', star('__importStar(require("widget"))', 'widget_1.Widget()')), [
      'default',
      'Widget',
    ]);
  });
});
