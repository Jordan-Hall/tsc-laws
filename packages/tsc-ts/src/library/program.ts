// Programs of tsc-ts's public API: createProgram, parseConfigFile and Program.

import type { SourceFile as CompilerSourceFile } from '../compiler/ast.js';
import { dropLibGlobals } from '../compiler/checker-symbols.js';
import type { Diagnostic as CompilerDiagnostic } from '../compiler/diagnostics.js';
import { CompilerHost } from '../compiler/file-loader.js';
import { CachedFileSystem } from '../compiler/file-system.js';
import { getNormalizedAbsolutePath } from '../compiler/path.js';
import { Program as CompilerProgram } from '../compiler/program.js';
import { CheckedProgram } from '../compiler/program-checker.js';
import { ConfigParser, ParsedCommandLine } from '../compiler/tsconfig.js';
import type { SourceFile } from './ast.js';
import { LibraryTypeChecker } from './checker.js';
import type { CompilerOptions } from './compiler-options.generated.js';
import { type DiagnosticKind, diagnosticOf, programDiagnostics } from './diagnostics.js';
import { DisposedProgramError, internalError } from './errors.js';
import { HostFileSystem } from './host.js';
import { type ApiCompilerOptions, compilerOptionsFromApi, compilerOptionsOf } from './options.js';
import type {
  CreateProgramOptions,
  Diagnostic,
  ParsedConfigFile,
  Program,
  ProgramHost,
  SourceFileMetadata,
  TypeChecker,
} from './types.js';

/**
 * A program of `rootNames` with `options`, reading files through `host`. It loads its files as `tsc-ts`
 * loads a project's: resolving imports and references from the root files, with the default libraries of
 * the options from the host's default library directory.
 */
export function createProgram(options: CreateProgramOptions): Program {
  try {
    const host = options.host;
    const currentDirectory = host.getCurrentDirectory();
    const rootNames = options.rootNames.map((name) => getNormalizedAbsolutePath(name, currentDirectory));
    const config = new ParsedCommandLine(
      compilerOptionsFromApi(options.options as ApiCompilerOptions),
      undefined,
      rootNames,
      [],
      undefined,
      [],
      currentDirectory,
      host.useCaseSensitiveFileNames(),
      rootNames.length,
    );
    return programOf(config, host);
  } catch (e) {
    throw internalError(e);
  }
}

/** The program of a config file (`parseConfigFile`'s options and files), reading files through `host`. */
export function createProgramFromConfigFile(configFileName: string, host: ProgramHost): Program {
  try {
    return programOf(parsedConfig(configFileName, host).config, host);
  } catch (e) {
    throw internalError(e);
  }
}

/**
 * The options and root files of a config file, with the diagnostics of reading it, as `tsc-ts --api`'s
 * parseConfigFile returns them. A config file that can't be read gives one diagnostic and no files.
 */
export function parseConfigFile(configFileName: string, host: ProgramHost): ParsedConfigFile {
  try {
    const { config, errors } = parsedConfig(configFileName, host);
    return {
      options: compilerOptionsOf(config.options) as CompilerOptions,
      fileNames: config.fileNames.slice(),
      diagnostics: errors.map(diagnosticOf),
    };
  } catch (e) {
    throw internalError(e);
  }
}

function parsedConfig(
  configFileName: string,
  host: ProgramHost,
): { config: ParsedCommandLine; errors: CompilerDiagnostic[] } {
  const currentDirectory = host.getCurrentDirectory();
  const errors: CompilerDiagnostic[] = [];
  const config =
    new ConfigParser(new HostFileSystem(host), currentDirectory).parseConfigFile(
      getNormalizedAbsolutePath(configFileName, currentDirectory),
      undefined,
      undefined,
      errors,
    ) ??
    new ParsedCommandLine(
      {},
      undefined,
      [],
      [],
      undefined,
      errors,
      currentDirectory,
      host.useCaseSensitiveFileNames(),
      0,
    );
  return { config, errors: config.errors };
}

function programOf(config: ParsedCommandLine, host: ProgramHost): Program {
  const fs = new CachedFileSystem(new HostFileSystem(host));
  const compilerHost = new CompilerHost(fs, host.getCurrentDirectory(), host.getDefaultLibraryDirectory());
  return new LibraryProgram(new CheckedProgram(new CompilerProgram(config, compilerHost)));
}

