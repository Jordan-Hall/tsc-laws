// How a relative module specifier ends, as tsgo's module specifier generation decides it: no
// extension and no `/index`, or a `.js` (or `.ts`) extension where the resolution mode
// requires one or the importing file's other imports use them.
import { type SourceFile, getText } from './ast.js';
import {
  type CompilerOptions,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  getAllowImportingTsExtensions,
  getModuleResolutionKind,
} from './options.js';
import {
  fileExtensionIsOneOf,
  getDeclarationFileExtension,
  hasJSFileExtension,
  hasTSFileExtension,
  isDeclarationFileName,
  pathIsRelative,
  removeExtension,
  removeFileExtension,
  tryGetExtensionFromPath,
} from './path.js';

export const enum ModuleSpecifierEnding {
  Minimal,
  Index,
  JsExtension,
  TsExtension,
}

const extensionsNotSupportingExtensionlessResolution = ['.mts', '.d.mts', '.mjs', '.cts', '.d.cts', '.cjs'];

function isNodeNext(options: CompilerOptions): boolean {
  const kind = getModuleResolutionKind(options);
  return ModuleResolutionKind.Node16 <= kind && kind <= ModuleResolutionKind.NodeNext;
}

function shouldAllowImportingTsExtension(options: CompilerOptions, fromFileName: string): boolean {
  return getAllowImportingTsExtensions(options) || (fromFileName !== '' && isDeclarationFileName(fromFileName));
}

function usesExtensionsOnImports(file: SourceFile): boolean {
  for (const specifier of file.imports) {
    const text = getText(specifier);
    if (pathIsRelative(text) && !fileExtensionIsOneOf(text, extensionsNotSupportingExtensionlessResolution))
      return hasTSFileExtension(text) || hasJSFileExtension(text);
  }
  return false;
}

function inferPreference(resolutionMode: ModuleKind, file: SourceFile, nodeNext: boolean): ModuleSpecifierEnding {
  let usesJsExtensions = false;
  for (const specifier of file.imports) {
    const path = getText(specifier);
    if (!pathIsRelative(path)) continue;
    if (nodeNext && resolutionMode === ModuleKind.CommonJS) continue;
    if (fileExtensionIsOneOf(path, extensionsNotSupportingExtensionlessResolution)) continue;
    if (hasTSFileExtension(path)) return ModuleSpecifierEnding.TsExtension;
    if (hasJSFileExtension(path)) usesJsExtensions = true;
  }
  return usesJsExtensions ? ModuleSpecifierEnding.JsExtension : ModuleSpecifierEnding.Minimal;
}

/** The preferred ending; `jsPreferred` is declaration emit's preference for ESM files. */
function getEndingPreference(
  jsPreferred: boolean,
  resolutionMode: ModuleKind,
  options: CompilerOptions,
  file: SourceFile,
): ModuleSpecifierEnding {
  const nodeNext = isNodeNext(options);
  if (jsPreferred || (resolutionMode === ModuleKind.ESNext && nodeNext)) {
    if (!shouldAllowImportingTsExtension(options, '')) return ModuleSpecifierEnding.JsExtension;
    return inferPreference(resolutionMode, file, nodeNext) !== ModuleSpecifierEnding.JsExtension
      ? ModuleSpecifierEnding.TsExtension
      : ModuleSpecifierEnding.JsExtension;
  }
  if (!shouldAllowImportingTsExtension(options, ''))
    return usesExtensionsOnImports(file) ? ModuleSpecifierEnding.JsExtension : ModuleSpecifierEnding.Minimal;
  return inferPreference(resolutionMode, file, nodeNext);
}

/**
 * The endings a specifier from `file` may have, most preferred first. `defaultMode` is the
 * file's resolution mode and `importMode` the import's.
 */
