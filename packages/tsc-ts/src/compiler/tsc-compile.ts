/**
 * The `tsc` compile step after the command line: bind and check the program, emit it, then report
 * diagnostics, listed files and the error summary like tsgo's `EmitFilesAndReportErrors`.
 */
import type { Node, SourceFile } from './ast.js';
import type { Diagnostic } from './diagnostics.js';
import { EmitHost, emitFiles, EmitResult } from './emitter.js';
import { Resolver } from './module-resolution.js';
import { getEmitDeclarations, type ModuleKind } from './options.js';
import { getNormalizedAbsolutePath } from './path.js';
import { Program, sortAndDeduplicateDiagnostics } from './program.js';
import { CheckedProgram } from './program-checker.js';
import { getEmitModuleFormatOfFile } from './program-utilities.js';
import { SyntacticDeclarationEmitResolver } from './transformers/declarations-syntactic.js';
import { type EmitResolver, SyntacticEmitResolver } from './transformers/emit-resolver.js';
import { ModuleFormatHost } from './transformers/module.js';
import { ModuleLookup, ReferenceResolver } from './transformers/reference-resolver.js';
import { type CommandLineResult, ExitStatus, type System } from './tsc-cli.js';

type CompileWork = Extract<CommandLineResult, { kind: 'compile' }>;

/** Binds, checks and emits the program of `work`; returns the exit status. */
export function compile(sys: System, work: CompileWork): ExitStatus {
  const program = work.program;
  const options = program.options;
  const checked = new CheckedProgram(program);
  const diagnostics = getProgramDiagnostics(checked);

  let emitResult: EmitResult | undefined = undefined;
  if (options.listFilesOnly !== true) {
    if (options.noEmitOnError === true && diagnostics.length > 0) {
      emitResult = new EmitResult();
      emitResult.emitSkipped = true;
    } else emitResult = emitProgram(sys, program);
    for (const diagnostic of emitResult.diagnostics) diagnostics.push(diagnostic);
  }
  const all = sortAndDeduplicateDiagnostics(diagnostics);
  work.reporter.reportAll(all);
  listFiles(sys, program, emitResult);
  work.errorSummary.report(all);

  if (all.length === 0) return ExitStatus.Success;
  return emitResult === undefined || emitResult.emitSkipped
    ? ExitStatus.DiagnosticsPresent_OutputsSkipped
    : ExitStatus.DiagnosticsPresent_OutputsGenerated;
}

/** Config and syntax errors; without them, option, global and semantic errors too. */
function getProgramDiagnostics(checked: CheckedProgram): Diagnostic[] {
  const program = checked.program;
  const result: Diagnostic[] = [...program.getConfigFileParsingDiagnostics()];
  const configCount = result.length;
  for (const d of program.getSyntacticDiagnostics()) result.push(d);
  if (result.length !== configCount) return result;
  for (const d of program.getProgramDiagnostics()) result.push(d);
  if (program.options.listFilesOnly === true) return result;
  for (const d of checked.getGlobalDiagnostics()) result.push(d);
  if (result.length === configCount) {
    for (const d of checked.getSemanticDiagnostics(undefined)) result.push(d);
    // Checking may have found more, such as missing global types.
    for (const d of checked.getGlobalDiagnostics()) result.push(d);
  }
  return result;
}

function listFiles(sys: System, program: Program, emitResult: EmitResult | undefined): void {
  const options = program.options;
  if (options.listEmittedFiles === true && emitResult !== undefined) {
    let out = '';
    for (const file of emitResult.emittedFiles) {
      out += 'TSFILE: ' + getNormalizedAbsolutePath(file, program.currentDirectory) + '\n';
    }
    sys.write(out);
  }
  if (options.listFiles === true || options.listFilesOnly === true) {
    let out = '';
    for (const file of program.getSourceFiles()) out += file.fileName + '\n';
    sys.write(out);
  }
}

function emitProgram(sys: System, program: Program): EmitResult {
  const options = program.options;
  const files = program.getSourceFiles();
  const references = new ReferenceResolver(options, files, new ProgramModules(program));
  const emitResolver = new SyntacticEmitResolver(options, references);
  let resolver: EmitResolver = emitResolver;
  if (getEmitDeclarations(options)) {
    resolver = new SyntacticDeclarationEmitResolver(options, files, program.currentDirectory, emitResolver);
  }
  const host = new SystemEmitHost(sys, program, resolver);
  const result = emitFiles(host, files);
  // Emit is skipped only for files that would have been emitted.
  if (options.noEmit === true) result.emitSkipped = files.some((file) => program.sourceFileMayBeEmitted(file, false));
  return result;
}

/** Module formats from the program's file metadata. */
class ProgramFormats extends ModuleFormatHost {
  constructor(private readonly program: Program) {
    super();
  }

  getEmitModuleFormat(fileName: string): ModuleKind {
    const program = this.program;
    return getEmitModuleFormatOfFile(fileName, program.options, program.sourceFileMetadata(program.toPath(fileName)));
  }
}

/** Module specifiers resolved to files of the program. */
class ProgramModules extends ModuleLookup {
  private readonly resolver: Resolver;

  constructor(private readonly program: Program) {
    super();
    this.resolver = new Resolver(program.host, program.options);
  }

  resolveModule(location: Node, file: SourceFile, specifier: string): SourceFile | undefined {
    const mode = this.program.getModeForUsageLocation(file, location);
    const resolved = this.resolver.resolveModuleName(specifier, file.fileName, mode).resolvedFileName;
    return resolved === '' ? undefined : this.program.getSourceFile(resolved);
  }
}

class SystemEmitHost extends EmitHost {
  constructor(
    private readonly sys: System,
    private readonly program: Program,
    resolver: EmitResolver,
  ) {
    super(
      program.options,
      resolver,
      new ProgramFormats(program),
      program.commonSourceDirectory(),
      program.currentDirectory,
      program.useCaseSensitiveFileNames,
    );
  }

  isEmitBlocked(fileName: string): boolean {
    return this.program.isEmitBlocked(fileName);
  }

  writeFile(fileName: string, text: string): string {
    return this.sys.writeFile(fileName, text) ? '' : `Could not write file '${fileName}'.`;
  }
}