class LibraryProgram implements Program {
  private options: CompilerOptions | undefined = undefined;
  private typeChecker: LibraryTypeChecker | undefined = undefined;
  private disposed = false;

  constructor(private readonly checked: CheckedProgram) {}

  private get program(): CompilerProgram {
    this.checkNotDisposed();
    return this.checked.program;
  }

  private checkNotDisposed(): void {
    if (this.disposed) throw new DisposedProgramError();
  }

  getCompilerOptions(): CompilerOptions {
    try {
      this.options ??= compilerOptionsOf(this.program.options) as CompilerOptions;
      return this.options;
    } catch (e) {
      throw internalError(e);
    }
  }

  getSourceFile(fileName: string): SourceFile | undefined {
    try {
      return this.program.getSourceFile(fileName) as unknown as SourceFile | undefined;
    } catch (e) {
      throw internalError(e);
    }
  }

  getSourceFiles(): readonly SourceFile[] {
    try {
      return this.program.getSourceFiles() as unknown as readonly SourceFile[];
    } catch (e) {
      throw internalError(e);
    }
  }

  getSourceFileNames(): readonly string[] {
    try {
      return this.program.getSourceFiles().map((file) => file.fileName);
    } catch (e) {
      throw internalError(e);
    }
  }

  getSourceFileMetadata(fileName: string): SourceFileMetadata | undefined {
    try {
      const program = this.program;
      const file = program.getSourceFile(fileName);
      if (file === undefined) return undefined;
      const metadata = program.sourceFileMetadata(file.path);
      return {
        isDefaultLibrary: program.isSourceFileDefaultLibrary(file.path),
        isFromExternalLibrary: program.isSourceFileFromExternalLibrary(file),
        packageJsonType: metadata.packageJsonType,
        packageJsonDirectory: metadata.packageJsonDirectory,
        impliedNodeFormat: metadata.impliedNodeFormat,
      };
    } catch (e) {
      throw internalError(e);
    }
  }

  isSourceFileDefaultLibrary(file: SourceFile): boolean {
    try {
      return this.program.isSourceFileDefaultLibrary((file as unknown as CompilerSourceFile).path);
    } catch (e) {
      throw internalError(e);
    }
  }

  isSourceFileFromExternalLibrary(file: SourceFile): boolean {
    try {
      return this.program.isSourceFileFromExternalLibrary(file as unknown as CompilerSourceFile);
    } catch (e) {
      throw internalError(e);
    }
  }

  getTypeChecker(): TypeChecker {
    try {
      if (this.typeChecker === undefined) {
        this.checkNotDisposed();
        this.typeChecker = new LibraryTypeChecker(this.checked.createChecker());
      }
      return this.typeChecker;
    } catch (e) {
      throw internalError(e);
    }
  }

  private diagnostics(kind: DiagnosticKind, file: SourceFile | undefined): readonly Diagnostic[] {
    try {
      this.checkNotDisposed();
      return programDiagnostics(this.checked, kind, file as unknown as CompilerSourceFile | undefined).map(
        diagnosticOf,
      );
    } catch (e) {
      throw internalError(e);
    }
  }

  getSyntacticDiagnostics(file?: SourceFile): readonly Diagnostic[] {
    return this.diagnostics('syntactic', file);
  }

  getBindDiagnostics(file?: SourceFile): readonly Diagnostic[] {
    return this.diagnostics('bind', file);
  }

  getSemanticDiagnostics(file?: SourceFile): readonly Diagnostic[] {
    return this.diagnostics('semantic', file);
  }

  getSuggestionDiagnostics(file?: SourceFile): readonly Diagnostic[] {
    return this.diagnostics('suggestion', file);
  }

  getDeclarationDiagnostics(file?: SourceFile): readonly Diagnostic[] {
    return this.diagnostics('declaration', file);
  }

  getProgramDiagnostics(): readonly Diagnostic[] {
    return this.diagnostics('program', undefined);
  }

  getGlobalDiagnostics(): readonly Diagnostic[] {
    return this.diagnostics('global', undefined);
  }

  getConfigFileParsingDiagnostics(): readonly Diagnostic[] {
    return this.diagnostics('config', undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.typeChecker?.dispose();
    this.typeChecker = undefined;
    this.checked.disposeCheckers();
    dropLibGlobals(this.checked.program.getSourceFiles());
    this.disposed = true;
  }
}
