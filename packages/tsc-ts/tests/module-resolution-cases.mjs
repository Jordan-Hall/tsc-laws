// Resolution cases for module-resolution.test.mjs: tsgo's unit-test fixtures, path utility inputs, and
// requests extracted from TypeScript's multi-file test cases.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ESNEXT = 99;
const COMMONJS = 1;
const NONE = 0;

const MODULE_RESOLUTION = { classic: 1, node: 2, node10: 2, node16: 3, nodenext: 99, bundler: 100 };
const MODULE = {
  none: 0,
  commonjs: 1,
  amd: 2,
  umd: 3,
  system: 4,
  es6: 5,
  es2015: 5,
  es2020: 6,
  es2022: 7,
  esnext: 99,
  node16: 100,
  node18: 101,
  node20: 102,
  nodenext: 199,
  preserve: 200,
};
const TARGET = {
  es3: 1,
  es5: 1,
  es6: 2,
  es2015: 2,
  es2016: 3,
  es2017: 4,
  es2018: 5,
  es2019: 6,
  es2020: 7,
  es2021: 8,
  es2022: 9,
  es2023: 10,
  es2024: 11,
  es2025: 12,
  esnext: 99,
};
const BOOLEAN_OPTIONS = {
  allowjs: 'allowJs',
  checkjs: 'checkJs',
  resolvejsonmodule: 'resolveJsonModule',
  resolvepackagejsonexports: 'resolvePackageJsonExports',
  resolvepackagejsonimports: 'resolvePackageJsonImports',
  nodtsresolution: 'noDtsResolution',
  preservesymlinks: 'preserveSymlinks',
};
const LIST_OPTIONS = {
  customconditions: 'customConditions',
  modulesuffixes: 'moduleSuffixes',
  rootdirs: 'rootDirs',
  typeroots: 'typeRoots',
  types: 'types',
};
const PATH_LIST_OPTIONS = new Set(['rootDirs', 'typeRoots']);
const DIRECTORY_OPTIONS = { outdir: 'outDir', declarationdir: 'declarationDir', rootdir: 'rootDir' };

