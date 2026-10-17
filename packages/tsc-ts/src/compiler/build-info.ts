/**
 * The `.tsbuildinfo` file: what an incremental or `--build` compilation records about a program, in
 * tsgo's JSON format, and reading it back.
 */
import { RepopulateInfo } from './diagnostics.js';
import { version } from './help.js';
import { optionDeclarations, type OptionDeclaration } from './option-declarations.js';
import {
  compilerOptionNames,
  getCompilerOption,
  getEmitDeclarations,
  setCompilerOption,
  type CompilerOptions,
  type CompilerOptionValue,
} from './options.js';
import { JsonParser, type JsonObject, type JsonValue } from './package-json.js';
import { getNormalizedAbsolutePath, pathIsAbsolute, pathIsRelative, toPath } from './path.js';

/** What emit a file still needs, or which outputs an option set produces. */
export const enum FileEmitKind {
  None = 0,
  Js = 1 << 0,
  JsMap = 1 << 1,
  JsInlineMap = 1 << 2,
  DtsErrors = 1 << 3,
  DtsEmit = 1 << 4,
  DtsMap = 1 << 5,

  Dts = DtsErrors | DtsEmit,
  AllJs = Js | JsMap | JsInlineMap,
  AllDtsEmit = DtsEmit | DtsMap,
  AllDts = Dts | DtsMap,
  All = AllJs | AllDts,
}

export function getFileEmitKind(options: CompilerOptions): number {
  let result: number = FileEmitKind.Js;
  if (options.sourceMap === true) result |= FileEmitKind.JsMap;
  if (options.inlineSourceMap === true) result |= FileEmitKind.JsInlineMap;
  if (getEmitDeclarations(options)) result |= FileEmitKind.Dts;
  if (options.declarationMap === true) result |= FileEmitKind.DtsMap;
  if (options.emitDeclarationOnly === true) result &= FileEmitKind.AllDts;
  return result;
}

/** The emit `emitKind` needs beyond what `oldEmitKind` already produced. */
export function getPendingEmitKind(emitKind: number, oldEmitKind: number): number {
  if (oldEmitKind === emitKind) return FileEmitKind.None;
  if (oldEmitKind === 0 || emitKind === 0) return emitKind;
  const diff = oldEmitKind ^ emitKind;
  let result: number = FileEmitKind.None;
  if ((diff & FileEmitKind.AllJs) !== 0) result |= emitKind & FileEmitKind.AllJs;
  if ((diff & FileEmitKind.DtsErrors) !== 0) result |= emitKind & FileEmitKind.AllDts;
  if ((diff & FileEmitKind.AllDtsEmit) !== 0) result |= emitKind & FileEmitKind.AllDtsEmit;
  return result;
}

export function getPendingEmitKindWithOptions(options: CompilerOptions, oldOptions: CompilerOptions): number {
  return getPendingEmitKind(getFileEmitKind(options), getFileEmitKind(oldOptions));
}

/** Library file names are stored bare; everything else relative to the build info. */
export function isBuildInfoFileNameDefaultLibrary(fileName: string): boolean {
  return !pathIsRelative(fileName) && !pathIsAbsolute(fileName);
}

/** Root files: a range of file ids, a single id (`end` 0), or a file name of a non-incremental program. */
export class BuildInfoRoot {
  constructor(
    public start: number,
    public end: number,
    readonly nonIncremental: string,
  ) {}
}

export const enum FileInfoForm {
  /** Only a version string: signature equal to it, CommonJS, no global effects. */
  Short,
  NoSignature,
  Full,
}

export class BuildInfoFileInfo {
  constructor(
    readonly form: FileInfoForm,
    readonly version: string,
    /** `''` when the same as `version` in the full form. */
    readonly signature: string,
    readonly affectsGlobalScope: boolean,
    readonly impliedNodeFormat: number,
  ) {}
}

export class BuildInfoDiagnostic {
  file = 0;
  noFile = false;
  pos = 0;
  end = 0;
  code = 0;
  category = 0;
  messageKey = '';
  messageArgs: string[] = [];
  messageChain: BuildInfoDiagnostic[] = [];
  relatedInformation: BuildInfoDiagnostic[] = [];
  reportsUnnecessary = false;
  reportsDeprecated = false;
  skippedOnNoEmit = false;
  repopulateInfo: RepopulateInfo | undefined = undefined;
}

export class BuildInfoDiagnosticsOfFile {
  constructor(
    readonly fileId: number,
    readonly diagnostics: BuildInfoDiagnostic[],
  ) {}
}

/** A file still to be checked (`diagnostics` undefined), or the cached diagnostics of one. */
export class BuildInfoSemanticDiagnostic {
  constructor(
    readonly fileId: number,
    readonly diagnostics: BuildInfoDiagnosticsOfFile | undefined,
  ) {}
}

export class BuildInfoFilePendingEmit {
  constructor(
    readonly fileId: number,
    /** 0 when everything the options produce is pending. */
    readonly emitKind: number,
  ) {}
}

export class BuildInfoEmitSignature {
  constructor(
    readonly fileId: number,
    readonly signature: string,
    readonly differsOnlyInDtsMap: boolean,
    readonly differsInOptions: boolean,
  ) {}

  noEmitSignature(): boolean {
    return this.signature === '' && !this.differsOnlyInDtsMap && !this.differsInOptions;
  }
}

