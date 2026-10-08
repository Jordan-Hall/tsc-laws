/**
 * The `tsc` command line up to binding: argument errors, `--init`, `--version`, `--help`, project lookup,
 * tsconfig.json, `--showConfig`, program construction and `--listFilesOnly`.
 */
import {
  createCompilerDiagnostic,
  Diagnostics,
  formatDiagnostic,
  formatDiagnosticWithColorAndContext,
  formatErrorSummary,
  localizeMessage,
  parseLocale,
  type Diagnostic,
  type DiagnosticFormatOptions,
  type Locale,
  type MessageWithArgs,
} from './diagnostics.js';
import { CompilerHost } from './file-loader.js';
import { CachedFileSystem, FileSystem, type DirectoryEntries } from './file-system.js';
import { Program, sortAndDeduplicateDiagnostics } from './program.js';
import { ConfigParser, ParsedCommandLine as ProjectConfig } from './tsconfig.js';
import {
  CommandLineHost,
  parseBuildCommandLine,
  parseCommandLine,
  type ParsedBuildCommandLine,
  type ParsedCommandLine,
} from './command-line.js';
import { Colors, defaultIsPretty, header, printBuildHelp, printHelp, printVersion } from './help.js';
import { generateTSConfig } from './init.js';
import { isIncremental, type CompilerOptions } from './options.js';
import { combinePaths, getDirectoryPath, normalizePath } from './path.js';
import { showConfig, type ShowConfigInput } from './show-config.js';

export enum ExitStatus {
  Success = 0,
  DiagnosticsPresent_OutputsSkipped = 1,
  DiagnosticsPresent_OutputsGenerated = 2,
  InvalidProject_OutputsSkipped = 3,
  ProjectReferenceCycle_OutputsSkipped = 4,
  NotImplemented = 5,
}

/** The process environment `tsc` runs in. All output goes to `write`. */
export abstract class System extends CommandLineHost {
  constructor(
    currentDirectory: string,
    readonly writeOutputIsTTY: boolean,
    /** Columns of the output terminal; `0` when not a terminal. */
    readonly terminalWidth: number,
    readonly useCaseSensitiveFileNames: boolean,
    /** Where the bundled `lib.*.d.ts` files are. */
    readonly defaultLibraryPath: string,
  ) {
    super(currentDirectory);
  }

  /** Returns `''` for unset variables. */
  abstract getEnvironmentVariable(name: string): string;
  abstract write(text: string): void;
  abstract fileExists(path: string): boolean;
  abstract directoryExists(path: string): boolean;
  abstract writeFile(path: string, text: string): boolean;
  /** Sorted entries of a directory; empty if it can't be read. */
  abstract getAccessibleEntries(path: string): DirectoryEntries;
  /** The path with symlinks resolved, or `path` itself if it does not exist. */
  abstract realpath(path: string): string;
}

/** The file system of a `System`. */
class SystemFileSystem extends FileSystem {
  constructor(private readonly sys: System) {
    super(sys.useCaseSensitiveFileNames);
  }

  fileExists(path: string): boolean {
    return this.sys.fileExists(path);
  }

  directoryExists(path: string): boolean {
    return this.sys.directoryExists(path);
  }

  readFile(path: string): string | undefined {
    return this.sys.readFile(path);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    return this.sys.getAccessibleEntries(path);
  }

  realpath(path: string): string {
    return this.sys.realpath(path);
  }
}

/** A compiler host writing `--traceResolution` output to the system. */
class SystemCompilerHost extends CompilerHost {
  constructor(
    private readonly sys: System,
    fs: FileSystem,
    private readonly locale: Locale,
  ) {
    super(fs, sys.currentDirectory, sys.defaultLibraryPath);
  }

  trace(message: MessageWithArgs): void {
    this.sys.write(localizeMessage(this.locale, message.message, message.args) + '\n');
  }
}

/** How a `tsc` run ended, or the work left for the compiler. */
export type CommandLineResult =
  | { readonly kind: 'exit'; readonly status: ExitStatus }
  /** Bind, check and emit `program`, reporting with `reporter` and `errorSummary`. */
  | {
      readonly kind: 'compile';
      readonly program: Program;
      readonly incremental: boolean;
      readonly reporter: DiagnosticReporter;
      readonly errorSummary: ErrorSummaryReporter;
    }
  /** Watch the project of `config`. */
  | { readonly kind: 'watch'; readonly config: ProjectConfig; readonly commandLine: ParsedCommandLine }
  | { readonly kind: 'build'; readonly commandLine: ParsedBuildCommandLine };

function exit(status: ExitStatus): CommandLineResult {
  return { kind: 'exit', status };
}

/** Writes diagnostics in tsgo's plain or colored format, or nothing under `--quiet`. */
export class DiagnosticReporter {
  private readonly quiet: boolean;
  private readonly pretty: boolean;
  private readonly format: DiagnosticFormatOptions;