/** Cases from tsgo's internal/module tests (run sequentially here). */
export function unitCases() {
  const bundler = { moduleResolution: 100, module: 99, target: 99, traceResolution: true };
  const base = { useCaseSensitiveFileNames: true, currentDirectory: '/repo', options: bundler, symlinks: {} };
  const request = (name, containingFile, mode = ESNEXT) => ({ kind: 'module', name, containingFile, mode });
  return [
    {
      ...base,
      files: {
        '/repo/node_modules/pkg/package.json': '{"name":"pkg","main":"main.js","types":"main.d.ts"}',
        '/repo/node_modules/pkg/main.d.ts': 'export const x: number;',
        '/repo/node_modules/pkg/main.js': 'exports.x = 1;',
        '/repo/src/file.ts': '',
      },
      requests: [request('pkg', '/repo/src/file.ts'), request('pkg/', '/repo/src/file.ts')],
    },
    {
      ...base,
      files: {
        '/repo/node_modules/pkg/package.json': '{"name":"pkg","types":"./typings/index.d.ts"}',
        '/repo/node_modules/pkg/typings/index.d.ts': 'export const x: number;',
        '/repo/src/a/file.ts': '',
        '/repo/src/b/file.ts': '',
      },
      requests: [request('pkg', '/repo/src/a/file.ts'), request('pkg/', '/repo/src/b/file.ts')],
    },
    {
      ...base,
      files: {
        '/repo/node_modules/pkg/package.json': '{"name":"pkg","version":"1.0.0"}',
        '/repo/node_modules/pkg/sub/index.d.ts': 'export declare const sub: number;',
        '/repo/node_modules/pkg/sub/index.js': 'exports.sub = 1;',
        '/repo/src/a/file.ts': '',
        '/repo/src/b/file.ts': '',
      },
      requests: [request('pkg/sub', '/repo/src/a/file.ts'), request('pkg/sub', '/repo/src/b/file.ts')],
    },
    {
      ...base,
      files: {
        '/repo/node_modules/pkg/package.json':
          '{"name":"pkg","version":"1.0.0","types":"index.d.ts","peerDependencies":{"peer":"*","missing":"1"}}',
        '/repo/node_modules/pkg/index.d.ts': 'export declare const x: number;',
        '/repo/node_modules/peer/package.json': '{"name":"peer","version":"2.0.0"}',
        '/repo/src/a/file.ts': '',
        '/repo/src/b/file.ts': '',
      },
      requests: [request('pkg', '/repo/src/a/file.ts'), request('pkg', '/repo/src/b/file.ts')],
    },
    // package.json edge cases: invalid JSON, wrong field types, duplicate keys, typesVersions.
    {
      ...base,
      files: {
        '/repo/node_modules/bad/package.json': '{"name":"bad", "types": "x.d.ts",}',
        '/repo/node_modules/bad/index.d.ts': '',
        '/repo/node_modules/typed/package.json':
          '{"name":"typed","version":3,"types":7,"typings":null,"main":"lib/main","main":"lib/main2"}',
        '/repo/node_modules/typed/lib/main2.d.ts': '',
        '/repo/node_modules/tv/package.json':
          '{"name":"tv","version":"1.0.0","typesVersions":{">=9":{"*":["ts9/*"]},"bad range!":{},">=4.1":{"*":["ts4/*"],"sub":["ts4/other.d.ts"]}}}',
        '/repo/node_modules/tv/ts4/index.d.ts': '',
        '/repo/node_modules/tv/ts4/a.d.ts': '',
        '/repo/node_modules/tv/ts4/other.d.ts': '',
        '/repo/node_modules/tv2/package.json': '{"typesVersions":{"*":"nope"}}',
        '/repo/node_modules/tv2/index.d.ts': '',
        '/repo/node_modules/tv3/package.json': '{"typesVersions":{">=9":{"*":["x/*"]}}}',
        '/repo/node_modules/tv3/a.d.ts': '',
        '/repo/node_modules/vt/package.json':
          '{"name":"vt","version":"1.0.0","exports":{".":{"types@<5":"./old.d.ts","types@>=7.0":"./new.d.ts","default":"./index.js"}}}',
        '/repo/node_modules/vt/new.d.ts': '',
        '/repo/node_modules/vt/index.js': '',
        '/repo/src/file.ts': '',
      },
      requests: [
        request('bad', '/repo/src/file.ts'),
        request('typed', '/repo/src/file.ts', COMMONJS),
        request('tv', '/repo/src/file.ts', COMMONJS),
        request('tv/a', '/repo/src/file.ts', COMMONJS),
        request('tv/sub', '/repo/src/file.ts', COMMONJS),
        request('tv2', '/repo/src/file.ts', COMMONJS),
        request('tv3/a', '/repo/src/file.ts', COMMONJS),
        request('vt', '/repo/src/file.ts'),
        { kind: 'type', name: 'tv', containingFile: '/repo/src/file.ts', mode: NONE },
        { kind: 'config', name: 'tv', containingFile: '/repo/tsconfig.json', mode: NONE },
        { kind: 'automaticTypes', name: '', containingFile: '', mode: NONE },
      ],
    },
    // exports/imports targets, rootDirs, moduleSuffixes, outDir input mapping, symlinked packages.
    {
      ...base,
      options: {
        moduleResolution: 99,
        module: 199,
        traceResolution: true,
        outDir: '/repo/dist',
        rootDirs: ['/repo/src', '/repo/gen', '/repo/src/deep'],
        moduleSuffixes: ['.ios', ''],
        customConditions: ['custom'],
      },
      files: {
        '/repo/package.json': JSON.stringify({
          name: 'self',
          version: '1.0.0',
          type: 'module',
          exports: { '.': './dist/index.js', './feature/*.js': './dist/feature/*.js' },
          imports: { '#dep': 'dep', '#local/*': './src/local/*.ts', '#null': null, '#bad': '../x.js' },
        }),
        '/repo/src/index.ts': '',
        '/repo/src/feature/a.ts': '',
        '/repo/src/local/l.ts': '',
        '/repo/src/view.ios.ts': '',
        '/repo/gen/types.ts': '',
        '/repo/node_modules/dep/package.json': JSON.stringify({
          name: 'dep',
          version: '2.0.0',
          exports: {
            '.': [{ custom: './custom.d.ts' }, './index.js'],
            './sub/*': { import: './esm/*.mjs', require: null },
            './bad': './node_modules/x.js',
            './dir/': './dir/',
            './x/*.d': './types/*.d.ts',
          },
        }),
        '/repo/node_modules/dep/custom.d.ts': '',
        '/repo/node_modules/dep/esm/thing.mjs': '',
        '/repo/node_modules/dep/dir/file.js': '',
        '/repo/node_modules/dep/types/y.d.ts': '',
        '/repo/node_modules/jsonly/package.json': JSON.stringify({
          name: 'jsonly',
          version: '1.0.0',
          exports: { import: './index.mjs' },
          types: 'index.d.ts',
        }),
        '/repo/node_modules/jsonly/index.mjs': '',
        '/repo/node_modules/jsonly/index.d.ts': '',
        '/store/linked@1/package.json': '{"name":"linked","version":"1.0.0"}',
        '/store/linked@1/index.d.ts': '',
        '/other/file.ts': '',
      },
      symlinks: { '/repo/node_modules/linked': '/store/linked@1' },
      requests: [
        request('self', '/repo/src/index.ts'),
        request('self/feature/a.js', '/repo/src/index.ts'),
        request('#dep', '/repo/src/index.ts'),
        request('#local/l', '/repo/src/index.ts'),
        request('#null', '/repo/src/index.ts'),
        request('#bad', '/repo/src/index.ts'),
        request('#/x', '/repo/src/index.ts'),
        request('#', '/repo/src/index.ts'),
        request('#nope', '/other/file.ts'),
        request('dep/sub/thing', '/repo/src/index.ts'),
        request('dep/sub/thing', '/repo/src/index.ts', COMMONJS),
        request('dep/bad', '/repo/src/index.ts'),
        request('dep/dir/file.js', '/repo/src/index.ts'),
        request('dep/x/y.d', '/repo/src/index.ts'),
        request('jsonly', '/repo/src/index.ts'),
        request('linked', '/repo/src/index.ts', COMMONJS),
        request('./view.js', '/repo/src/index.ts'),
        request('./view', '/repo/src/index.ts', COMMONJS),
        request('./types.js', '/repo/src/index.ts'),
        request('./missing.js', '/repo/src/deep/x.ts'),
        request('./missing.js', '/elsewhere/x.ts'),
        request('http://x/y', '/repo/src/index.ts'),
        { kind: 'type', name: 'linked', containingFile: '/repo/src/index.ts', mode: ESNEXT },
        { kind: 'type', name: './gen/types', containingFile: '/repo/x.ts', mode: COMMONJS },
      ],
    },
    {
      ...base,
      options: { moduleResolution: 100, traceResolution: true, outDir: '/out', allowJs: true, preserveSymlinks: true },
      files: {
        '/p/package.json': JSON.stringify({ name: 'p', exports: './out/index.js', imports: '#x' }),
        '/p/src/index.ts': '',
        '/q/package.json': JSON.stringify({ name: 'q', imports: { '#a': './out/a.js' } }),
        '/q/a.ts': '',
        '/store/s/index.d.ts': '',
      },
      symlinks: { '/p/node_modules/s': '/store/s' },
      requests: [
        request('p', '/p/src/index.ts'),
        request('#x', '/p/src/index.ts'),
        request('#a', '/q/a.ts'),
        request('s', '/p/src/index.ts'),
      ],
    },
    // Project reference redirects and the typings location.
    {
      ...base,
      options: { ...bundler, types: ['*', 'extra'] },
      typingsLocation: '/cache',
      projectName: 'proj',
      redirect: { configName: '/repo/other/tsconfig.json', options: { moduleResolution: 3, traceResolution: true } },
      files: {
        '/cache/node_modules/@types/lodash/index.d.ts': '',
        '/repo/node_modules/@types/node/index.d.ts': '',
        '/repo/node_modules/@types/skip/package.json': '{"typings":null}',
        '/repo/node_modules/lodash/index.js': '',
        '/repo/src/file.ts': '',
      },
      requests: [
        request('lodash', '/repo/src/file.ts'),
        { ...request('lodash', '/repo/src/file.ts'), redirect: true },
        { kind: 'automaticTypes', name: '', containingFile: '', mode: NONE },
        { kind: 'type', name: 'node', containingFile: '/repo/__inferred type names__.ts', mode: NONE },
      ],
    },
  ];
}