export class BuildInfoReference {
  constructor(
    readonly fileId: number,
    readonly fileIdListId: number,
  ) {}
}

export class BuildInfoResolvedRoot {
  constructor(
    readonly resolved: number,
    readonly root: number,
  ) {}
}

/** An option value recorded in the build info. */
export class BuildInfoOption {
  constructor(
    readonly name: string,
    readonly value: CompilerOptionValue,
  ) {}
}

export class BuildInfo {
  version = '';
  errors = false;
  checkPending = false;
  root: BuildInfoRoot[] = [];
  packageJsons: string[] = [];
  missingPackageJsons: string[] = [];
  fileNames: string[] = [];
  fileInfos: BuildInfoFileInfo[] = [];
  fileIdsList: number[][] = [];
  /**
   * The ids of each `fileIdsList` entry joined with commas, when the writer of the build info kept them,
   * or the reader read them from text that has them so; empty otherwise.
   */
  fileIdsListText: string[] = [];
  options: BuildInfoOption[] | undefined = undefined;
  referencedMap: BuildInfoReference[] = [];
  semanticDiagnosticsPerFile: BuildInfoSemanticDiagnostic[] = [];
  emitDiagnosticsPerFile: BuildInfoDiagnosticsOfFile[] = [];
  changeFileSet: number[] = [];
  affectedFilesPendingEmit: BuildInfoFilePendingEmit[] = [];
  latestChangedDtsFile = '';
  emitSignatures: BuildInfoEmitSignature[] = [];
  resolvedRoot: BuildInfoResolvedRoot[] = [];
  semanticErrors = false;

  isValidVersion(): boolean {
    return this.version === version;
  }

  isIncremental(): boolean {
    return this.fileNames.length !== 0;
  }

  fileName(fileId: number): string {
    return fileId >= 1 && fileId <= this.fileNames.length ? this.fileNames[fileId - 1] : '';
  }

  fileInfo(fileId: number): BuildInfoFileInfo | undefined {
    return fileId >= 1 && fileId <= this.fileInfos.length ? this.fileInfos[fileId - 1] : undefined;
  }

  /** The recorded options, with file paths made absolute against `buildInfoDirectory`. */
  getCompilerOptions(buildInfoDirectory: string): CompilerOptions {
    const options: CompilerOptions = {};
    const recorded = this.options;
    if (recorded === undefined) return options;
    for (const option of recorded) {
      const declaration = compilerOptionDeclaration(option.name);
      let value = option.value;
      if (declaration !== undefined && buildInfoDirectory !== '') {
        if (declaration.kind === 'list' && declaration.element?.isFilePath === true && Array.isArray(value)) {
          value = value.map((v) => getNormalizedAbsolutePath(v, buildInfoDirectory));
        } else if (declaration.isFilePath === true && typeof value === 'string' && value !== '') {
          value = getNormalizedAbsolutePath(value, buildInfoDirectory);
        }
      }
      setCompilerOption(options, option.name, value);
    }
    return options;
  }

  /** Whether outputs the options of `resolved` produce weren't emitted yet. */
  isEmitPending(options: CompilerOptions, buildInfoDirectory: string): boolean {
    if (options.noEmit !== true || getEmitDeclarations(options)) {
      let pending = getPendingEmitKindWithOptions(options, this.getCompilerOptions(buildInfoDirectory));
      if (options.noEmit === true) pending &= FileEmitKind.DtsErrors;
      return pending !== 0;
    }
    return false;
  }

  getPackageJsons(buildInfoDirectory: string): string[] {
    return this.packageJsons.map((p) => getNormalizedAbsolutePath(p, buildInfoDirectory));
  }

  getMissingPackageJsons(buildInfoDirectory: string): string[] {
    return this.missingPackageJsons.map((p) => getNormalizedAbsolutePath(p, buildInfoDirectory));
  }

  getRootInfoReader(buildInfoDirectory: string, useCaseSensitiveFileNames: boolean): BuildInfoRootInfoReader {
    return new BuildInfoRootInfoReader(this, buildInfoDirectory, useCaseSensitiveFileNames);
  }
}

/** Root files of a build info and their recorded versions, by path. */
export class BuildInfoRootInfoReader {
  private readonly resolvedRootFileInfos = new Map<string, BuildInfoFileInfo>();
  /** Root paths, in order, to the paths they resolved to. */
  readonly rootToResolved = new Map<string, string>();

  constructor(buildInfo: BuildInfo, buildInfoDirectory: string, useCaseSensitiveFileNames: boolean) {
    const resolvedToRoot = new Map<string, string>();
    for (const resolved of buildInfo.resolvedRoot) {
      const resolvedRoot = buildInfo.fileName(resolved.resolved);
      const root = buildInfo.fileName(resolved.root);
      if (resolvedRoot !== '' && root !== '') {
        resolvedToRoot.set(
          toPath(resolvedRoot, buildInfoDirectory, useCaseSensitiveFileNames),
          toPath(root, buildInfoDirectory, useCaseSensitiveFileNames),
        );
      }
    }
    const addRoot = (resolvedRoot: string, fileInfo: BuildInfoFileInfo | undefined): void => {
      if (resolvedRoot === '') return;
      const resolvedRootPath = toPath(resolvedRoot, buildInfoDirectory, useCaseSensitiveFileNames);
      const rootPath = resolvedToRoot.get(resolvedRootPath);
      this.rootToResolved.set(rootPath ?? resolvedRootPath, resolvedRootPath);
      if (fileInfo !== undefined) this.resolvedRootFileInfos.set(resolvedRootPath, fileInfo);
    };
    for (const root of buildInfo.root) {
      if (root.nonIncremental !== '') addRoot(root.nonIncremental, undefined);
      else if (root.end === 0) addRoot(buildInfo.fileName(root.start), buildInfo.fileInfo(root.start));
      else for (let i = root.start; i <= root.end; i++) addRoot(buildInfo.fileName(i), buildInfo.fileInfo(i));
    }
  }

