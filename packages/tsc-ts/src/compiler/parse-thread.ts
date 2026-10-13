/**
 * A parse thread of parallel-parse.ts: loads the chunks of files the main thread sends with a
 * FileLoader of its own, which parses, binds and resolves them as the program's FileLoader will, and
 * returns their bound source files, published, with the files they add.
 */
import { publish } from '@scriptc/threads';
import { type ExternalModuleIndicatorOptions, ParseOptions, ScriptKind, type SourceFile } from './ast.js';
import { bindSourceFile } from './binder.js';
import { CompilerHost, FileLoader } from './file-loader.js';
import type { FileSystem } from './file-system.js';
import { LoadJobs, type LoadMessage, PreparedBatch, PreparedFile } from './parallel-parse.js';
import { parseSourceFile } from './parser.js';
import type { ParsedCommandLine } from './tsconfig.js';

/** Parses and binds the files the loader asks for, and keeps them with their parse inputs. */
class PreparingHost extends CompilerHost {
  prepared: PreparedFile[] = [];

  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    const text = this.fs.readFile(fileName);
    if (text === undefined) return undefined;
    const file = parseSourceFile(
      fileName,
      text,
      new ParseOptions(path, ScriptKind.Unknown, externalModuleIndicatorOptions),
    );
    bindSourceFile(file);
    this.prepared.push(
      new PreparedFile(fileName, path, externalModuleIndicatorOptions.jsx, externalModuleIndicatorOptions.force, file),
    );
    return file;
  }
}

export class ParseThread {
  private readonly host: PreparingHost;
  private readonly loader: FileLoader;

  constructor(config: ParsedCommandLine, fs: FileSystem, currentDirectory: string, defaultLibraryPath: string) {
    this.host = new PreparingHost(fs, currentDirectory, defaultLibraryPath);
    this.loader = new FileLoader(this.host, config);
  }

  /** Loads `chunk`: its bound files, published, and the files they add. */
  load(chunk: LoadMessage): PreparedBatch {
    const start = performance.now();
    const added = new LoadJobs();
    const files = this.host.prepared;
    for (let i = 0; i < chunk.names.length; i++) {
      const before = files.length;
      const loaded = this.loader.loadAhead(chunk.kinds[i]!, chunk.names[i]!, chunk.depths[i]!, added);
      // What the loader found loading the file it just prepared.
      if (loaded !== undefined && files.length === before + 1 && files[before]!.file === loaded.file)
        files[before]!.loaded = loaded;
    }
    this.host.prepared = [];
    return publish(new PreparedBatch(files, added, performance.now() - start));
  }
}