const PATH_FRAGMENTS = [
  '',
  '.',
  '..',
  './',
  '../',
  '/',
  '//',
  'a',
  'a/',
  'a/b',
  'a//b',
  'a/./b',
  'a/../b',
  'a/b/..',
  '../a',
  '../../a',
  './a/./b/',
  '/a/b/../../..',
  '/a/./b/../c/',
  'c:',
  'c:/',
  'C:/a/../b',
  'c:\\a\\b',
  'file:///c:/a',
  'file://server/a/b',
  'http://x.com/a/../b',
  '^/untitled/a',
  '\\\\server\\share\\a',
  '//server/share',
  'a/b.d.ts',
  'a/b.d.json.ts',
  'x.D.TS',
  'a.mjs',
  'a/b.c/',
  'node_modules/@types/a',
  '/A/B/C.ts',
  '/a/İ/Straße.ts',
  'a/b.tsx',
  '...',
  'a/.../b',
];

/** Inputs for the path utilities (`path` requests: name `a`, containing file `b`). */
export function pathCases(extra = []) {
  const requests = [];
  const bases = ['', '/', '/a/b', '/.src', 'c:/x', 'file:///x/', 'a/b', '/a/B/'];
  for (const a of [...PATH_FRAGMENTS, ...extra]) {
    for (const b of bases) requests.push({ kind: 'path', name: a, containingFile: b, mode: 0 });
  }
  for (const a of PATH_FRAGMENTS) {
    for (const b of PATH_FRAGMENTS) requests.push({ kind: 'path', name: a + '/' + b, containingFile: b, mode: 0 });
  }
  return [{ files: {}, symlinks: {}, useCaseSensitiveFileNames: true, currentDirectory: '/', options: {}, requests }];
}