  /** The recorded info of a root input and the path it resolved to; `''` if it wasn't a root. */
  getFileInfo(inputFilePath: string): { info: BuildInfoFileInfo | undefined; resolved: string } {
    const info = this.resolvedRootFileInfos.get(inputFilePath);
    if (info !== undefined) return { info, resolved: inputFilePath };
    const resolved = this.rootToResolved.get(inputFilePath);
    if (resolved !== undefined) return { info: this.resolvedRootFileInfos.get(resolved), resolved };
    return { info: undefined, resolved: '' };
  }

  roots(): string[] {
    return [...this.rootToResolved.keys()];
  }
}

/** The version recorded for a file, or `''`. */
export function buildInfoFileVersion(info: BuildInfoFileInfo | undefined): string {
  return info === undefined ? '' : info.version;
}

let declarationsByName: Map<string, OptionDeclaration> | undefined = undefined;

function compilerOptionDeclaration(name: string): OptionDeclaration | undefined {
  if (declarationsByName === undefined) {
    declarationsByName = new Map();
    for (const declaration of optionDeclarations) declarationsByName.set(declaration.name, declaration);
  }
  return declarationsByName.get(name);
}

/** Declarations of compiler options in tsgo's field order, with their option names. */
export function compilerOptionDeclarationsInFieldOrder(): OptionDeclaration[] {
  const result: OptionDeclaration[] = [];
  for (const name of compilerOptionNames) {
    const declaration = compilerOptionDeclaration(name);
    if (declaration !== undefined) result.push(declaration);
  }
  return result;
}

/** The value of a compiler option, `undefined` when unset (paths are not supported). */
export function compilerOptionValue(options: CompilerOptions, name: string): CompilerOptionValue | undefined {
  return getCompilerOption(options, name);
}

// ---- Writing

function quote(text: string): string {
  return JSON.stringify(text);
}

function stringArray(items: readonly string[]): string {
  let out = '[';
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out += ',';
    out += quote(items[i]);
  }
  return out + ']';
}

function numberArray(items: readonly number[]): string {
  let out = '[';
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out += ',';
    out += String(items[i]);
  }
  return out + ']';
}

/** Writes `"key":value` pairs separated by commas. */
class ObjectWriter {
  private text = '{';
  private first = true;

  add(key: string, value: string): void {
    if (!this.first) this.text += ',';
    this.first = false;
    this.text += quote(key) + ':' + value;
  }

  done(): string {
    return this.text + '}';
  }
}

function rootJson(root: BuildInfoRoot): string {
  if (root.start !== 0) return root.end !== 0 ? `[${root.start},${root.end}]` : String(root.start);
  return quote(root.nonIncremental);
}

function fileInfoJson(info: BuildInfoFileInfo): string {
  if (info.form === FileInfoForm.Short) return quote(info.version);
  const w = new ObjectWriter();
  if (info.version !== '') w.add('version', quote(info.version));
  if (info.form === FileInfoForm.NoSignature) w.add('noSignature', 'true');
  else if (info.signature !== '') w.add('signature', quote(info.signature));
  if (info.affectsGlobalScope) w.add('affectsGlobalScope', 'true');
  if (info.impliedNodeFormat !== 0) w.add('impliedNodeFormat', String(info.impliedNodeFormat));
  return w.done();
}

function optionValueJson(value: CompilerOptionValue): string {
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return stringArray(value);
}

function diagnosticJson(d: BuildInfoDiagnostic): string {
  const w = new ObjectWriter();
  if (d.file !== 0) w.add('file', String(d.file));
  if (d.noFile) w.add('noFile', 'true');
  if (d.pos !== 0) w.add('pos', String(d.pos));
  if (d.end !== 0) w.add('end', String(d.end));
  if (d.code !== 0) w.add('code', String(d.code));
  if (d.category !== 0) w.add('category', String(d.category));
  if (d.messageKey !== '') w.add('messageKey', quote(d.messageKey));
  if (d.messageArgs.length > 0) w.add('messageArgs', stringArray(d.messageArgs));
  if (d.messageChain.length > 0) w.add('messageChain', diagnosticsJson(d.messageChain));
  if (d.relatedInformation.length > 0) w.add('relatedInformation', diagnosticsJson(d.relatedInformation));
  if (d.reportsUnnecessary) w.add('reportsUnnecessary', 'true');
  if (d.reportsDeprecated) w.add('reportsDeprecated', 'true');
  if (d.skippedOnNoEmit) w.add('skippedOnNoEmit', 'true');
  const repopulate = d.repopulateInfo;
  if (repopulate !== undefined) {
    const r = new ObjectWriter();
    r.add('kind', String(repopulate.kind));
    if (repopulate.moduleReference !== '') r.add('moduleReference', quote(repopulate.moduleReference));
    if (repopulate.mode !== 0) r.add('mode', String(repopulate.mode));
    if (repopulate.packageName !== '') r.add('packageName', quote(repopulate.packageName));
    w.add('repopulateInfo', r.done());
  }
  return w.done();
}