  constructor(
    private readonly sys: System,
    options: CompilerOptions,
    locale: Locale,
  ) {
    this.quiet = options.quiet === true;
    this.pretty = options.pretty ?? defaultIsPretty(sys);
    this.format = {
      locale,
      currentDirectory: sys.currentDirectory,
      useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
      newLine: '\n',
    };
  }

  report(diagnostic: Diagnostic): void {
    if (this.quiet) return;
    if (this.pretty) this.sys.write(formatDiagnosticWithColorAndContext(diagnostic, this.format) + '\n');
    else this.sys.write(formatDiagnostic(diagnostic, this.format));
  }

  reportAll(diagnostics: readonly Diagnostic[]): void {
    for (const diagnostic of diagnostics) this.report(diagnostic);
  }
}

/** Writes "Found N errors" after diagnostics under `--pretty`. */
export class ErrorSummaryReporter {
  private readonly pretty: boolean;
  private readonly format: DiagnosticFormatOptions;

  constructor(
    private readonly sys: System,
    options: CompilerOptions,
    locale: Locale,
  ) {
    this.pretty = options.pretty ?? defaultIsPretty(sys);
    this.format = {
      locale,
      currentDirectory: sys.currentDirectory,
      useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
      newLine: '\n',
    };
  }

  report(diagnostics: readonly Diagnostic[]): void {
    if (this.pretty) this.sys.write(formatErrorSummary(diagnostics, this.format));
  }
}

/** The language of messages and help: tsgo's choice of translation for `--locale`. */
export function outputLocale(options: CompilerOptions): Locale {
  return parseLocale(options.locale ?? '');
}

/** Runs `tsc` with `args` (without the executable). */
export function executeCommandLine(sys: System, args: readonly string[]): CommandLineResult {
  if (args.length > 0) {
    const first = args[0].toLowerCase();
    if (first === '-b' || first === '--b' || first === '-build' || first === '--build') {
      return executeBuild(sys, parseBuildCommandLine(args, sys));
    }
  }
  return executeCompile(sys, parseCommandLine(args, sys));
}

function executeBuild(sys: System, commandLine: ParsedBuildCommandLine): CommandLineResult {
  const locale = outputLocale(commandLine.compilerOptions);
  const reporter = new DiagnosticReporter(sys, commandLine.compilerOptions, locale);
  if (commandLine.errors.length > 0) {
    reporter.reportAll(commandLine.errors);
    return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
  }
  if (commandLine.compilerOptions.help === true) {
    printVersion(sys, locale);
    printBuildHelp(sys, locale);
    return exit(ExitStatus.Success);
  }
  return { kind: 'build', commandLine };
}

function executeCompile(sys: System, commandLine: ParsedCommandLine): CommandLineResult {
  const options = commandLine.options;
  const locale = outputLocale(options);
  const reporter = new DiagnosticReporter(sys, options, locale);
  if (commandLine.errors.length > 0) {
    reporter.reportAll(commandLine.errors);
    return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
  }
  if (options.init === true) {
    writeConfigFile(sys, locale, reporter, commandLine);
    return exit(ExitStatus.Success);
  }
  if (options.version === true) {
    printVersion(sys, locale);
    return exit(ExitStatus.Success);
  }
  if (options.help === true || options.all === true) {
    printHelp(sys, locale, options.all === true);
    return exit(ExitStatus.Success);
  }
  if (options.watch === true && options.listFilesOnly === true) {
    reporter.report(createCompilerDiagnostic(Diagnostics.Options_0_and_1_cannot_be_combined, 'watch', 'listFilesOnly'));
    return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
  }

  const fileNames = commandLine.fileNames;
  let configFileName = '';
  if (options.project !== undefined) {
    if (fileNames.length !== 0) {
      reporter.report(
        createCompilerDiagnostic(Diagnostics.Option_project_cannot_be_mixed_with_source_files_on_a_command_line),
      );
      return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
    }
    const project = normalizePath(options.project);
    if (sys.directoryExists(project)) {
      configFileName = combinePaths(project, 'tsconfig.json');
      if (!sys.fileExists(configFileName)) {
        reporter.report(
          createCompilerDiagnostic(
            Diagnostics.Cannot_find_a_tsconfig_json_file_at_the_current_directory_Colon_0,
            configFileName,
          ),
        );
        return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
      }
    } else {
      configFileName = project;
      if (!sys.fileExists(configFileName)) {
        reporter.report(createCompilerDiagnostic(Diagnostics.The_specified_path_does_not_exist_Colon_0, project));
        return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
      }
    }
  } else if (options.ignoreConfig !== true || fileNames.length === 0) {
    const searchPath = normalizePath(sys.currentDirectory);
    configFileName = findConfigFile(sys, searchPath);
    if (fileNames.length !== 0) {
      if (configFileName !== '') {
        reporter.report(
          createCompilerDiagnostic(
            Diagnostics.X_tsconfig_json_is_present_but_will_not_be_loaded_if_files_are_specified_on_commandline_Use_ignoreConfig_to_skip_this_error,
          ),
        );
        return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
      }
    } else if (configFileName === '') {
      if (options.showConfig === true) {
        reporter.report(
          createCompilerDiagnostic(
            Diagnostics.Cannot_find_a_tsconfig_json_file_at_the_current_directory_Colon_0,
            searchPath,
          ),
        );
      } else {
        printVersion(sys, locale);
        printHelp(sys, locale, false);
      }
      return exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
    }
  }

  const fs = new CachedFileSystem(new SystemFileSystem(sys));
  let config = new ProjectConfig(
    options,
    undefined,
    fileNames,
    [],
    undefined,
    [],
    sys.currentDirectory,
    sys.useCaseSensitiveFileNames,
    0,
  );
  if (configFileName !== '') {
    const errors: Diagnostic[] = [];
    const parsed = new ConfigParser(fs, sys.currentDirectory).parseConfigFile(
      configFileName,
      options,
      commandLine.raw,
      errors,
    );
    if (parsed === undefined) {
      reporter.reportAll(errors);
      return exit(ExitStatus.DiagnosticsPresent_OutputsGenerated);
    }
    config = parsed;
  }

  // The summary follows `pretty` of the config; diagnostics only that of the command line, as in tsgo.
  const errorSummary = new ErrorSummaryReporter(sys, config.options, locale);
  if (options.showConfig === true) {
    sys.write(showConfig(showConfigInput(config, sys), configFileName));
    return exit(ExitStatus.Success);
  }
  if (config.options.watch === true) return { kind: 'watch', config, commandLine };

  const program = new Program(config, new SystemCompilerHost(sys, fs, locale));
  // Statistics need checking and emit timings.
  const statistics = config.options.diagnostics === true || config.options.extendedDiagnostics === true;
  if (config.options.listFilesOnly === true && !statistics) {
    return exit(listFilesOnly(sys, program, locale, reporter, errorSummary));
  }
  return { kind: 'compile', program, incremental: isIncremental(config.options), reporter, errorSummary };
}

