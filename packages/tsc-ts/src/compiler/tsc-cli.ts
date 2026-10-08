/**
 * The `tsc` command line up to compilation: argument errors, `--init`, `--version`, `--help`,
 * project lookup and `--showConfig`.
 */
import {
  createCompilerDiagnostic,
  Diagnostics,
  formatDiagnostic,
  formatDiagnosticWithColorAndContext,
  parseLocale,
  type Diagnostic,
  type DiagnosticFormatOptions,
  type Locale,
} from './diagnostics.js';
import {
  CommandLineHost,
  parseBuildCommandLine,
  parseCommandLine,
  type ParsedBuildCommandLine,
  type ParsedCommandLine,
} from './command-line.js';
import { Colors, defaultIsPretty, header, printBuildHelp, printHelp, printVersion } from './help.js';
import { generateTSConfig } from './init.js';
import type { CompilerOptions } from './options.js';
import { combinePaths, getDirectoryPath, normalizePath } from './path.js';
import { showConfig } from './show-config.js';

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
  ) {
    super(currentDirectory);
  }

  /** Returns `''` for unset variables. */
  abstract getEnvironmentVariable(name: string): string;
  abstract write(text: string): void;
  abstract fileExists(path: string): boolean;
  abstract directoryExists(path: string): boolean;
  abstract writeFile(path: string, text: string): boolean;
}

/** How a `tsc` run ended, or the work left for the compiler. */
export type CommandLineResult =
  | { readonly kind: 'exit'; readonly status: ExitStatus }
  /** Load `configFileName`, merge `commandLine` into it, then compile or `--showConfig`. */
  | { readonly kind: 'config'; readonly configFileName: string; readonly commandLine: ParsedCommandLine }
  /** Compile the command-line files with the command-line options. */
  | { readonly kind: 'compile'; readonly commandLine: ParsedCommandLine }
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

  if (configFileName !== '') return { kind: 'config', configFileName, commandLine };
  if (options.showConfig === true) {
    sys.write(
      showConfig(
        {
          options,
          fileNames,
          currentDirectory: sys.currentDirectory,
          useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
        },
        '',
      ),
    );
    return exit(ExitStatus.Success);
  }
  return { kind: 'compile', commandLine };
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
