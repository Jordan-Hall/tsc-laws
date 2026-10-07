// Prints the syntax tree and parse diagnostics of a file, or times parsing with --bench.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as ast from '../tsgo/ast.js';
import * as core from '../tsgo/core.js';
import * as parser from '../tsgo/parser.js';
import * as classes from '../tsgo/classes.js';
import { initDone, keepClasses, fromBytes, toHostString } from '../go/base.js';

// Lets scriptc lower every class before use; never runs.
if (keepClasses()) classes.keepAll();
initDone();

function parse(text: string): ast.SourceFile {
  const opts = new ast.SourceFileParseOptions();
  opts.FileName = '/input.ts';
  opts.Path_ = '/input.ts';
  return parser.ParseSourceFile(opts, text, core.ScriptKindTS)!;
}

const text = fromBytes(readFileSync(process.argv[2]));
if (process.argv[3] === '--bench') {
  const start = performance.now();
  let nodes = 0;
  for (let round = 0; round < 20; round++) nodes += parse(text).NodeCount;
  console.log(`nodes ${Math.trunc(nodes / 20)} time ${((performance.now() - start) / 20).toFixed(2)}ms`);
} else {
  const f = parse(text);
  const out: string[] = [];
  const visit = (n: ast.Node | undefined, depth: number): boolean => {
    out.push(`${depth} ${n!.Kind_} ${n!.Pos()} ${n!.End()} ${n!.Flags}`);
    n!.ForEachChild$Node((c: ast.Node | undefined): boolean => visit(c, depth + 1));
    return false;
  };
  visit(f.AsNode(), 0);
  for (const d of f.Diagnostics()) {
    out.push(`diag ${d!.Code()} ${d!.Pos()} ${d!.Len()} ${toHostString(d!.String())}`);
  }
  console.log(out.join('\n'));
}