function diagnosticsJson(diagnostics: readonly BuildInfoDiagnostic[]): string {
  let out = '[';
  for (let i = 0; i < diagnostics.length; i++) {
    if (i > 0) out += ',';
    out += diagnosticJson(diagnostics[i]);
  }
  return out + ']';
}

function diagnosticsOfFileJson(d: BuildInfoDiagnosticsOfFile): string {
  return `[${d.fileId},${diagnosticsJson(d.diagnostics)}]`;
}

function listJson<T>(items: readonly T[], item: (value: T) => string): string {
  let out = '[';
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out += ',';
    out += item(items[i]);
  }
  return out + ']';
}

function pendingEmitJson(p: BuildInfoFilePendingEmit): string {
  if (p.emitKind === 0) return String(p.fileId);
  if (p.emitKind === FileEmitKind.Dts) return `[${p.fileId}]`;
  return `[${p.fileId},${p.emitKind}]`;
}

function emitSignatureJson(s: BuildInfoEmitSignature): string {
  if (s.noEmitSignature()) return String(s.fileId);
  let signature: string;
  if (s.differsOnlyInDtsMap) signature = '[]';
  else if (s.differsInOptions) signature = `[${quote(s.signature)}]`;
  else signature = quote(s.signature);
  return `[${s.fileId},${signature}]`;
}

/**
 * Writes `"key":value` pairs separated by commas, as parts joined once: for the build info, whose lists of
 * file ids are most of its text.
 */
class PartsWriter {
  private readonly parts: string[] = ['{'];
  private first = true;

  /** Starts the pair of `key`, whose value follows (`push`). */
  key(key: string): void {
    if (!this.first) this.parts.push(',');
    this.first = false;
    this.parts.push(quote(key), ':');
  }

  push(text: string): void {
    this.parts.push(text);
  }

  add(key: string, value: string): void {
    this.key(key);
    this.parts.push(value);
  }

  done(): string {
    this.parts.push('}');
    return this.parts.join('');
  }
}

/** The JSON text of a build info, with fields in tsgo's order and zero values left out. */
export function buildInfoToJson(b: BuildInfo): string {
  const w = new PartsWriter();
  if (b.version !== '') w.add('version', quote(b.version));
  if (b.errors) w.add('errors', 'true');
  if (b.checkPending) w.add('checkPending', 'true');
  if (b.root.length > 0) w.add('root', listJson(b.root, rootJson));
  if (b.packageJsons.length > 0) w.add('packageJsons', stringArray(b.packageJsons));
  if (b.missingPackageJsons.length > 0) w.add('missingPackageJsons', stringArray(b.missingPackageJsons));
  if (b.fileNames.length > 0) w.add('fileNames', stringArray(b.fileNames));
  if (b.fileInfos.length > 0) w.add('fileInfos', listJson(b.fileInfos, fileInfoJson));
  if (b.fileIdsList.length > 0) {
    const text = b.fileIdsListText;
    const hasText = text.length === b.fileIdsList.length;
    w.key('fileIdsList');
    w.push('[');
    for (let i = 0; i < b.fileIdsList.length; i++) {
      if (i > 0) w.push(',');
      if (hasText) {
        w.push('[');
        w.push(text[i]);
        w.push(']');
      } else w.push(numberArray(b.fileIdsList[i]));
    }
    w.push(']');
  }
  const options = b.options;
  if (options !== undefined) {
    const o = new ObjectWriter();
    for (const option of options) o.add(option.name, optionValueJson(option.value));
    w.add('options', o.done());
  }
  if (b.referencedMap.length > 0) {
    w.add(
      'referencedMap',
      listJson(b.referencedMap, (r) => `[${r.fileId},${r.fileIdListId}]`),
    );
  }
  if (b.semanticDiagnosticsPerFile.length > 0) {
    w.add(
      'semanticDiagnosticsPerFile',
      listJson(b.semanticDiagnosticsPerFile, (d) =>
        d.diagnostics === undefined ? String(d.fileId) : diagnosticsOfFileJson(d.diagnostics),
      ),
    );
  }
  if (b.emitDiagnosticsPerFile.length > 0) {
    w.add('emitDiagnosticsPerFile', listJson(b.emitDiagnosticsPerFile, diagnosticsOfFileJson));
  }
  if (b.changeFileSet.length > 0) w.add('changeFileSet', numberArray(b.changeFileSet));
  if (b.affectedFilesPendingEmit.length > 0) {
    w.add('affectedFilesPendingEmit', listJson(b.affectedFilesPendingEmit, pendingEmitJson));
  }
  if (b.latestChangedDtsFile !== '') w.add('latestChangedDtsFile', quote(b.latestChangedDtsFile));
  if (b.emitSignatures.length > 0) w.add('emitSignatures', listJson(b.emitSignatures, emitSignatureJson));
  if (b.resolvedRoot.length > 0) {
    w.add(
      'resolvedRoot',
      listJson(b.resolvedRoot, (r) => `[${r.resolved},${r.root}]`),
    );
  }
  if (b.semanticErrors) w.add('semanticErrors', 'true');
  return w.done();
}

