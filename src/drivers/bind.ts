// Prints symbols and bind diagnostics of a file, or times parse+bind with --bench.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as ast from '../tsgo/ast.js';
import * as binder from '../tsgo/binder.js';
import * as core from '../tsgo/core.js';
import * as parser from '../tsgo/parser.js';
import * as classes from '../tsgo/classes.js';
import { initDone, keepClasses, fromBytes, toHostString } from '../go/base.js';
import { strconv_Quote } from '../go/std.js';

// Lets scriptc lower every class before use; never runs.
if (keepClasses()) classes.keepAll();
initDone();

function parse(text: string): ast.SourceFile {
  const opts = new ast.SourceFileParseOptions();
  opts.FileName = '/input.ts';
  opts.Path_ = '/input.ts';
  return parser.ParseSourceFile(opts, text, core.ScriptKindTS)!;
}

function symbol(s: ast.Symbol_ | undefined): string {
  if (s === undefined) return '-';
  return `${strconv_Quote(s.Name)}:${s.Flags}:${s.Declarations.length}`;
}

const text = fromBytes(readFileSync(process.argv[2]));
if (process.argv[3] === '--bench') {
  const start = performance.now();
  for (let round = 0; round < 20; round++) binder.BindSourceFile(parse(text));
  console.log(`time ${((performance.now() - start) / 20).toFixed(2)}ms`);
} else {
  const f = parse(text);
  binder.BindSourceFile(f);
  const out: string[] = [];
  const visit = (n: ast.Node | undefined, depth: number): boolean => {
    let line = `${depth} ${n!.Kind_} ${n!.Pos()} ${n!.End()} ${n!.Flags} ${symbol(n!.Symbol$m())} ${symbol(n!.LocalSymbol())}`;
    const locals = n!.Locals();
    if (locals !== undefined && locals.size > 0) {
      const names: string[] = [];
      for (const name of locals.keys()) names.push(name);
      names.sort();
      for (const name of names) line += ' ' + symbol(locals.get(name));
    }
    out.push(toHostString(line));
    n!.ForEachChild$Node((c: ast.Node | undefined): boolean => visit(c, depth + 1));
    return false;
  };
  visit(f.AsNode(), 0);
  for (const d of f.BindDiagnostics()) {
    out.push(`diag ${d!.Code()} ${d!.Pos()} ${d!.Len()} ${toHostString(d!.String())}`);
  }
  console.log(out.join('\n'));
}
