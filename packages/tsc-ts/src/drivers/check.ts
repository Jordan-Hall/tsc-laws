// Checks a file against the bundled libs and prints its diagnostics in the format of the reference
// check oracle: `<file> <code> <pos> <len> <message>` with UTF-8 offsets.
// Usage: check FILE LIBDIR [--batch|--bench]
//   --batch  FILE lists input files, one per line; each is printed after `== <path>`
//   --bench  times parsing, binding and checking FILE
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ExternalModuleIndicatorOptions, ParseOptions, ScriptKind, type SourceFile } from '../compiler/ast.js';
import { bindSourceFile } from '../compiler/binder.js';
import { Checker, CheckerHost } from '../compiler/checker.js';
import { type Diagnostic, Locale } from '../compiler/diagnostics.js';
import { type CompilerOptions, ScriptTarget } from '../compiler/options.js';
import { parseSourceFile } from '../compiler/parser.js';
import { getDefaultLibFileName, getLibFileName } from '../compiler/program-utilities.js';

const libDirectory = '/libs/';

class CheckHost extends CheckerHost {
  readonly options: CompilerOptions;
  readonly files: SourceFile[];
  readonly libs: Set<SourceFile>;

  constructor(options: CompilerOptions, files: SourceFile[], libs: Set<SourceFile>) {
    super();
    this.options = options;
    this.files = files;
    this.libs = libs;
  }

  getCompilerOptions(): CompilerOptions {
    return this.options;
  }

  getSourceFiles(): readonly SourceFile[] {
    return this.files;
  }

  isSourceFileDefaultLibrary(file: SourceFile): boolean {
    return this.libs.has(file);
  }

  getSourceFileForModuleName(_file: SourceFile, _moduleName: string): SourceFile | undefined {
    return undefined;
  }
}

/** Parsed and bound lib files, shared by every program. */
class LibLoader {
  readonly directory: string;
  readonly cache = new Map<string, SourceFile>();
  readonly files: SourceFile[] = [];
  readonly libs = new Set<SourceFile>();

  constructor(directory: string, options: CompilerOptions) {
    this.directory = directory;
    this.add(getDefaultLibFileName(options));
  }

  private add(name: string): void {
    if (this.cache.has(name)) return;
    let text: string;
    try {
      text = readFileSync(this.directory + '/' + name, 'utf8');
    } catch {
      return;
    }
    const file = parse(libDirectory + name, text);
    this.cache.set(name, file);
    for (const ref of file.libReferenceDirectives) {
      const libName = getLibFileName(ref.fileName);
      if (libName !== '') this.add(libName);
    }
    bindSourceFile(file);
    this.files.push(file);
    this.libs.add(file);
  }
}

function parse(fileName: string, text: string): SourceFile {
  return parseSourceFile(
    fileName,
    text,
    new ParseOptions(fileName, ScriptKind.Unknown, new ExternalModuleIndicatorOptions(false, false)),
  );
}

function createOptions(): CompilerOptions {
  const options: CompilerOptions = {};
  options.strict = true;
  options.target = ScriptTarget.ESNext;
  options.noEmit = true;
  return options;
}

/** Parse, bind, semantic and global diagnostics of `/input.ts`, in that order. */
function check(text: string, loader: LibLoader, options: CompilerOptions): Diagnostic[] {
  const file = parse('/input.ts', text);
  bindSourceFile(file);
  const files = loader.files.slice();
  files.push(file);
  const checker = new Checker(new CheckHost(options, files, loader.libs));
  const result: Diagnostic[] = [];
  for (const d of file.diagnostics) result.push(d);
  for (const d of file.bindDiagnostics) result.push(d);
  for (const d of checker.getDiagnostics(file)) result.push(d);
  for (const d of checker.getGlobalDiagnostics()) result.push(d);
  return result;
}

/** UTF-8 offset of each UTF-16 offset; the middle of a surrogate pair maps to its start. */
function utf8Offsets(text: string): Int32Array {
  const offsets = new Int32Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    offsets[i] = bytes;
    const ch = text.charCodeAt(i);
    if (ch < 0x80) bytes += 1;
    else if (ch < 0x800) bytes += 2;
    else if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        offsets[i + 1] = bytes;
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  offsets[text.length] = bytes;
  return offsets;
}

function format(diagnostics: Diagnostic[], text: string, out: string[]): void {
  const offsets = utf8Offsets(text);
  for (const d of diagnostics) {
    const name = d.file !== undefined ? d.file.fileName : '';
    let pos = d.pos;
    let len = d.end - d.pos;
    if (d.file !== undefined && d.file.fileName === '/input.ts') {
      const start = offsets[Math.min(d.pos, text.length)];
      pos = start;
      len = offsets[Math.min(d.end, text.length)] - start;
    }
    out.push(`${name} ${d.code} ${pos} ${len} ${d.localize(Locale.Default)}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const path = args[0];
  const libDir = args[1];
  const mode = args.length > 2 ? args[2] : '';
  const options = createOptions();
  const loader = new LibLoader(libDir, options);
  const out: string[] = [];
  if (mode === '--batch') {
    const list = readFileSync(path, 'utf8').split('\n');
    for (const line of list) {
      if (line === '') continue;
      let input: string;
      try {
        input = readFileSync(line, 'utf8');
      } catch {
        continue;
      }
      out.push('== ' + line);
      const start = out.length;
      try {
        format(check(input, loader, options), input, out);
      } catch {
        out.length = start;
        out.push('!! panic');
      }
    }
  } else if (mode === '--bench') {
    const text = readFileSync(path, 'utf8');
    let count = 0;
    const start = performance.now();
    for (let i = 0; i < 5; i++) count = check(text, loader, options).length;
    const ms = (performance.now() - start) / 5;
    out.push(`diagnostics ${count} time ${ms.toFixed(2)}ms`);
  } else {
    const text = readFileSync(path, 'utf8');
    format(check(text, loader, options), text, out);
  }
  if (out.length > 0) process.stdout.write(out.join('\n') + '\n');
}

main();