// ---- Reading

function invalid(): Error {
  return new Error('invalid build info');
}

function asObject(value: JsonValue): JsonObject {
  if (value.type !== 'object') throw invalid();
  return value;
}

function asArray(value: JsonValue): readonly JsonValue[] {
  if (value.type !== 'array') throw invalid();
  return value.items;
}

function asNumber(value: JsonValue): number {
  if (value.type !== 'number') throw invalid();
  return value.value;
}

function asString(value: JsonValue): string {
  if (value.type !== 'string') throw invalid();
  return value.value;
}

function asBoolean(value: JsonValue): boolean {
  if (value.type !== 'boolean') throw invalid();
  return value.value;
}

function stringsOf(value: JsonValue): string[] {
  return asArray(value).map(asString);
}

function numbersOf(value: JsonValue): number[] {
  return asArray(value).map(asNumber);
}

function readRoot(value: JsonValue): BuildInfoRoot {
  if (value.type === 'array') {
    const items = value.items;
    if (items.length !== 2) throw invalid();
    return new BuildInfoRoot(asNumber(items[0]), asNumber(items[1]), '');
  }
  if (value.type === 'number') return new BuildInfoRoot(value.value, 0, '');
  return new BuildInfoRoot(0, 0, asString(value));
}

function readFileInfo(value: JsonValue): BuildInfoFileInfo {
  if (value.type === 'string') return new BuildInfoFileInfo(FileInfoForm.Short, value.value, value.value, false, 1);
  const o = asObject(value);
  let fileVersion = '';
  let signature = '';
  let noSignature = false;
  let affectsGlobalScope = false;
  let impliedNodeFormat = 0;
  for (const [key, v] of o.entries) {
    if (key === 'version') fileVersion = asString(v);
    else if (key === 'signature') signature = asString(v);
    else if (key === 'noSignature') noSignature = asBoolean(v);
    else if (key === 'affectsGlobalScope') affectsGlobalScope = asBoolean(v);
    else if (key === 'impliedNodeFormat') impliedNodeFormat = asNumber(v);
  }
  return new BuildInfoFileInfo(
    noSignature ? FileInfoForm.NoSignature : FileInfoForm.Full,
    fileVersion,
    noSignature ? '' : signature,
    affectsGlobalScope,
    impliedNodeFormat,
  );
}

function readDiagnostic(value: JsonValue): BuildInfoDiagnostic {
  const o = asObject(value);
  const d = new BuildInfoDiagnostic();
  for (const [key, v] of o.entries) {
    switch (key) {
      case 'file':
        d.file = asNumber(v);
        break;
      case 'noFile':
        d.noFile = asBoolean(v);
        break;
      case 'pos':
        d.pos = asNumber(v);
        break;
      case 'end':
        d.end = asNumber(v);
        break;
      case 'code':
        d.code = asNumber(v);
        break;
      case 'category':
        d.category = asNumber(v);
        break;
      case 'messageKey':
        d.messageKey = asString(v);
        break;
      case 'messageArgs':
        d.messageArgs = stringsOf(v);
        break;
      case 'messageChain':
        d.messageChain = asArray(v).map(readDiagnostic);
        break;
      case 'relatedInformation':
        d.relatedInformation = asArray(v).map(readDiagnostic);
        break;
      case 'reportsUnnecessary':
        d.reportsUnnecessary = asBoolean(v);
        break;
      case 'reportsDeprecated':
        d.reportsDeprecated = asBoolean(v);
        break;
      case 'skippedOnNoEmit':
        d.skippedOnNoEmit = asBoolean(v);
        break;
      case 'repopulateInfo':
        d.repopulateInfo = readRepopulateInfo(v);
        break;
    }
  }
  return d;
}

function readRepopulateInfo(value: JsonValue): RepopulateInfo {
  let kind = 0;
  let moduleReference = '';
  let mode = 0;
  let packageName = '';
  for (const [key, v] of asObject(value).entries) {
    if (key === 'kind') kind = asNumber(v);
    else if (key === 'moduleReference') moduleReference = asString(v);
    else if (key === 'mode') mode = asNumber(v);
    else if (key === 'packageName') packageName = asString(v);
  }
  return new RepopulateInfo(kind, moduleReference, mode, packageName);
}

function readDiagnosticsOfFile(value: JsonValue): BuildInfoDiagnosticsOfFile {
  const items = asArray(value);
  if (items.length !== 2) throw invalid();
  return new BuildInfoDiagnosticsOfFile(asNumber(items[0]), asArray(items[1]).map(readDiagnostic));
}

function readPendingEmit(value: JsonValue): BuildInfoFilePendingEmit {
  if (value.type === 'number') return new BuildInfoFilePendingEmit(value.value, 0);
  const items = numbersOf(value);
  if (items.length === 1) return new BuildInfoFilePendingEmit(items[0], FileEmitKind.Dts);
  if (items.length === 2) return new BuildInfoFilePendingEmit(items[0], items[1]);
  throw invalid();
}

