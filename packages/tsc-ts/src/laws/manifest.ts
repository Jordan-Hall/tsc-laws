// `tsc-ts --laws-manifest <files>`: lists the `law` declarations of the files as JSON, with the problems
// that stop a law from running. Types are not resolved here; the declaration emit carries them.
import { readFileSync } from 'node:fs';
import { FunctionDeclaration, Identifier, ParameterDeclaration, type SourceFile } from '../compiler/ast.js';
import { NodeFlags, ModifierFlags } from '../compiler/ast.js';
import { parseSourceFile } from '../compiler/parser.js';
import { computeLineStarts } from '../compiler/scanner.js';

class LawEntry {
  constructor(
    readonly file: string,
    readonly name: string,
    readonly exported: boolean,
    readonly proved: boolean,
    readonly line: number,
    readonly params: string[],
    readonly body: string,
    readonly text: string,
    readonly problems: string[],
  ) {}
}

function lineOf(starts: number[], pos: number): number {
  let line = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i]! > pos) break;
    line = i;
  }
  return line + 1;
}

function lawsOf(file: SourceFile, fileName: string): LawEntry[] {
  const starts = computeLineStarts(file.text);
  const laws: LawEntry[] = [];
  for (const statement of file.statements.nodes) {
    if (!(statement instanceof FunctionDeclaration) || (statement.flags & NodeFlags.Law) === 0) continue;
    const problems: string[] = [];
    const exported =
      statement.modifiers !== undefined && (statement.modifiers.modifierFlags & ModifierFlags.Export) !== 0;
    if (!exported) problems.push('a law must be exported so the runner can load it');
    if (
      statement.modifiers !== undefined &&
      (statement.modifiers.modifierFlags & ModifierFlags.Default) !== 0
    )
      problems.push('a law cannot be the default export');
    if (statement.body === undefined) problems.push('a law needs a body');
    const params: string[] = [];
    for (const parameter of statement.parameters.nodes) {
      if (!(parameter instanceof ParameterDeclaration) || !(parameter.name instanceof Identifier)) {
        problems.push('law parameters must be plain identifiers');
        continue;
      }
      if (parameter.type === undefined)
        problems.push(`parameter '${parameter.name.text}' needs a type annotation to generate inputs`);
      params.push(parameter.name.text);
    }
    const body = statement.body === undefined ? '' : file.text.substring(statement.body.pos, statement.body.end).trim();
    laws.push(
      new LawEntry(
        fileName,
        statement.name === undefined ? '' : statement.name.text,
        exported,
        (statement.flags & NodeFlags.Proved) !== 0,
        lineOf(starts, statement.name === undefined ? statement.pos : statement.name.pos),
        params,
        body,
        file.text.substring(statement.name === undefined ? statement.pos : statement.name.pos, statement.end).trim(),
        problems,
      ),
    );
  }
  return laws;
}

/** Writes the manifest of `fileNames` to stdout; returns the exit status (1 when a law has problems). */
export function runLawsManifest(fileNames: string[]): number {
  const laws: LawEntry[] = [];
  for (const fileName of fileNames) {
    const text = readFileSync(fileName, 'utf8');
    const file = parseSourceFile(fileName, text);
    for (const law of lawsOf(file, fileName)) laws.push(law);
  }
  process.stdout.write(JSON.stringify({ version: 1, laws }) + '\n');
  for (const law of laws) if (law.problems.length > 0) return 1;
  return 0;
}