//// TypeScript test cases

const RELEVANT =
  /@(moduleResolution|traceResolution|paths|rootDirs|typeRoots|customConditions|link|symlink|moduleSuffixes|resolvePackageJson\w+|noDtsResolution|preserveSymlinks|types)\s*:|node_modules|package\.json|tsconfig\.json/i;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const optionRegex = /^\/{2}\s*@(\w+)\s*:\s*([^\r\n]*)/;
const linkRegex = /^\/{2}\s*@link\s*:\s*([^\r\n]*)\s*->\s*([^\r\n]*)/;

/** Splits a test into files, symlinks and global options, like tsgo's test case parser. */
export function parseTestCase(code, fileName) {
  const files = [];
  const symlinks = {};
  const options = {};
  let name = '';
  let content = [];
  for (const line of code.split(/\r?\n/)) {
    const link = linkRegex.exec(line);
    if (link) {
      symlinks[link[2].trim()] = link[1].trim();
      continue;
    }
    const option = optionRegex.exec(line);
    if (option) {
      const key = option[1].toLowerCase();
      const value = option[2].trim();
      if (key !== 'filename') {
        if (key === 'symlink' && name !== '') {
          for (const l of value.split(',')) if (l.trim() !== '') symlinks[l.trim()] = name;
        } else {
          options[key] = value;
        }
        continue;
      }
      if (name !== '') files.push({ name, content: content.join('\n') });
      name = value;
      content = [];
      continue;
    }
    if (content.length !== 0 || line !== '' || name === '') content.push(line);
  }
  if (name === '') name = fileName.slice(fileName.lastIndexOf('/') + 1);
  files.push({ name, content: content.join('\n') });
  return { files, symlinks, options };
}

/** Maps DOS paths (`c:/x`) to POSIX ones (`/c/x`), since the in-memory file systems are POSIX-only. */
function posix(p) {
  return /^[a-zA-Z]:([\\/]|$)/.test(p) ? '/' + p[0] + '/' + p.slice(3) : p;
}