function readEmitSignature(value: JsonValue): BuildInfoEmitSignature {
  if (value.type === 'number') return new BuildInfoEmitSignature(value.value, '', false, false);
  const items = asArray(value);
  if (items.length !== 2) throw invalid();
  const fileId = asNumber(items[0]);
  const signature = items[1];
  if (signature.type === 'string') return new BuildInfoEmitSignature(fileId, signature.value, false, false);
  const list = stringsOf(signature);
  if (list.length === 0) return new BuildInfoEmitSignature(fileId, '', true, false);
  if (list.length === 1) return new BuildInfoEmitSignature(fileId, list[0], false, true);
  throw invalid();
}

function readOptionValue(value: JsonValue): CompilerOptionValue | undefined {
  switch (value.type) {
    case 'string':
      return value.value;
    case 'number':
      return value.value;
    case 'boolean':
      return value.value;
    case 'array':
      return value.items.map(asString);
    default:
      return undefined;
  }
}

/** Sets the field of `b` that `key` names to `v`; other keys are left out. */
function readBuildInfoField(b: BuildInfo, key: string, v: JsonValue): void {
  switch (key) {
    case 'version':
      b.version = asString(v);
      break;
    case 'errors':
      b.errors = asBoolean(v);
      break;
    case 'checkPending':
      b.checkPending = asBoolean(v);
      break;
    case 'root':
      b.root = asArray(v).map(readRoot);
      break;
    case 'packageJsons':
      b.packageJsons = stringsOf(v);
      break;
    case 'missingPackageJsons':
      b.missingPackageJsons = stringsOf(v);
      break;
    case 'fileNames':
      b.fileNames = stringsOf(v);
      break;
    case 'fileInfos':
      b.fileInfos = asArray(v).map(readFileInfo);
      break;
    case 'fileIdsList':
      b.fileIdsList = asArray(v).map(numbersOf);
      b.fileIdsListText = [];
      break;
    case 'options': {
      const options: BuildInfoOption[] = [];
      for (const [name, optionValue] of asObject(v).entries) {
        const value = readOptionValue(optionValue);
        if (value !== undefined) options.push(new BuildInfoOption(name, value));
      }
      b.options = options;
      break;
    }
    case 'referencedMap':
      b.referencedMap = asArray(v).map((entry) => {
        const items = numbersOf(entry);
        if (items.length !== 2) throw invalid();
        return new BuildInfoReference(items[0], items[1]);
      });
      break;
    case 'semanticDiagnosticsPerFile':
      b.semanticDiagnosticsPerFile = asArray(v).map((entry) =>
        entry.type === 'number'
          ? new BuildInfoSemanticDiagnostic(entry.value, undefined)
          : new BuildInfoSemanticDiagnostic(0, readDiagnosticsOfFile(entry)),
      );
      break;
    case 'emitDiagnosticsPerFile':
      b.emitDiagnosticsPerFile = asArray(v).map(readDiagnosticsOfFile);
      break;
    case 'changeFileSet':
      b.changeFileSet = numbersOf(v);
      break;
    case 'affectedFilesPendingEmit':
      b.affectedFilesPendingEmit = asArray(v).map(readPendingEmit);
      break;
    case 'latestChangedDtsFile':
      b.latestChangedDtsFile = asString(v);
      break;
    case 'emitSignatures':
      b.emitSignatures = asArray(v).map(readEmitSignature);
      break;
    case 'resolvedRoot':
      b.resolvedRoot = asArray(v).map((entry) => {
        const items = numbersOf(entry);
        if (items.length !== 2) throw invalid();
        return new BuildInfoResolvedRoot(items[0], items[1]);
      });
      break;
    case 'semanticErrors':
      b.semanticErrors = asBoolean(v);
      break;
  }
}

/** A bit for each key of a diagnostic in build info (`BuildInfoTextReader.diagnostic`). */
const diagnosticKeys = new Map<string, number>(
  [
    'file',
    'noFile',
    'pos',
    'end',
    'code',
    'category',
    'messageKey',
    'messageArgs',
    'messageChain',
    'relatedInformation',
    'reportsUnnecessary',
    'reportsDeprecated',
    'skippedOnNoEmit',
    'repopulateInfo',
  ].map((key, i) => [key, 1 << i]),
);

/**
 * Reads build info text: the fields that hold most of it (lists of file ids, file names, references and
 * diagnostics) straight into their arrays where they have the shape the writer writes, and the others,
 * or any of those that do not, through JSON values (`readBuildInfoField`). A repeated key takes its
 * last value, as in a JSON object.
 */
class BuildInfoTextReader {
  private readonly p: JsonParser;
  /** The JSON values of the fields read through them, by key. */
  private readonly values = new Map<string, JsonValue>();

  constructor(text: string) {
    this.p = new JsonParser(text);
  }

  read(): BuildInfo {
    const p = this.p;
    const b = new BuildInfo();
    p.skipWhitespace();
    if (p.peek() !== 0x7b) throw invalid();
    p.pos++;
    p.skipWhitespace();
    if (p.peek() === 0x7d) p.pos++;
    else
      for (;;) {
        const key = p.key();
        if (key === undefined) throw invalid();
        const start = p.pos;
        if (!this.readFast(b, key)) {
          p.pos = start;
          const value = p.value();
          if (value === undefined) throw invalid();
          this.values.set(key, value);
        }
        if (!p.endOfMember(0x7d)) throw invalid();
        if (p.peek() === 0x7d) {
          p.pos++;
          break;
        }
      }
    p.skipWhitespace();
    if (p.pos !== p.text.length) throw invalid();
    for (const [key, value] of this.values) readBuildInfoField(b, key, value);
    return b;
  }