/** What `--showConfig` prints for a project. */
function showConfigInput(config: ProjectConfig, sys: System): ShowConfigInput {
  const specs = config.configFile?.configFileSpecs;
  let include: readonly string[] | undefined;
  if (specs !== undefined) {
    const includeSpecs = specs.validatedIncludeSpecs;
    if (!(includeSpecs.length === 1 && includeSpecs[0] === '**/*')) include = includeSpecs;
  }
  return {
    options: config.options,
    fileNames: config.fileNames,
    currentDirectory: config.configFile !== undefined ? config.currentDirectory : sys.currentDirectory,
    useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
    references: config.projectReferences,
    include,
    exclude: specs?.validatedExcludeSpecs,
  };
}

/**
 * `--listFilesOnly`: config, syntax and program diagnostics, then the files (explained under `--explainFiles`).
 * Nothing is checked or emitted.
 */
function listFilesOnly(
  sys: System,
  program: Program,
  locale: Locale,
  reporter: DiagnosticReporter,
  errorSummary: ErrorSummaryReporter,
): ExitStatus {
  let diagnostics: Diagnostic[] = [...program.getConfigFileParsingDiagnostics()];
  const configDiagnosticsCount = diagnostics.length;
  for (const diagnostic of program.getSyntacticDiagnostics()) diagnostics.push(diagnostic);
  if (diagnostics.length === configDiagnosticsCount) {
    for (const diagnostic of program.getProgramDiagnostics()) diagnostics.push(diagnostic);
  }
  diagnostics = sortAndDeduplicateDiagnostics(diagnostics);
  reporter.reportAll(diagnostics);
  if (program.options.explainFiles === true) {
    sys.write(program.explainFiles(locale));
  } else {
    let out = '';
    for (const file of program.getSourceFiles()) out += file.fileName + '\n';
    sys.write(out);
  }
  errorSummary.report(diagnostics);
  return diagnostics.length > 0 ? ExitStatus.DiagnosticsPresent_OutputsSkipped : ExitStatus.Success;
}

/** The nearest `tsconfig.json` in `directory` or its ancestors, or `''`. */
function findConfigFile(sys: System, directory: string): string {
  let current = directory;
  for (;;) {
    const candidate = combinePaths(current, 'tsconfig.json');
    if (sys.fileExists(candidate)) return candidate;
    const parent = getDirectoryPath(current);
    if (parent === current) return '';
    current = parent;
  }
}

function writeConfigFile(
  sys: System,
  locale: Locale,
  reporter: DiagnosticReporter,
  commandLine: ParsedCommandLine,
): void {
  const file = normalizePath(combinePaths(sys.currentDirectory, 'tsconfig.json'));
  if (sys.fileExists(file)) {
    reporter.report(createCompilerDiagnostic(Diagnostics.A_tsconfig_json_file_is_already_defined_at_Colon_0, file));
    return;
  }
  sys.writeFile(file, generateTSConfig(commandLine.raw, locale));
  sys.write(
    '\n' +
      header(sys, new Colors(sys), 'Created a new tsconfig.json') +
      'You can learn more at https://aka.ms/tsconfig\n',
  );
}
