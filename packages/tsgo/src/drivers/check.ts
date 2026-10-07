// Prints diagnostics for a file checked against the bundled libs, or times
// checking with --bench. Usage: check FILE LIBDIR [--bench]
import { readFileSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as ast from '../tsgo/ast.js';
import * as checkhost from '../tsgo/checkhost.js';
import * as classes from '../tsgo/classes.js';
import { initDone, keepClasses, fromBytes, toHostString } from '../go/base.js';

// Native builds: collect cycles less often. The lib ASTs live for the whole
// run, and each pass walks them.
process.env.SCR_CYCLE_THRESHOLD = '1000000';

// Lets scriptc lower every class before use; never runs.
if (keepClasses()) classes.keepAll();
initDone();

const libDir = process.argv[3];
const readLib = (name: string): [string, boolean] => {
  try {
    return [fromBytes(readFileSync(libDir + '/' + toHostString(name))), true];
  } catch {
    return ['', false];
  }
};
function print(out: string[], diags: (ast.Diagnostic | undefined)[]): void {
  for (const d of diags) {
    const file = d!.File();
    const name = file === undefined ? '' : toHostString(file.FileName());
    out.push(`${name} ${d!.Code()} ${d!.Pos()} ${d!.Len()} ${toHostString(d!.String())}`);
  }
}

const text = fromBytes(readFileSync(process.argv[2]));
if (process.argv[4] === '--batch') {
  // The first argument lists input files, one per line. Results are written
  // per file so a stuck input is visible.
  for (const line of toHostString(text).split('\n')) {
    if (line === '') continue;
    let input = '';
    try {
      input = fromBytes(readFileSync(line));
    } catch {
      continue;
    }
    const out: string[] = ['== ' + line];
    try {
      print(out, checkhost.Check('/input.ts', input, readLib));
    } catch {
      out.push('!! panic');
    }
    writeSync(1, out.join('\n') + '\n');
  }
} else if (process.argv[4] === '--bench') {
  const start = performance.now();
  let count = 0;
  for (let round = 0; round < 5; round++) count = checkhost.Check('/input.ts', text, readLib).length;
  writeSync(1, `diagnostics ${count} time ${((performance.now() - start) / 5).toFixed(2)}ms\n`);
} else {
  const out: string[] = [];
  print(out, checkhost.Check('/input.ts', text, readLib));
  writeSync(1, out.join('\n') + '\n');
}
// Output is written synchronously, so skip freeing the heap at exit.
process.exit(0);