function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Converts raw options (lowercased keys, string or JSON values) into the oracle's option shape. */
function convertOptions(raw, baseDirectory, path, fromConfig) {
  const options = {};
  const variants = [];
  for (const [key, rawValue] of Object.entries(raw)) {
    const value = typeof rawValue === 'string' ? rawValue.replace(/;$/, '').trim() : rawValue;
    const lower = typeof value === 'string' ? value.toLowerCase() : value;
    if (key === 'moduleresolution' || key === 'module' || key === 'target') {
      const table = key === 'moduleresolution' ? MODULE_RESOLUTION : key === 'module' ? MODULE : TARGET;
      const field = key === 'moduleresolution' ? 'moduleResolution' : key;
      const values = String(lower)
        .split(',')
        .map((v) => table[v.trim()])
        .filter((v) => v !== undefined);
      if (values.length > 0) {
        options[field] = values[0];
        if (values.length > 1) variants.push({ field, values: [...new Set(values)] });
      }
    } else if (key in BOOLEAN_OPTIONS) {
      options[BOOLEAN_OPTIONS[key]] = lower === true || lower === 'true';
    } else if (key in LIST_OPTIONS) {
      const field = LIST_OPTIONS[key];
      let list = Array.isArray(value)
        ? value.map(String)
        : String(value)
            .split(',')
            .map((v) => v.trim());
      if (!Array.isArray(value) && field !== 'moduleSuffixes') list = list.filter((v) => v !== '');
      if (PATH_LIST_OPTIONS.has(field)) list = list.map((v) => path.getNormalizedAbsolutePath(posix(v), baseDirectory));
      options[field] = list;
    } else if (key in DIRECTORY_OPTIONS) {
      options[DIRECTORY_OPTIONS[key]] = path.getNormalizedAbsolutePath(posix(String(value)), baseDirectory);
    } else if (key === 'paths') {
      let paths = value;
      if (typeof paths === 'string') {
        try {
          paths = JSON.parse(paths);
        } catch {
          continue;
        }
      }
      if (paths && typeof paths === 'object') {
        options.paths = Object.entries(paths).map(([k, v]) => ({
          key: k,
          values: Array.isArray(v) ? v.map(String) : [],
        }));
        if (fromConfig) options.pathsBasePath = baseDirectory;
      }
    }
  }
  return { options, variants };
}

function impliedFormat(fileName, files, kind) {
  if (/\.(d\.)?m[tj]s$/.test(fileName)) return ESNEXT;
  if (/\.(d\.)?c[tj]s$/.test(fileName)) return COMMONJS;
  if (kind !== 3 && kind !== 99) return NONE;
  for (let dir = fileName.slice(0, fileName.lastIndexOf('/')); ; dir = dir.slice(0, dir.lastIndexOf('/'))) {
    const pkg = files[(dir === '' ? '' : dir) + '/package.json'];
    if (pkg !== undefined) {
      try {
        return JSON.parse(pkg).type === 'module' ? ESNEXT : COMMONJS;
      } catch {
        return COMMONJS;
      }
    }
    if (dir === '') return COMMONJS;
  }
}

