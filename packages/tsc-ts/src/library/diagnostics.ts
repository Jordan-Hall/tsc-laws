// The diagnostics of programs, as tsc-ts's public API and `tsc-ts --api` return them.

import type { SourceFile } from '../compiler/ast.js';
import { type Diagnostic as CompilerDiagnostic, Locale } from '../compiler/diagnostics.js';
import { sortAndDeduplicateDiagnostics } from '../compiler/program.js';
import type { CheckedProgram } from '../compiler/program-checker.js';
import type { DiagnosticCategory } from './enums.generated.js';
import type { Diagnostic } from './types.js';

export type DiagnosticKind =
  | 'config'
  | 'program'
  | 'global'
  | 'syntactic'
  | 'bind'
  | 'semantic'
  | 'suggestion'
  | 'declaration';

/** A diagnostic as plain data, with its text in the default locale and its chain and related information. */
export function diagnosticOf(d: CompilerDiagnostic): Diagnostic {
  return {
    fileName: d.file?.fileName,
    pos: d.pos,
    end: d.end,
    code: d.code,
    category: d.category as number as DiagnosticCategory,
    text: d.localize(Locale.Default),
    reportsUnnecessary: d.reportsUnnecessary,
    reportsDeprecated: d.reportsDeprecated,
    messageChain: d.messageChain.map(diagnosticOf),
    relatedInformation: d.relatedInformation.map(diagnosticOf),
  };
}

/**
 * The diagnostics of one kind for `file`, or for every file of the program without one. Global
 * diagnostics are those of no file, after the semantic diagnostics of every file, as tsgo's API returns
 * them. Declaration diagnostics are empty, as tsgo's API returns them.
 */
export function programDiagnostics(
  checked: CheckedProgram,
  kind: DiagnosticKind,
  file: SourceFile | undefined,
): readonly CompilerDiagnostic[] {
  const program = checked.program;
  switch (kind) {
    case 'config':
      return program.getConfigFileParsingDiagnostics();
    case 'program':
      return program.getProgramDiagnostics();
    case 'global': {
      checked.getSemanticDiagnostics(undefined);
      const all = [
        ...program.getConfigFileParsingDiagnostics(),
        ...program.getProgramDiagnostics(),
        ...checked.getGlobalDiagnostics(),
      ];
      return sortAndDeduplicateDiagnostics(all).filter((d) => d.file === undefined);
    }
    case 'syntactic':
      return program.getSyntacticDiagnostics(file);
    case 'bind':
      return checked.getBindDiagnostics(file);
    case 'semantic':
      return checked.getSemanticDiagnostics(file);
    case 'suggestion':
      return checked.getSuggestionDiagnostics(file);
    case 'declaration':
      return [];
  }
}

/**
 * What `semantic` answers for each of `files` and what `global` answers, after checking `files` and
 * no other file. Checking one file can add diagnostics located in another, so every file is checked
 * before any file's diagnostics are collected. With every file of the program listed, the answers are
 * those of the full check.
 */
export function checkedFileDiagnostics(
  checked: CheckedProgram,
  files: readonly SourceFile[],
): { files: (readonly CompilerDiagnostic[])[]; global: readonly CompilerDiagnostic[] } {
  for (const file of files) checked.getSemanticDiagnostics(file);
  const program = checked.program;
  const global = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getProgramDiagnostics(),
    ...checked.getGlobalDiagnostics(),
  ];
  return {
    files: files.map((file) => checked.getSemanticDiagnostics(file)),
    global: sortAndDeduplicateDiagnostics(global).filter((d) => d.file === undefined),
  };
}
