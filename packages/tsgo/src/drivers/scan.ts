// Prints the token stream of a file, or times scanning with --bench.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as scanner from '../tsgo/scanner.js';
import * as core from '../tsgo/core.js';
import * as classes from '../tsgo/classes.js';
import { initDone, keepClasses, fromBytes } from '../go/base.js';

// Lets scriptc lower every class before use; never runs.
if (keepClasses()) classes.keepAll();

initDone();
const text = fromBytes(readFileSync(process.argv[2]));
if (process.argv[3] === '--bench') {
  const start = performance.now();
  let count = 0;
  for (let round = 0; round < 20; round++) {
    const s = scanner.NewScanner()!;
    s.SetText(text);
    s.SetScriptTarget(core.ScriptTargetLatest);
    while (s.Scan() !== 1) count++;
  }
  console.log(`tokens ${count} time ${((performance.now() - start) / 20).toFixed(2)}ms`);
} else {
  const s = scanner.NewScanner()!;
  s.SetText(text);
  s.SetScriptTarget(core.ScriptTargetLatest);
  const out: string[] = [];
  for (;;) {
    const k = s.Scan();
    out.push(`${k} ${s.TokenStart()} ${s.TokenEnd()} ${s.TokenFlags$m()}`);
    if (k === 1) break;
  }
  console.log(out.join('\n'));
}
