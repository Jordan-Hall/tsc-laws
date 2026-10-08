// Emits JavaScript for the files on a tsc-style command line, without type checking.
// Usage: emit [compiler options] FILE...
// The files are loaded as a program, which decides each file's module format from its
// extension and nearest package.json, then bound; imports resolve between the program's files.
// Prints `unsupported FILE: REASON` for files using syntax emit doesn't support yet.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Node, SourceFile } from '../compiler/ast.js';
import { bindSourceFile } from '../compiler/binder.js';
import { CommandLineHost, parseCommandLine } from '../compiler/command-line.js';
import { EmitHost, emitFiles, sourceFileMayBeEmitted } from '../compiler/emitter.js';
import { CompilerHost } from '../compiler/file-loader.js';
import { CachedFileSystem, DirectoryEntries, FileSystem } from '../compiler/file-system.js';
import { Resolver } from '../compiler/module-resolution.js';
import type { CompilerOptions, ModuleKind } from '../compiler/options.js';
import { getDirectoryPath, getNormalizedAbsolutePath } from '../compiler/path.js';
import { Program } from '../compiler/program.js';
import { getEmitModuleFormatOfFile } from '../compiler/program-utilities.js';
import { ParsedCommandLine } from '../compiler/tsconfig.js';
import { SyntacticEmitResolver } from '../compiler/transformers/emit-resolver.js';
import { ModuleFormatHost } from '../compiler/transformers/module.js';
import { ModuleLookup, ReferenceResolver } from '../compiler/transformers/reference-resolver.js';

class FileHost extends CommandLineHost {
  readFile(path: string): string | undefined {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }
}

class NodeFileSystem extends FileSystem {
  constructor() {
    super(true);
  }

  fileExists(path: string): boolean {
    return existsSync(path) && statSync(path).isFile();
  }

  directoryExists(path: string): boolean {
    return existsSync(path) && statSync(path).isDirectory();
  }

  readFile(path: string): string | undefined {
    return this.fileExists(path) ? readFileSync(path, 'utf8') : undefined;
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    if (!this.directoryExists(path)) return new DirectoryEntries([], [], undefined);
    const files: string[] = [];
    const directories: string[] = [];
    const names = readdirSync(path).sort();
    for (let i = 0; i < names.length; i++) {
      const entry = path + '/' + names[i];
      if (lstatSync(entry).isDirectory()) directories.push(names[i]);
      else if (this.fileExists(entry)) files.push(names[i]);
    }
    return new DirectoryEntries(files, directories, undefined);
  }

  realpath(path: string): string {
    return existsSync(path) ? realpathSync(path) : path;
  }
}

/** Module formats from the program's file metadata: extensions and package.json `type`. */
class ProgramFormats extends ModuleFormatHost {
  readonly program: Program;

  constructor(program: Program) {
    super();
    this.program = program;
  }

  getEmitModuleFormat(fileName: string): ModuleKind {
    return getEmitModuleFormatOfFile(
      fileName,
      this.program.options,
      this.program.sourceFileMetadata(this.program.toPath(fileName)),
    );
  }
}

/** Module specifiers resolved with module resolution, to files of the program. */
class ProgramModules extends ModuleLookup {
  readonly program: Program;
  private readonly resolver: Resolver;

  constructor(program: Program, host: CompilerHost) {
    super();
    this.program = program;
    this.resolver = new Resolver(host, program.options);
  }

  resolveModule(location: Node, file: SourceFile, specifier: string): SourceFile | undefined {
    const mode = this.program.getModeForUsageLocation(file, location);
    const resolved = this.resolver.resolveModuleName(specifier, file.fileName, mode).resolvedFileName;
    return resolved === '' ? undefined : this.program.getSourceFile(resolved);
  }
}

class DiskEmitHost extends EmitHost {
  readonly program: Program;

  constructor(program: Program, resolver: SyntacticEmitResolver, formats: ModuleFormatHost) {
    super(program.options, resolver, formats, program.commonSourceDirectory(), program.currentDirectory, true);
    this.program = program;
  }

  isEmitBlocked(fileName: string): boolean {
    return this.program.isEmitBlocked(fileName);
  }

  writeFile(fileName: string, text: string): string {
    mkdirSync(getDirectoryPath(fileName), { recursive: true });
    writeFileSync(fileName, text);
    return '';
  }
}

function main(): number {
  const cwd = process.cwd();
  const parsed = parseCommandLine(process.argv.slice(2), new FileHost(cwd));
  const options: CompilerOptions = parsed.options;
  const fileNames = parsed.fileNames.map((name) => getNormalizedAbsolutePath(name, cwd));
  const host = new CompilerHost(new CachedFileSystem(new NodeFileSystem()), cwd, '');
  const config = new ParsedCommandLine(options, undefined, fileNames, [], undefined, [], cwd, true, fileNames.length);
  const program = new Program(config, host);
  const files: SourceFile[] = [];
  const all = program.getSourceFiles();
  for (let i = 0; i < all.length; i++) {
    bindSourceFile(all[i]);
    if (sourceFileMayBeEmitted(all[i], options)) files.push(all[i]);
  }
  const references = new ReferenceResolver(options, all, new ProgramModules(program, host));
  const emitHost = new DiskEmitHost(
    program,
    new SyntacticEmitResolver(options, references),
    new ProgramFormats(program),
  );
  const result = emitFiles(emitHost, files);
  for (const error of result.errors) console.error(error);
  for (const unsupported of result.unsupported) console.log('unsupported ' + unsupported);
  return result.errors.length > 0 ? 1 : 0;
}

process.exitCode = main();
