// The extension driving the real `tslaws` on a copy of examples/checkout whose code has the mistake its README shows:
// save the broken file, see the law and the function marked, fix it, see both clear. Needs the compiler in TSC_LAWS_BIN and
// `npm run build -w tslaws`; skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { makeFake, until } from './fake-vscode.mjs';

const require = createRequire(import.meta.url);
const { activateExtension } = require('../src/host.js');
const { textOf } = require('../src/ranges.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..', '..');
const bin = path.join(repo, 'packages', 'tslaws', 'bin', 'tslaws.js');
const built = existsSync(path.join(repo, 'packages', 'tslaws', 'dist', 'cli.js'));
const skip = process.env.TSC_LAWS_BIN === undefined ? 'set TSC_LAWS_BIN' : built ? false : 'build tslaws first';

test(
  'the real tslaws: a broken checkout is marked on the law and on total, then clears when fixed',
  { skip },
  async () => {
    const root = fs.realpathSync(mkdtempSync(path.join(here, '..', '.tmp-real-')));
    try {
      cpSync(path.join(repo, 'examples', 'checkout', 'src'), path.join(root, 'src'), { recursive: true });
      cpSync(path.join(repo, 'examples', 'checkout', 'tsc-laws.lock'), path.join(root, 'tsc-laws.lock'));
      const cart = path.join(root, 'src', 'cart.ts');
      const good = readFileSync(cart, 'utf8');
      writeFileSync(cart, good.replace('Math.max(0, price - coupon)', 'price - coupon'));

      const fake = makeFake({
        root,
        settings: { debounceMs: 100, executable: bin, args: ['--no-prove'] },
        lawFiles: [path.join(root, 'src', 'cart.laws.ts')],
      });
      activateExtension(fake.vscode, { subscriptions: [] }, { spawn, fs });
      const diag = (rel) => fake.collections[0].store.get(path.join(root, rel));

      fake.events.save.fire(fake.makeDoc(cart));
      await until(() => diag('src/cart.ts')?.length > 0, 'the real run to mark the function', 90_000);

      const lawsText = readFileSync(path.join(root, 'src', 'cart.laws.ts'), 'utf8');
      const cartText = readFileSync(cart, 'utf8');
      const [onLaw] = diag('src/cart.laws.ts');
      const [onSource] = diag('src/cart.ts');
      const at = (text, d) =>
        textOf(text, { line: d.range.start.line, start: d.range.start.character, end: d.range.end.character });

      assert.equal(onLaw.code, 'tslaws/totalNeverNegative');
      assert.equal(at(lawsText, onLaw), 'totalNeverNegative');
      assert.equal(onSource.code, 'tslaws/totalNeverNegative');
      assert.equal(at(cartText, onSource), 'total');
      assert.match(onLaw.message, /Shrunk counterexample: price = 0, coupon = 1/);
      assert.match(
        onLaw.message,
        /Reproduce: npx tslaws check src\/cart\.laws\.ts --law totalNeverNegative --seed -?\d+/,
      );
      assert.equal(onLaw.relatedInformation[0].location.uri.fsPath, cart);
      assert.equal(onSource.relatedInformation[0].location.uri.fsPath, path.join(root, 'src', 'cart.laws.ts'));
      const call = onLaw.relatedInformation.find((r) => r.location.uri.fsPath.endsWith('cart.laws.ts'));
      assert.equal(
        textOf(lawsText, {
          line: call.location.range.start.line,
          start: call.location.range.start.character,
          end: call.location.range.end.character,
        }),
        'total',
      );

      // The law that still holds is not marked.
      assert.equal(diag('src/cart.laws.ts').length, 1);
      assert.match(fake.statuses[0].text, /1 failed/);

      writeFileSync(cart, good);
      fake.events.save.fire(fake.makeDoc(cart));
      await until(
        () => (diag('src/cart.ts') ?? []).length === 0 && (diag('src/cart.laws.ts') ?? []).length === 0,
        'the fix to clear both ends',
        90_000,
      );
      assert.doesNotMatch(fake.statuses[0].text, /failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('the real compiler: a law that breaks a language rule is marked with its TS91xx code', { skip }, async () => {
  const root = fs.realpathSync(mkdtempSync(path.join(here, '..', '.tmp-real-')));
  try {
    cpSync(path.join(repo, 'examples', 'checkout', 'src'), path.join(root, 'src'), { recursive: true });
    cpSync(path.join(repo, 'examples', 'checkout', 'tsc-laws.lock'), path.join(root, 'tsc-laws.lock'));
    const laws = path.join(root, 'src', 'cart.laws.ts');
    writeFileSync(laws, readFileSync(laws, 'utf8') + '\nexport law returnsNumber(a: number) { return 1; }\n');
    const fake = makeFake({
      root,
      settings: { debounceMs: 100, executable: bin, args: ['--no-prove'] },
      lawFiles: [laws],
    });
    activateExtension(fake.vscode, { subscriptions: [] }, { spawn, fs });
    fake.events.save.fire(fake.makeDoc(laws));
    await until(
      () => (fake.collections[0].store.get(laws) ?? []).some((d) => d.code === 'TS9101'),
      'the compiler rule to be marked',
      90_000,
    );
    const text = readFileSync(laws, 'utf8');
    const d = fake.collections[0].store.get(laws).find((x) => x.code === 'TS9101');
    assert.equal(d.source, 'tsc-laws');
    assert.match(d.message, /A law must return boolean or void, not 'number'/);
    assert.equal(
      textOf(text, { line: d.range.start.line, start: d.range.start.character, end: d.range.end.character }),
      'returnsNumber',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
  }
});