export function getAllowedEndingsInPreferredOrder(
  jsPreferred: boolean,
  options: CompilerOptions,
  file: SourceFile,
  defaultMode: ModuleKind,
  importMode: ModuleKind,
): ModuleSpecifierEnding[] {
  let preferred = getEndingPreference(jsPreferred, defaultMode, options, file);
  if (defaultMode !== importMode) preferred = getEndingPreference(jsPreferred, importMode, options, file);
  const allowTs = shouldAllowImportingTsExtension(options, file.fileName);
  if (importMode === ModuleKind.ESNext && isNodeNext(options))
    return allowTs
      ? [ModuleSpecifierEnding.TsExtension, ModuleSpecifierEnding.JsExtension]
      : [ModuleSpecifierEnding.JsExtension];
  switch (preferred) {
    case ModuleSpecifierEnding.JsExtension:
      return allowTs
        ? [
            ModuleSpecifierEnding.JsExtension,
            ModuleSpecifierEnding.TsExtension,
            ModuleSpecifierEnding.Minimal,
            ModuleSpecifierEnding.Index,
          ]
        : [ModuleSpecifierEnding.JsExtension, ModuleSpecifierEnding.Minimal, ModuleSpecifierEnding.Index];
    case ModuleSpecifierEnding.TsExtension:
      return [
        ModuleSpecifierEnding.TsExtension,
        ModuleSpecifierEnding.Minimal,
        ModuleSpecifierEnding.JsExtension,
        ModuleSpecifierEnding.Index,
      ];
    case ModuleSpecifierEnding.Index:
      return allowTs
        ? [
            ModuleSpecifierEnding.Index,
            ModuleSpecifierEnding.Minimal,
            ModuleSpecifierEnding.TsExtension,
            ModuleSpecifierEnding.JsExtension,
          ]
        : [ModuleSpecifierEnding.Index, ModuleSpecifierEnding.Minimal, ModuleSpecifierEnding.JsExtension];
  }
  return allowTs
    ? [
        ModuleSpecifierEnding.Minimal,
        ModuleSpecifierEnding.Index,
        ModuleSpecifierEnding.TsExtension,
        ModuleSpecifierEnding.JsExtension,
      ]
    : [ModuleSpecifierEnding.Minimal, ModuleSpecifierEnding.Index, ModuleSpecifierEnding.JsExtension];
}

/** The JavaScript extension a file is imported with, or `''`. */
export function tryGetJSExtensionForFile(fileName: string, options: CompilerOptions): string {
  const extension = tryGetExtensionFromPath(fileName);
  switch (extension) {
    case '.ts':
    case '.d.ts':
      return '.js';
    case '.tsx':
      return options.jsx === JsxEmit.Preserve ? '.jsx' : '.js';
    case '.js':
    case '.jsx':
    case '.json':
      return extension;
    case '.d.mts':
    case '.mts':
    case '.mjs':
      return '.mjs';
    case '.d.cts':
    case '.cts':
    case '.cjs':
      return '.cjs';
  }
  return '';
}

/**
 * `fileName`, a path to a module, with the ending the first of `allowedEndings` gives it.
 * `fileExists` tells whether a file stands for a directory's path, which keeps its `/index`.
 */
export function processEnding(
  fileName: string,
  allowedEndings: ModuleSpecifierEnding[],
  options: CompilerOptions,
  fileExists: (pathWithoutExtension: string) => boolean,
): string {
  if (fileExtensionIsOneOf(fileName, ['.json', '.mjs', '.cjs'])) return fileName;
  const noExtension = removeFileExtension(fileName);
  if (fileName === noExtension) return fileName;
  const jsPriority = allowedEndings.indexOf(ModuleSpecifierEnding.JsExtension);
  const tsPriority = allowedEndings.indexOf(ModuleSpecifierEnding.TsExtension);
  if (fileExtensionIsOneOf(fileName, ['.mts', '.cts']) && tsPriority !== -1 && tsPriority < jsPriority) return fileName;
  if (fileExtensionIsOneOf(fileName, ['.d.mts', '.d.cts'])) {
    const inputExtension = getDeclarationFileExtension(fileName);
    return removeExtension(fileName, inputExtension) + (inputExtension === '.d.mts' ? '.mjs' : '.cjs');
  }
  if (fileExtensionIsOneOf(fileName, ['.mts', '.cts']))
    return noExtension + tryGetJSExtensionForFile(fileName, options);
  switch (allowedEndings.length > 0 ? allowedEndings[0] : ModuleSpecifierEnding.Minimal) {
    case ModuleSpecifierEnding.Minimal: {
      const withoutIndex = noExtension.endsWith('/index')
        ? noExtension.substring(0, noExtension.length - '/index'.length)
        : noExtension;
      // A file named like the directory would be imported instead.
      if (withoutIndex !== noExtension && fileExists(withoutIndex)) return noExtension;
      return withoutIndex;
    }
    case ModuleSpecifierEnding.Index:
      return noExtension;
    case ModuleSpecifierEnding.JsExtension:
      return noExtension + tryGetJSExtensionForFile(fileName, options);
    case ModuleSpecifierEnding.TsExtension: {
      // A declaration file can't be imported with `.d.ts`; it's imported without an extension or as `.js`.
      if (isDeclarationFileName(fileName)) {
        let extensionlessPriority = -1;
        for (let i = 0; i < allowedEndings.length; i++)
          if (
            allowedEndings[i] === ModuleSpecifierEnding.Minimal ||
            allowedEndings[i] === ModuleSpecifierEnding.Index
          ) {
            extensionlessPriority = i;
            break;
          }
        if (extensionlessPriority !== -1 && extensionlessPriority < jsPriority) return noExtension;
        return noExtension + tryGetJSExtensionForFile(fileName, options);
      }
      return fileName;
    }
  }
  return fileName;
}