  /** Reads the value of `key` into `b` if it is one of the fields read directly and has their shape. */
  private readFast(b: BuildInfo, key: string): boolean {
    switch (key) {
      case 'fileIdsList': {
        const texts: string[] = [];
        const lists = this.list(() => this.numbers(texts));
        if (lists === undefined) return false;
        b.fileIdsList = lists;
        b.fileIdsListText = texts.length === lists.length ? texts : [];
        break;
      }
      case 'fileNames':
      case 'packageJsons':
      case 'missingPackageJsons': {
        const strings = this.list(() => this.string());
        if (strings === undefined) return false;
        if (key === 'fileNames') b.fileNames = strings;
        else if (key === 'packageJsons') b.packageJsons = strings;
        else b.missingPackageJsons = strings;
        break;
      }
      case 'semanticDiagnosticsPerFile': {
        const diagnostics = this.list(() => {
          const p = this.p;
          p.skipWhitespace();
          if (p.peek() !== 0x5b) {
            const fileId = p.number();
            return fileId === undefined ? undefined : new BuildInfoSemanticDiagnostic(fileId, undefined);
          }
          const ofFile = this.diagnosticsOfFile();
          return ofFile === undefined ? undefined : new BuildInfoSemanticDiagnostic(0, ofFile);
        });
        if (diagnostics === undefined) return false;
        b.semanticDiagnosticsPerFile = diagnostics;
        break;
      }
      case 'emitDiagnosticsPerFile': {
        const diagnostics = this.list(() => this.diagnosticsOfFile());
        if (diagnostics === undefined) return false;
        b.emitDiagnosticsPerFile = diagnostics;
        break;
      }
      case 'referencedMap': {
        const references = this.list(() => {
          const items = this.numbers();
          return items === undefined || items.length !== 2 ? undefined : new BuildInfoReference(items[0], items[1]);
        });
        if (references === undefined) return false;
        b.referencedMap = references;
        break;
      }
      default:
        return false;
    }
    this.values.delete(key);
    return true;
  }

  /** The array at `pos`, with `item` reading each element; `undefined` if anything else is there. */
  private list<T>(item: () => T | undefined): T[] | undefined {
    const p = this.p;
    p.skipWhitespace();
    if (p.peek() !== 0x5b) return undefined;
    p.pos++;
    const result: T[] = [];
    p.skipWhitespace();
    if (p.peek() === 0x5d) {
      p.pos++;
      return result;
    }
    for (;;) {
      const value = item();
      if (value === undefined) return undefined;
      result.push(value);
      if (!p.endOfMember(0x5d)) return undefined;
      if (p.peek() === 0x5d) {
        p.pos++;
        return result;
      }
    }
  }

  /** `[fileId, [diagnostic, ...]]`. */
  private diagnosticsOfFile(): BuildInfoDiagnosticsOfFile | undefined {
    const p = this.p;
    p.skipWhitespace();
    if (p.peek() !== 0x5b) return undefined;
    p.pos++;
    p.skipWhitespace();
    const fileId = p.number();
    if (fileId === undefined || !p.endOfMember(0x5d)) return undefined;
    const diagnostics = this.list(() => this.diagnostic());
    p.skipWhitespace();
    if (diagnostics === undefined || p.peek() !== 0x5d) return undefined;
    p.pos++;
    return new BuildInfoDiagnosticsOfFile(fileId, diagnostics);
  }

  /** A diagnostic with the fields the writer writes, each once; `undefined` for anything else. */
  private diagnostic(): BuildInfoDiagnostic | undefined {
    const p = this.p;
    p.skipWhitespace();
    if (p.peek() !== 0x7b) return undefined;
    p.pos++;
    const d = new BuildInfoDiagnostic();
    p.skipWhitespace();
    if (p.peek() === 0x7d) {
      p.pos++;
      return d;
    }
    let seen = 0;
    for (;;) {
      const key = p.key();
      const bit = key === undefined ? undefined : diagnosticKeys.get(key);
      if (key === undefined || bit === undefined || (seen & bit) !== 0) return undefined;
      seen |= bit;
      switch (key) {
        case 'file':
        case 'pos':
        case 'end':
        case 'code':
        case 'category': {
          p.skipWhitespace();
          const n = p.number();
          if (n === undefined) return undefined;
          if (key === 'file') d.file = n;
          else if (key === 'pos') d.pos = n;
          else if (key === 'end') d.end = n;
          else if (key === 'code') d.code = n;
          else d.category = n;
          break;
        }
        case 'noFile':
        case 'reportsUnnecessary':
        case 'reportsDeprecated':
        case 'skippedOnNoEmit': {
          const value = this.boolean();
          if (value === undefined) return undefined;
          if (key === 'noFile') d.noFile = value;
          else if (key === 'reportsUnnecessary') d.reportsUnnecessary = value;
          else if (key === 'reportsDeprecated') d.reportsDeprecated = value;
          else d.skippedOnNoEmit = value;
          break;
        }
        case 'messageKey': {
          const value = this.string();
          if (value === undefined) return undefined;
          d.messageKey = value;
          break;
        }
        case 'messageArgs': {
          const value = this.list(() => this.string());
          if (value === undefined) return undefined;
          d.messageArgs = value;
          break;
        }
        case 'messageChain':
        case 'relatedInformation': {
          const value = this.list(() => this.diagnostic());
          if (value === undefined) return undefined;
          if (key === 'messageChain') d.messageChain = value;
          else d.relatedInformation = value;
          break;
        }
        case 'repopulateInfo': {
          const value = this.repopulateInfo();
          if (value === undefined) return undefined;
          d.repopulateInfo = value;
          break;
        }
        default:
          return undefined;
      }
      if (!p.endOfMember(0x7d)) return undefined;
      if (p.peek() === 0x7d) {
        p.pos++;
        return d;
      }
    }
  }

