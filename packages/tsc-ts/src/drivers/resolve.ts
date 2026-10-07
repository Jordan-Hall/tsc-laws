// Usage: resolve <cases.json> [--bench N]
// Resolves the requests of each case against an in-memory file system and prints the results as JSON,
// in the format of packages/tsgo/oracles/resolve-oracle.
import { readFileSync } from 'node:fs';
import { formatMessageWithArgs, type MessageWithArgs } from '../compiler/module-resolution-messages.js';
import {
  ModuleResolutionHost,
  Resolver,
  getAutomaticTypeDirectiveNames,
  resolveConfig,
  type ModuleResolutionOptions,
  type PackageId,
  type ResolvedProjectReference,
} from '../compiler/module-resolution.js';
import { parseJson, type JsonObject, type JsonValue } from '../compiler/package-json.js';
import {
  changeExtension,
  combinePaths,
  comparePaths,
  containsPath,
  getBaseFileName,
  getDeclarationFileExtension,
  getDirectoryPath,
  getEncodedRootLength,
  getNormalizedAbsolutePath,
  getPathComponents,
  isExternalModuleNameRelative,
  normalizePath,
  removeFileExtension,
  resolvePath,
  toFileNameLowerCase,
  toPath,
  tryGetExtensionFromPath,
} from '../compiler/path.js';

interface Entry {
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly text: string;
  /** Canonical key of the symlink target. */
  readonly target: string;
  /** Path as created, without the leading `/`. */
  readonly realpath: string;
}

interface Found {
  readonly entry: Entry;
  readonly key: string;
}

/** A map file system with the semantics of tsgo's vfstest: keys are paths without the leading `/`. */
class MemoryHost extends ModuleResolutionHost {
  private readonly entries = new Map<string, Entry>();
  private readonly links: string[] = [];
  private readonly linkTargets = new Map<string, string>();

  constructor(
    files: ReadonlyMap<string, string>,
    symlinks: ReadonlyMap<string, string>,
    private readonly caseSensitive: boolean,
    private readonly currentDirectory: string,
  ) {
    super();
    const input = new Map<string, Entry>();
    for (const [path, text] of files) input.set(path.slice(1), { kind: 'file', text, target: '', realpath: '' });
    for (const [path, target] of symlinks) {
      input.set(path.slice(1), { kind: 'symlink', text: '', target: this.canonical(target.slice(1)), realpath: '' });
    }
    const keys = [...input.keys()].sort(comparePathsByParts);
    for (const key of keys) {
      const entry = input.get(key);
      if (entry === undefined) continue;
      const slash = key.lastIndexOf('/');
      if (slash > 0) this.mkdirAll(key.slice(0, slash));
      this.setEntry(key, { kind: entry.kind, text: entry.text, target: entry.target, realpath: key });
    }
  }

  private canonical(key: string): string {
    return this.caseSensitive ? key : toFileNameLowerCase(key);
  }

  private setEntry(key: string, entry: Entry): void {
    const canonical = this.canonical(key);
    this.entries.set(canonical, entry);
    if (entry.kind === 'symlink') {
      if (!this.linkTargets.has(canonical)) this.links.push(canonical);
      this.linkTargets.set(canonical, entry.target);
    }
  }

  private follow(key: string): Found | undefined {
    for (let depth = 0; depth < 64; depth++) {
      const entry = this.entries.get(key);
      if (entry !== undefined && entry.kind !== 'symlink') return { entry, key };
      const target = this.linkTargets.get(key);
      if (target !== undefined) {
        key = target;
        continue;
      }
      let next: string | undefined;
      for (const link of this.links) {
        if (link.length < key.length && key.startsWith(link) && key.charCodeAt(link.length) === 0x2f) {
          next = (this.linkTargets.get(link) ?? '') + key.slice(link.length);
          break;
        }
      }
      if (next === undefined) return undefined;
      key = next;
    }
    return undefined;
  }

