// What a migration tells the person: files read, laws written, and every construct it left behind, with file:line.

export type EntryKind =
  /** A test that was skipped on purpose (`.skip`, `.todo`, `xit`): no law is written for it. */
  | 'skipped'
  /** A construct with no faithful law: it is left out or kept as it was, and the person decides. */
  | 'unconverted'
  /** Converted, but something was dropped or changes meaning (a timeout, a `.only`, a hook that now runs per law). */
  | 'note';

export interface Entry {
  file: string;
  line: number;
  kind: EntryKind;
  message: string;
}

export interface FileResult {
  /** The source, relative to the working directory, with forward slashes. */
  source: string;
  /** Where the laws would be written (relative to the working directory), or undefined when none were produced. */
  target?: string;
  /** The text of the converted file. */
  output?: string;
  /** Names of the laws written, in order. */
  laws: string[];
  entries: Entry[];
  /** Set by `--write`: whether the file was written, and why not otherwise. */
  written?: 'written' | 'exists' | 'dry-run' | 'none';
}

export interface MigrateReport {
  from: string;
  write: boolean;
  files: FileResult[];
}

export function lawCount(report: MigrateReport): number {
  return report.files.reduce((total, f) => total + f.laws.length, 0);
}

export function entriesOf(report: MigrateReport, kind: EntryKind): Entry[] {
  return report.files.flatMap((f) => f.entries.filter((e) => e.kind === kind));
}

/** The text `tslaws migrate` prints: a summary, then what was skipped, what could not be converted, and notes. */
export function renderReport(report: MigrateReport): string {
  const lines: string[] = [`tslaws migrate ${report.from}${report.write ? '' : ' (dry run: nothing is written)'}`, ''];
  for (const file of report.files) {
    const counts = ['skipped', 'unconverted', 'note']
      .map((k) => [k, file.entries.filter((e) => e.kind === k).length] as const)
      .filter(([, n]) => n > 0)
      .map(
        ([k, n]) => `${n} ${k === 'unconverted' ? 'not converted' : k === 'note' ? (n === 1 ? 'note' : 'notes') : k}`,
      );
    const where =
      file.target === undefined
        ? 'no laws'
        : `${file.target}: ${file.laws.length} law${file.laws.length === 1 ? '' : 's'}`;
    const state =
      file.written === 'written' ? ' [written]' : file.written === 'exists' ? ' [exists: not overwritten]' : '';
    lines.push(`${file.source} -> ${where}${counts.length > 0 ? ` (${counts.join(', ')})` : ''}${state}`);
  }
  const section = (title: string, kind: EntryKind): void => {
    const found = entriesOf(report, kind);
    if (found.length === 0) return;
    lines.push('', `${title} (${found.length}):`);
    for (const e of found) lines.push(`  ${e.file}:${e.line} ${e.message}`);
  };
  section('Skipped, no law written', 'skipped');
  section('Not converted', 'unconverted');
  section('Notes', 'note');
  const converted = report.files.filter((f) => f.target !== undefined).length;
  lines.push(
    '',
    `Files: ${report.files.length} read, ${converted} converted. Laws emitted: ${lawCount(report)}. Not converted: ${entriesOf(report, 'unconverted').length}.`,
  );
  if (!report.write && converted > 0)
    lines.push('Dry run: pass --write to write the files. Existing files are never overwritten.');
  if (converted > 0)
    lines.push(
      'The new laws are not in tsc-laws.lock. Read them, run `tslaws check`, and have a person run `tslaws accept`.',
    );
  return `${lines.join('\n')}\n`;
}