  /** `repopulateInfo` with the fields the writer writes, each once; `undefined` for anything else. */
  private repopulateInfo(): RepopulateInfo | undefined {
    const p = this.p;
    p.skipWhitespace();
    if (p.peek() !== 0x7b) return undefined;
    p.pos++;
    let kind = 0;
    let moduleReference = '';
    let mode = 0;
    let packageName = '';
    p.skipWhitespace();
    if (p.peek() === 0x7d) {
      p.pos++;
      return new RepopulateInfo(kind, moduleReference, mode, packageName);
    }
    const seen = new Set<string>();
    for (;;) {
      const key = p.key();
      if (key === undefined || seen.has(key)) return undefined;
      seen.add(key);
      if (key === 'kind' || key === 'mode') {
        p.skipWhitespace();
        const n = p.number();
        if (n === undefined) return undefined;
        if (key === 'kind') kind = n;
        else mode = n;
      } else if (key === 'moduleReference' || key === 'packageName') {
        const value = this.string();
        if (value === undefined) return undefined;
        if (key === 'moduleReference') moduleReference = value;
        else packageName = value;
      } else return undefined;
      if (!p.endOfMember(0x7d)) return undefined;
      if (p.peek() === 0x7d) {
        p.pos++;
        return new RepopulateInfo(kind, moduleReference, mode, packageName);
      }
    }
  }

  private boolean(): boolean | undefined {
    const p = this.p;
    p.skipWhitespace();
    if (p.eat('true')) return true;
    if (p.eat('false')) return false;
    return undefined;
  }

  /**
   * `[n, ...]` of integers as the writer writes them (digits, at most 15, without a leading zero);
   * `undefined` for anything else. With `texts`, adds the text between the brackets where it has no
   * whitespace: the numbers joined with commas.
   */
  private numbers(texts?: string[]): number[] | undefined {
    const p = this.p;
    const text = p.text;
    const length = text.length;
    let pos = skipJsonWhitespace(text, p.pos);
    if (pos >= length || text.charCodeAt(pos) !== 0x5b) return undefined;
    const open = pos;
    pos = skipJsonWhitespace(text, pos + 1);
    let compact = pos === open + 1;
    const result: number[] = [];
    if (pos < length && text.charCodeAt(pos) === 0x5d) {
      p.pos = pos + 1;
      if (texts !== undefined && compact) texts.push('');
      return result;
    }
    for (;;) {
      const start = pos;
      let value = 0;
      while (pos < length) {
        const digit = text.charCodeAt(pos) - 0x30;
        if (digit < 0 || digit > 9) break;
        value = value * 10 + digit;
        pos++;
      }
      const digits = pos - start;
      if (digits === 0 || digits > 15 || (digits > 1 && text.charCodeAt(start) === 0x30)) return undefined;
      let c = pos < length ? text.charCodeAt(pos) : -1;
      if (c === 0x2e || c === 0x65 || c === 0x45) return undefined;
      result.push(value);
      if (c !== 0x2c && c !== 0x5d) {
        compact = false;
        pos = skipJsonWhitespace(text, pos);
        c = pos < length ? text.charCodeAt(pos) : -1;
      }
      if (c === 0x5d) {
        p.pos = pos + 1;
        if (texts !== undefined && compact) texts.push(text.slice(open + 1, pos));
        return result;
      }
      if (c !== 0x2c) return undefined;
      const next = pos + 1;
      pos = skipJsonWhitespace(text, next);
      if (pos !== next) compact = false;
    }
  }

  private string(): string | undefined {
    const p = this.p;
    const text = p.text;
    const start = skipJsonWhitespace(text, p.pos);
    if (start >= text.length || text.charCodeAt(start) !== 0x22) return undefined;
    // A string without escapes is the text between its quotes.
    for (let end = start + 1; end < text.length; end++) {
      const c = text.charCodeAt(end);
      if (c === 0x22) {
        p.pos = end + 1;
        return text.slice(start + 1, end);
      }
      if (c === 0x5c || c < 0x20) break;
    }
    p.pos = start;
    return p.string();
  }
}

/** The position of the first character at or after `pos` that is not JSON whitespace. */
function skipJsonWhitespace(text: string, pos: number): number {
  while (pos < text.length) {
    const c = text.charCodeAt(pos);
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break;
    pos++;
  }
  return pos;
}

/** Parses build info text; `undefined` if it isn't valid. */
export function parseBuildInfo(text: string): BuildInfo | undefined {
  try {
    return new BuildInfoTextReader(text).read();
  } catch {
    return undefined;
  }
}