  private mkdirAll(path: string): void {
    const existing = this.follow(this.canonical(path));
    if (existing !== undefined) return;
    let toCreate: string[] = [];
    let offset = 0;
    for (;;) {
      const slash = path.indexOf('/', offset);
      const dir = slash < 0 ? path : path.slice(0, slash);
      const rest = slash < 0 ? '' : path.slice(slash + 1);
      const canonical = this.canonical(dir);
      const found = this.follow(canonical);
      if (found === undefined) {
        toCreate.push(dir);
      } else if (found.key !== canonical) {
        // A symlinked parent: continue from its real path.
        path = found.entry.realpath + '/' + rest;
        toCreate = [];
        offset = 0;
        continue;
      }
      if (rest === '') break;
      offset = dir.length + 1;
    }
    for (const dir of toCreate) this.setEntry(dir, { kind: 'directory', text: '', target: '', realpath: dir });
  }

  /** The key for an absolute path, or `undefined` for the root or a non-POSIX path. */
  private keyOf(path: string): string | undefined {
    const normalized = normalizePath(path);
    if (!normalized.startsWith('/')) return undefined;
    let key = normalized.slice(1);
    if (key.endsWith('/')) key = key.slice(0, -1);
    return key === '' ? undefined : this.canonical(key);
  }

  private lookup(path: string): Found | undefined {
    const key = this.keyOf(path);
    return key === undefined ? undefined : this.follow(key);
  }

  useCaseSensitiveFileNames(): boolean {
    return this.caseSensitive;
  }

  getCurrentDirectory(): string {
    return this.currentDirectory;
  }

  fileExists(path: string): boolean {
    return this.lookup(path)?.entry.kind === 'file';
  }

  directoryExists(path: string): boolean {
    if (normalizePath(path) === '/') return true;
    return this.lookup(path)?.entry.kind === 'directory';
  }

  readFile(path: string): string | undefined {
    const found = this.lookup(path);
    return found !== undefined && found.entry.kind === 'file' ? found.entry.text : undefined;
  }

  realpath(path: string): string {
    const found = this.lookup(path);
    return found === undefined ? path : '/' + found.entry.realpath;
  }

  getDirectories(path: string): readonly string[] {
    const normalized = normalizePath(path);
    let prefix = '';
    if (normalized !== '/') {
      const found = this.lookup(path);
      if (found === undefined || found.entry.kind !== 'directory') return [];
      prefix = found.key + '/';
    }
    const names: string[] = [];
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix) || key.indexOf('/', prefix.length) >= 0 || key.length === prefix.length) continue;
      const name = key.slice(prefix.length);
      if (entry.kind === 'directory') names.push(name);
      else if (entry.kind === 'symlink' && this.follow(key)?.entry.kind === 'directory') names.push(name);
    }
    return names.sort();
  }
}

function comparePathsByParts(a: string, b: string): number {
  for (;;) {
    const ai = a.indexOf('/');
    const bi = b.indexOf('/');
    if (ai < 0 || bi < 0) return a === b ? 0 : a < b ? -1 : 1;
    const as = a.slice(0, ai);
    const bs = b.slice(0, bi);
    if (as !== bs) return as < bs ? -1 : 1;
    a = a.slice(ai + 1);
    b = b.slice(bi + 1);
  }
}

//// JSON input

const EMPTY: JsonObject = { type: 'object', entries: new Map(), kind: 0 };

function object(value: JsonValue | undefined): JsonObject {
  return value !== undefined && value.type === 'object' ? value : EMPTY;
}

function str(o: JsonObject, key: string): string {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'string' ? v.value : '';
}

function num(o: JsonObject, key: string): number {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'number' ? v.value : 0;
}

function bool(o: JsonObject, key: string): boolean | undefined {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'boolean' ? v.value : undefined;
}

function strings(o: JsonObject, key: string): string[] | undefined {
  const v = o.entries.get(key);
  if (v === undefined || v.type !== 'array') return undefined;
  const result: string[] = [];
  for (const item of v.items) if (item.type === 'string') result.push(item.value);
  return result;
}

function stringMap(o: JsonObject, key: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [k, v] of object(o.entries.get(key)).entries) if (v.type === 'string') result.set(k, v.value);
  return result;
}

