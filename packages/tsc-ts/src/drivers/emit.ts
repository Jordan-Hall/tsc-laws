// Emits JavaScript for the files on a tsc-style command line, without type checking.
// Usage: emit [compiler options] FILE...
// Imports are elided from one file's syntax, as when their modules can't be resolved.
// Prints `unsupported FILE: REASON` for files using syntax emit doesn't support yet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ExternalModuleIndicatorOptions, ParseOptions, ScriptKind, type SourceFile } from '../compiler/ast.js';
import { CommandLineHost, parseCommandLine } from '../compiler/command-line.js';
import { EmitHost, emitFiles } from '../compiler/emitter.js';
import {
  type CompilerOptions,
  JsxEmit,
  ModuleDetectionKind,
  ModuleKind,
  getEmitModuleDetectionKind,
  getEmitModuleKind,
} from '../compiler/options.js';
import { getCommonSourceDirectory } from '../compiler/output-paths.js';
import { parseSourceFile } from '../compiler/parser.js';
import { combinePaths, fileExtensionIsOneOf, getDirectoryPath, getNormalizedAbsolutePath } from '../compiler/path.js';
import { SyntacticEmitResolver } from '../compiler/transformers/emit-resolver.js';
import { ModuleFormatHost } from '../compiler/transformers/module.js';

class FileHost extends CommandLineHost {
  readFile(path: string): string | undefined {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }
}

/** Module formats from file extensions and the nearest package.json `type`. */
class PackageTypeFormats extends ModuleFormatHost {
  readonly options: CompilerOptions;
  private readonly packageTypes: Map<string, ModuleKind>;

  constructor(options: CompilerOptions) {
    super();
    this.options = options;
    this.packageTypes = new Map<string, ModuleKind>();
  }

  getEmitModuleFormat(fileName: string): ModuleKind {
    const moduleKind = getEmitModuleKind(this.options);
    if (fileExtensionIsOneOf(fileName, ['.mts', '.mjs'])) return ModuleKind.ESNext;
    if (fileExtensionIsOneOf(fileName, ['.cts', '.cjs'])) return ModuleKind.CommonJS;
    if (moduleKind < ModuleKind.Node16 || moduleKind > ModuleKind.NodeNext) return moduleKind;
    return this.packageType(getDirectoryPath(fileName));
  }

  private packageType(directory: string): ModuleKind {
    const cached = this.packageTypes.get(directory);
    if (cached !== undefined) return cached;
    let result = ModuleKind.CommonJS;
    const packageJson = combinePaths(directory, 'package.json');
    if (existsSync(packageJson)) {
      const text = readFileSync(packageJson, 'utf8');
      result = /"type"\s*:\s*"module"/.test(text) ? ModuleKind.ESNext : ModuleKind.CommonJS;
    } else {
      const parent = getDirectoryPath(directory);
      if (parent !== directory) result = this.packageType(parent);
    }
    this.packageTypes.set(directory, result);
    return result;
  }
}

class DiskEmitHost extends EmitHost {
  constructor(
    options: CompilerOptions,
    formats: ModuleFormatHost,
    commonSourceDirectory: string,
    currentDirectory: string,
  ) {
    super(options, new SyntacticEmitResolver(options), formats, commonSourceDirectory, currentDirectory, true);
  }

  writeFile(fileName: string, text: string): string {
    mkdirSync(getDirectoryPath(fileName), { recursive: true });
    writeFileSync(fileName, text);
    return '';
  }
}

function parse(fileName: string, options: CompilerOptions, formats: ModuleFormatHost): SourceFile {
  const text = readFileSync(fileName, 'utf8');
  const jsx = options.jsx === JsxEmit.ReactJSX || options.jsx === JsxEmit.ReactJSXDev;
  const detection = getEmitModuleDetectionKind(options);
  const moduleKind = getEmitModuleKind(options);
  // As tsgo: forced in ESM-format files of node16+ projects under `moduleDetection: auto`.
  const force =
    detection === ModuleDetectionKind.Force ||
    fileExtensionIsOneOf(fileName, ['.mts', '.mjs', '.cts', '.cjs']) ||
    (detection === ModuleDetectionKind.Auto &&
      moduleKind >= ModuleKind.Node16 &&
      moduleKind <= ModuleKind.NodeNext &&
      formats.getEmitModuleFormat(fileName) === ModuleKind.ESNext);
  return parseSourceFile(
    fileName,
    text,
    new ParseOptions(fileName, ScriptKind.Unknown, new ExternalModuleIndicatorOptions(jsx, force)),
  );
}

function main(): number {
  const cwd = process.cwd();
  const parsed = parseCommandLine(process.argv.slice(2), new FileHost(cwd));
  const options = parsed.options;
  const fileNames = parsed.fileNames.map((name) => getNormalizedAbsolutePath(name, cwd));
  const formats = new PackageTypeFormats(options);
  const files = fileNames.map((name) => parse(name, options, formats));
  const host = new DiskEmitHost(
    options,
    formats,
    getCommonSourceDirectory(options, () => fileNames, cwd, true, undefined),
    cwd,
  );
  const result = emitFiles(host, files);
  for (const error of result.errors) console.error(error);
  for (const unsupported of result.unsupported) console.log('unsupported ' + unsupported);
  return result.errors.length > 0 ? 1 : 0;
}

process.exitCode = main();