const SPECIFIERS = [
  { regex: /\bfrom\s*(['"])([^'"\r\n]+)\1/g, usage: 'static' },
  { regex: /\bimport\s*(['"])([^'"\r\n]+)\1/g, usage: 'static' },
  { regex: /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1/g, usage: 'dynamic' },
  { regex: /\brequire\s*\(\s*(['"])([^'"\r\n]+)\1/g, usage: 'require' },
];
const REFERENCE_TYPES = /^\s*\/\/\/\s*<reference\s+types\s*=\s*(['"])([^'"]+)\1([^>]*)>/gm;

function requestsForFile(fileName, text, files, kind) {
  const format = impliedFormat(fileName, files, kind);
  const requests = [];
  for (const { regex, usage } of SPECIFIERS) {
    for (const m of text.matchAll(regex)) {
      let mode = format;
      if (usage === 'require') mode = COMMONJS;
      else if (usage === 'dynamic') mode = ESNEXT;
      else if (kind === 100 && format === NONE) mode = ESNEXT;
      requests.push({ kind: 'module', name: m[2], containingFile: fileName, mode });
    }
  }
  for (const m of text.matchAll(REFERENCE_TYPES)) {
    const attr = /resolution-mode\s*=\s*['"](import|require)['"]/.exec(m[3]);
    const mode = attr ? (attr[1] === 'import' ? ESNEXT : COMMONJS) : format;
    requests.push({ kind: 'type', name: m[2], containingFile: fileName, mode });
  }
  return requests;
}

/**
 * Cases from TypeScript's compiler and conformance tests that exercise resolution. `path` is the compiled
 * path module and `types` the compiled module-resolution-types module.
 */
export function extractedCases(testsRoot, path, types) {
  const cases = [];
  const testFiles = [...walk(join(testsRoot, 'compiler'), []), ...walk(join(testsRoot, 'conformance'), [])].sort();
  for (const testFile of testFiles) {
    const code = readFileSync(testFile, 'utf8');
    if (!RELEVANT.test(code) && !(/@filename/i.test(code) && /\b(from|require|import)\b/.test(code))) continue;
    let parsed;
    try {
      parsed = parseTestCase(code, testFile);
    } catch {
      continue;
    }
    const cwd = parsed.options.currentdirectory
      ? path.getNormalizedAbsolutePath(posix(parsed.options.currentdirectory), '/.src')
      : '/.src';
    const caseSensitive = parsed.options.usecasesensitivefilenames !== 'false';
    const files = {};
    let configFile;
    for (const file of parsed.files) {
      const name = path.getNormalizedAbsolutePath(posix(file.name), cwd);
      files[name] = file.content;
      const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
      if (configFile === undefined && (base === 'tsconfig.json' || base === 'jsconfig.json')) configFile = name;
    }
    const symlinks = {};
    for (const [link, target] of Object.entries(parsed.symlinks)) {
      symlinks[path.getNormalizedAbsolutePath(posix(link), cwd)] = path.getNormalizedAbsolutePath(posix(target), cwd);
    }
    const allPaths = [...Object.keys(files), ...Object.keys(symlinks), ...Object.values(symlinks)];
    if (allPaths.some((p) => !p.startsWith('/') || p === '/')) continue;
    const canonical = new Set(
      allPaths.slice(0, Object.keys(files).length + Object.keys(symlinks).length).map((p) => p.toLowerCase()),
    );
    if (!caseSensitive && canonical.size !== Object.keys(files).length + Object.keys(symlinks).length) continue;

    const raw = { ...parsed.options };
    const header = convertOptions(raw, cwd, path, false);
    let options = header.options;
    let variants = header.variants;
    if (configFile !== undefined) {
      try {
        const json = JSON.parse(stripJsonComments(files[configFile]));
        const configDir = configFile.slice(0, configFile.lastIndexOf('/')) || '/';
        const lowered = {};
        for (const [k, v] of Object.entries(json.compilerOptions ?? {})) lowered[k.toLowerCase()] = v;
        if (configFile.toLowerCase().endsWith('jsconfig.json') && lowered.allowjs === undefined) lowered.allowjs = true;
        const fromConfig = convertOptions(lowered, configDir, path, true);
        options = { ...options, ...fromConfig.options, configFilePath: configFile };
        variants = [...variants.filter((v) => !(v.field in fromConfig.options)), ...fromConfig.variants];
      } catch {
        options = { ...options, configFilePath: configFile };
      }
    }
    options.traceResolution = true;

    // One case per module/moduleResolution combination (at most four).
    let combos = [options];
    for (const variant of variants) {
      combos = combos.flatMap((o) => variant.values.map((v) => ({ ...o, [variant.field]: v })));
    }
    combos = combos.slice(0, 4);

    for (const combo of combos) {
      const kind = types.getModuleResolutionKind(combo);
      const requests = [];
      const seen = new Set();
      for (const [fileName, text] of Object.entries(files)) {
        if (!/\.(d\.)?[cm]?[tj]sx?$/.test(fileName)) continue;
        for (const request of requestsForFile(fileName, text, files, kind)) {
          const key = request.kind + '\0' + request.name + '\0' + request.containingFile + '\0' + request.mode;
          if (seen.has(key)) continue;
          seen.add(key);
          requests.push(request);
        }
      }
      const inferred =
        (configFile ? configFile.slice(0, configFile.lastIndexOf('/')) : cwd) + '/__inferred type names__.ts';
      requests.push({ kind: 'automaticTypes', name: '', containingFile: '', mode: NONE });
      for (const type of combo.types ?? []) {
        if (type !== '*') requests.push({ kind: 'type', name: type, containingFile: inferred, mode: NONE });
      }
      if (requests.length <= 1) continue;
      cases.push({
        test: testFile.slice(testsRoot.length + 1),
        files,
        symlinks,
        useCaseSensitiveFileNames: caseSensitive,
        currentDirectory: cwd,
        options: combo,
        requests,
      });
    }
  }
  return cases;
}
