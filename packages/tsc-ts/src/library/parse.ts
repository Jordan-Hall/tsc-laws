// Parsing one file with tsc-ts's public API.

import { ParseOptions, type ScriptKind as CompilerScriptKind } from '../compiler/ast.js';
import { CompilerHost, sourceFileMetadataOf } from '../compiler/file-loader.js';
import { CachedFileSystem } from '../compiler/file-system.js';
import { Resolver } from '../compiler/module-resolution.js';
import { parseSourceFile as parse } from '../compiler/parser.js';
import { getNormalizedAbsolutePath, toPath } from '../compiler/path.js';
import { getExternalModuleIndicatorOptions } from '../compiler/program-utilities.js';
import type { SourceFile } from './ast.js';
import type { CompilerOptions } from './compiler-options.generated.js';
import { ScriptKind } from './enums.generated.js';
import { internalError } from './errors.js';
import { HostFileSystem } from './host.js';
import { type ApiCompilerOptions, compilerOptionsFromApi } from './options.js';
import type { ProgramHost } from './types.js';

export interface ParseSourceFileOptions {
  /** The options of the program the file would be in: they decide what makes it a module. */
  readonly compilerOptions?: CompilerOptions;
  /** Where the nearest package.json of the file is looked up; the disk without a host. */
  readonly host?: ProgramHost;
  /** The script kind; by default, the kind the file name's extension implies. */
  readonly scriptKind?: ScriptKind;
}

/**
 * `fileName` (absolute, or relative to the host's current directory) with the contents `text`, parsed
 * as a program with `compilerOptions` parses it: the same tree `tsc-ts --api` gives for the file in a
 * project of that file alone, with parents set. Whether the file is a module depends on its nearest
 * package.json, as in a program. The tree is not bound.
 */
export function parseSourceFile(fileName: string, text: string, options: ParseSourceFileOptions = {}): SourceFile {
  try {
    const host = options.host ?? diskHost();
    const currentDirectory = host.getCurrentDirectory();
    const compilerOptions = compilerOptionsFromApi((options.compilerOptions ?? {}) as ApiCompilerOptions);
    const normalized = getNormalizedAbsolutePath(fileName, currentDirectory);
    const path = toPath(normalized, currentDirectory, host.useCaseSensitiveFileNames());
    const compilerHost = new CompilerHost(
      new CachedFileSystem(new HostFileSystem(host)),
      currentDirectory,
      host.getDefaultLibraryDirectory(),
    );
    const metadata = sourceFileMetadataOf(new Resolver(compilerHost, compilerOptions), compilerOptions, normalized);
    const parseOptions = new ParseOptions(
      path,
      (options.scriptKind ?? ScriptKind.Unknown) as number as CompilerScriptKind,
      getExternalModuleIndicatorOptions(normalized, compilerOptions, metadata),
    );
    return parse(normalized, text, parseOptions) as unknown as SourceFile;
  } catch (e) {
    throw internalError(e);
  }
}

function diskHost(): ProgramHost {
  return {
    getCurrentDirectory: () => process.cwd(),
    useCaseSensitiveFileNames: () => process.platform !== 'win32' && process.platform !== 'darwin',
    getDefaultLibraryDirectory: () => '',
  };
}
