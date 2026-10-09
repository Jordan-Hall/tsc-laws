/**
 * When the semantic diagnostics of a program's default library files are known without checking them.
 *
 * Library files declare globals and refer only to global names, and they are checked by a checker that checks
 * nothing else. When no other file of the program declares globals (a script, `declare global`,
 * `export as namespace` or a pattern ambient module), every name in them resolves to library declarations, so
 * their diagnostics are those of a program of the library files alone. For the library sets in
 * `verified-libraries.ts`, with the bundled library texts, tsgo reports none for such a program, under every
 * combination of the options that change how declarations relate and the others alone and in random
 * combinations (scripts/verify-libraries.mjs).
 */
import type { SourceFile } from './ast.js';
import { isGlobalScopeAugmentation } from './ast-utilities.js';
import { isExternalOrCommonJSModule } from './binder-utilities.js';
import type { Program } from './program.js';
import { hash128String, toHex } from './xxh3.js';
import { verifiedLibraries, verifiedLibrarySets } from './verified-libraries.js';

/** Whether the default library files of the bound `program` have no semantic diagnostics. */
export function libraryDiagnosticsAreKnownEmpty(program: Program): boolean {
  const digits: number[] = [];
  for (let i = 0; i < verifiedLibraries.length; i += 4) digits.push(0);
  for (const file of program.getSourceFiles()) {
    const library = program.getDefaultLibFile(file.path);
    if (library === undefined) {
      if (declaresGlobals(file)) return false;
      continue;
    }
    const index = libraryIndex(library.name);
    if (index < 0 || verifiedLibraries[index]![1] !== toHex(hash128String(file.text))) return false;
    digits[index >> 2] = digits[index >> 2]! | (1 << (index & 3));
  }
  let mask = '';
  for (const digit of digits) mask += digit.toString(16);
  return verifiedLibrarySets.has(mask);
}

let libraryIndices: Map<string, number> | undefined = undefined;

function libraryIndex(name: string): number {
  let indices = libraryIndices;
  if (indices === undefined) {
    indices = new Map();
    for (let i = 0; i < verifiedLibraries.length; i++) indices.set(verifiedLibraries[i]![0], i);
    libraryIndices = indices;
  }
  return indices.get(name) ?? -1;
}

/** Whether `file` adds to or changes the global scope. */
function declaresGlobals(file: SourceFile): boolean {
  if (!isExternalOrCommonJSModule(file) && file.locals !== undefined && file.locals.size !== 0) return true;
  if (file.patternAmbientModules.length !== 0) return true;
  if (file.globalExports !== undefined && file.globalExports.size !== 0) return true;
  for (const augmentation of file.moduleAugmentations) {
    if (augmentation.parent !== undefined && isGlobalScopeAugmentation(augmentation.parent)) return true;
  }
  return false;
}