function readOptions(o: JsonObject): ModuleResolutionOptions {
  let paths: Map<string, string[]> | undefined;
  const pathsValue = o.entries.get('paths');
  if (pathsValue !== undefined && pathsValue.type === 'array') {
    paths = new Map();
    for (const item of pathsValue.items) {
      const mapping = object(item);
      paths.set(str(mapping, 'key'), strings(mapping, 'values') ?? []);
    }
  }
  return {
    moduleResolution: num(o, 'moduleResolution'),
    module: num(o, 'module'),
    target: num(o, 'target'),
    allowJs: bool(o, 'allowJs'),
    checkJs: bool(o, 'checkJs'),
    resolveJsonModule: bool(o, 'resolveJsonModule'),
    resolvePackageJsonExports: bool(o, 'resolvePackageJsonExports'),
    resolvePackageJsonImports: bool(o, 'resolvePackageJsonImports'),
    noDtsResolution: bool(o, 'noDtsResolution'),
    preserveSymlinks: bool(o, 'preserveSymlinks'),
    traceResolution: bool(o, 'traceResolution'),
    customConditions: strings(o, 'customConditions'),
    moduleSuffixes: strings(o, 'moduleSuffixes'),
    rootDirs: strings(o, 'rootDirs'),
    typeRoots: strings(o, 'typeRoots'),
    types: strings(o, 'types'),
    paths,
    pathsBasePath: str(o, 'pathsBasePath'),
    configFilePath: str(o, 'configFilePath'),
    outDir: str(o, 'outDir'),
    declarationDir: str(o, 'declarationDir'),
    rootDir: str(o, 'rootDir'),
  };
}

//// JSON output

function q(s: string): string {
  return JSON.stringify(s);
}

function list(items: readonly string[]): string {
  return '[' + items.map(q).join(',') + ']';
}

function packageIdJson(id: PackageId | undefined): string {
  if (id === undefined) return 'null';
  return (
    '{"name":' +
    q(id.name) +
    ',"subModuleName":' +
    q(id.subModuleName) +
    ',"version":' +
    q(id.version) +
    ',"peerDependencies":' +
    q(id.peerDependencies) +
    '}'
  );
}

function messages(items: readonly MessageWithArgs[], withCode: boolean): string[] {
  return items.map((m) => (withCode ? m.message.code + ' ' : '') + formatMessageWithArgs(m));
}

interface Output {
  resolvedFileName: string;
  originalPath: string;
  extension: string;
  resolvedUsingTsExtension: boolean;
  isExternalLibraryImport: boolean;
  packageId: PackageId | undefined;
  alternateResult: string;
  primary: boolean;
  diagnostics: string[];
  traces: string[];
  names: string[] | undefined;
}

function outputJson(o: Output): string {
  return (
    '{"resolvedFileName":' +
    q(o.resolvedFileName) +
    ',"originalPath":' +
    q(o.originalPath) +
    ',"extension":' +
    q(o.extension) +
    ',"resolvedUsingTsExtension":' +
    String(o.resolvedUsingTsExtension) +
    ',"isExternalLibraryImport":' +
    String(o.isExternalLibraryImport) +
    ',"packageId":' +
    packageIdJson(o.packageId) +
    ',"alternateResult":' +
    q(o.alternateResult) +
    ',"primary":' +
    String(o.primary) +
    ',"diagnostics":' +
    list(o.diagnostics) +
    ',"traces":' +
    list(o.traces) +
    (o.names === undefined ? '' : ',"names":' + list(o.names)) +
    '}'
  );
}

function emptyOutput(): Output {
  return {
    resolvedFileName: '',
    originalPath: '',
    extension: '',
    resolvedUsingTsExtension: false,
    isExternalLibraryImport: false,
    packageId: undefined,
    alternateResult: '',
    primary: false,
    diagnostics: [],
    traces: [],
    names: undefined,
  };
}

