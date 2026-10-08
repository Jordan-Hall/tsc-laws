// Parses files like the reference print oracle and prints them back without transforms.
// Usage: print FILE [--remove-comments] [--crlf] [--target es2021] [--sourcemap] [--bench]
//        print --batch LIST OUTDIR [--remove-comments] [--crlf]
// In batch mode the output for the i-th path of LIST goes to OUTDIR/i.out (or i.err on failure).
// With --sourcemap, the output is followed by a line with the source map of printing to out.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ExternalModuleIndicatorOptions, ParseOptions, ScriptKind, type SourceFile } from '../compiler/ast.js';
import { parseSourceFile } from '../compiler/parser.js';
import { Printer, PrinterOptions } from '../compiler/printer/printer.js';
import { SourceMapGenerator } from '../compiler/sourcemap.js';
import { TextWriter } from '../compiler/printer/text-writer.js';
import { ScriptTarget } from '../compiler/options.js';

const forcedExtensions = ['.cjs', '.cts', '.mjs', '.mts'];

function baseName(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

function isDeclarationFileName(name: string): boolean {
  const base = baseName(name);
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) return true;
  return base.endsWith('.ts') && base.includes('.d.');
}

function parse(path: string): SourceFile {
  const text = readFileSync(path, 'utf8');
  const fileName = '/' + baseName(path);
  let force = false;
  if (!isDeclarationFileName(fileName)) for (const ext of forcedExtensions) if (fileName.endsWith(ext)) force = true;
  const options = new ParseOptions(fileName, ScriptKind.Unknown, new ExternalModuleIndicatorOptions(false, force));
  return parseSourceFile(fileName, text, options);
}

function targetOf(name: string): ScriptTarget {
  switch (name) {
    case 'es2015':
      return ScriptTarget.ES2015;
    case 'es2020':
      return ScriptTarget.ES2020;
    case 'es2021':
      return ScriptTarget.ES2021;
    case 'esnext':
      return ScriptTarget.ESNext;
  }
  return ScriptTarget.ES5;
}

function print(path: string, options: PrinterOptions, sourceMap: boolean): string {
  const file = parse(path);
  const printer = new Printer(options, undefined);
  if (!sourceMap) return printer.emitSourceFile(file);
  const generator = new SourceMapGenerator('out.js', '', '/', true, '/');
  const writer = new TextWriter(options.newLine, 4);
  printer.write(file, file, writer, generator);
  return writer.getText() + '\n' + generator.toJSON();
}

function main(): number {
  const args = process.argv.slice(2);
  const options = new PrinterOptions();
  const positional: string[] = [];
  let bench = false;
  let batch = false;
  let sourceMap = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--remove-comments') options.removeComments = true;
    else if (arg === '--crlf') options.newLine = '\r\n';
    else if (arg === '--bench') bench = true;
    else if (arg === '--batch') batch = true;
    else if (arg === '--sourcemap') sourceMap = true;
    else if (arg === '--target') options.target = targetOf(args[++i]);
    else positional.push(arg);
  }
  if (batch) {
    const paths = readFileSync(positional[0], 'utf8').split('\n');
    const outDir = positional[1];
    for (let i = 0; i < paths.length; i++) {
      if (paths[i].length === 0) continue;
      let text: string;
      try {
        text = print(paths[i], options, sourceMap);
      } catch {
        writeFileSync(outDir + '/' + i + '.err', 'error');
        continue;
      }
      writeFileSync(outDir + '/' + i + '.out', text);
    }
    return 0;
  }
  const file = parse(positional[0]);
  if (bench) {
    let size = 0;
    const start = performance.now();
    for (let round = 0; round < 20; round++) size = new Printer(options, undefined).emitSourceFile(file).length;
    console.log(`chars ${size} time ${((performance.now() - start) / 20).toFixed(2)}ms`);
    return 0;
  }
  process.stdout.write(print(positional[0], options, sourceMap));
  return 0;
}

main();