function runCase(c: JsonObject): string[] {
  const options = readOptions(object(c.entries.get('options')));
  const host = new MemoryHost(
    stringMap(c, 'files'),
    stringMap(c, 'symlinks'),
    bool(c, 'useCaseSensitiveFileNames') === true,
    str(c, 'currentDirectory'),
  );
  const resolver = new Resolver(host, options, str(c, 'typingsLocation'), str(c, 'projectName'));
  let redirect: ResolvedProjectReference | undefined;
  const redirectValue = c.entries.get('redirect');
  if (redirectValue !== undefined && redirectValue.type === 'object') {
    const redirectOptions = redirectValue.entries.get('options');
    redirect = {
      configName: str(redirectValue, 'configName'),
      options:
        redirectOptions !== undefined && redirectOptions.type === 'object' ? readOptions(redirectOptions) : undefined,
    };
  }
  const results: string[] = [];
  const requests = c.entries.get('requests');
  if (requests === undefined || requests.type !== 'array') return results;
  for (const item of requests.items) {
    const request = object(item);
    const name = str(request, 'name');
    const containingFile = str(request, 'containingFile');
    const mode = num(request, 'mode');
    const requestRedirect = bool(request, 'redirect') === true ? redirect : undefined;
    const traces: MessageWithArgs[] = [];
    const out = emptyOutput();
    switch (str(request, 'kind')) {
      case 'module': {
        const r = resolver.resolveModuleName(name, containingFile, mode, requestRedirect, traces);
        out.resolvedFileName = r.resolvedFileName;
        out.originalPath = r.originalPath;
        out.extension = r.extension;
        out.resolvedUsingTsExtension = r.resolvedUsingTsExtension;
        out.isExternalLibraryImport = r.isExternalLibraryImport;
        out.packageId = r.packageId;
        out.alternateResult = r.alternateResult;
        out.diagnostics = messages(r.resolutionDiagnostics, true);
        break;
      }
      case 'type': {
        const r = resolver.resolveTypeReferenceDirective(name, containingFile, mode, requestRedirect, traces);
        out.resolvedFileName = r.resolvedFileName;
        out.originalPath = r.originalPath;
        out.primary = r.primary;
        out.isExternalLibraryImport = r.isExternalLibraryImport;
        out.packageId = r.packageId;
        out.diagnostics = messages(r.resolutionDiagnostics, true);
        break;
      }
      case 'automaticTypes':
        out.names = getAutomaticTypeDirectiveNames(options, host);
        break;
      case 'path': {
        const a = name;
        const b = containingFile;
        out.names = [
          normalizePath(a),
          getNormalizedAbsolutePath(a, b),
          combinePaths(b, a),
          getDirectoryPath(a),
          getBaseFileName(a),
          getPathComponents(a, b).join('|'),
          toPath(a, b, false),
          String(comparePaths(a, b, false)),
          String(containsPath(b, a, true)),
          removeFileExtension(a),
          tryGetExtensionFromPath(a),
          getDeclarationFileExtension(a),
          changeExtension(a, '.js'),
          String(isExternalModuleNameRelative(a)),
          String(getEncodedRootLength(a)),
          resolvePath(b, a),
        ];
        break;
      }
      case 'config': {
        const r = resolveConfig(name, containingFile, host);
        out.resolvedFileName = r.resolvedFileName;
        out.extension = r.extension;
        out.isExternalLibraryImport = r.isExternalLibraryImport;
        out.packageId = r.packageId;
        break;
      }
    }
    out.traces = messages(traces, false);
    results.push(outputJson(out));
  }
  return results;
}

const input = parseJson(readFileSync(process.argv[2], 'utf8'));
const cases = input !== undefined && input.type === 'array' ? input.items : [];
const benchIndex = process.argv.indexOf('--bench');
if (benchIndex >= 0) {
  const runs = Number(process.argv[benchIndex + 1] ?? '10');
  const start = performance.now();
  let count = 0;
  for (let i = 0; i < runs; i++) for (const c of cases) count += runCase(object(c)).length;
  console.log(`${count} resolutions in ${(performance.now() - start).toFixed(1)}ms`);
} else {
  const out: string[] = [];
  for (const c of cases) out.push('[' + runCase(object(c)).join(',') + ']');
  process.stdout.write('[' + out.join(',\n') + ']\n');
}
