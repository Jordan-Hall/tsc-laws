// Finds the default library sets that tsgo checks without diagnostics under the options below, and writes them to
// src/compiler/verified-libraries.ts, where tsc-ts looks them up to skip checking library files that can't
// have errors (see src/compiler/library-diagnostics.ts).
//
// Usage: node scripts/verify-libraries.mjs [--jobs N] [--random N] [--tsgo BINARY]
//        node scripts/verify-libraries.mjs --shard i/n [--jobs N] > part-i.json
//        node scripts/verify-libraries.mjs --merge part-1.json ... part-n.json
//
// Each candidate library set is compiled as a program of one empty module with packages/tsgo/dist/tsgo, under
// every combination of the options that change how declarations relate (strictNullChecks, strictFunctionTypes,
// exactOptionalPropertyTypes, noUncheckedIndexedAccess, strictBuiltinIteratorReturn, noImplicitAny,
// strictBindCallApply, useDefineForClassFields, noImplicitOverride, noImplicitThis), with every other checker
// option set and unset on its own, every value of the enumerated options, and random combinations of all of them.
// Targets cycle through the runs of sets given by `lib`. A set is verified when no run reports anything.
// --shard runs every nth set and prints the results; --merge combines them.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const libs = join(repo, 'upstream/typescript-go/internal/bundled/libs');
const output = join(root, 'src/compiler/verified-libraries.ts');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const tsgo = resolve(option('--tsgo', join(repo, 'packages/tsgo/dist/tsgo')));
const jobs = Number(option('--jobs', 8));
const randomCount = Number(option('--random', 40));

const targets = ['es2015', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020'];
targets.push('es2021', 'es2022', 'es2023', 'es2024', 'es2025', 'esnext');
const versions = ['es5', ...targets];

/** Candidate sets: each target's default libraries, and `lib` lists of a version with DOM or worker libraries. */
function candidates() {
  const result = [];
  for (const target of targets) result.push({ name: `target ${target}`, options: { target } });
  for (const version of versions) {
    for (const extra of [
      [],
      ['dom'],
      ['dom', 'dom.iterable'],
      ['dom', 'dom.iterable', 'dom.asynciterable'],
      ['dom', 'dom.iterable', 'dom.asynciterable', 'scripthost'],
      ['webworker'],
      ['webworker', 'webworker.iterable', 'webworker.asynciterable'],
      ['webworker.importscripts', 'scripthost'],
    ]) {
      const lib = [version, ...extra];
      result.push({ name: `lib ${lib.join(',')}`, options: { lib } });
    }
  }
  return result;
}

const relational = [
  'strictNullChecks',
  'strictFunctionTypes',
  'exactOptionalPropertyTypes',
  'noUncheckedIndexedAccess',
  'strictBuiltinIteratorReturn',
  'noImplicitAny',
  'strictBindCallApply',
  'useDefineForClassFields',
  'noImplicitOverride',
  'noImplicitThis',
];
const others = [
  'strictPropertyInitialization',
  'useUnknownInCatchVariables',
  'noPropertyAccessFromIndexSignature',
  'noImplicitReturns',
  'noUnusedLocals',
  'noUnusedParameters',
  'noFallthroughCasesInSwitch',
  'allowUnreachableCode',
  'allowUnusedLabels',
  'experimentalDecorators',
  'emitDecoratorMetadata',
  'isolatedModules',
  'verbatimModuleSyntax',
  'erasableSyntaxOnly',
  'allowUmdGlobalAccess',
  'noUncheckedSideEffectImports',
  'preserveConstEnums',
  'declaration',
  'isolatedDeclarations',
  'noErrorTruncation',
  'allowJs',
  'checkJs',
  'resolveJsonModule',
  'allowImportingTsExtensions',
  'rewriteRelativeImportExtensions',
  'allowArbitraryExtensions',
  'libReplacement',
  'noEmit',
];
const enums = {
  module: ['commonjs', 'es2015', 'es2020', 'es2022', 'esnext', 'node16', 'node18', 'node20', 'nodenext', 'preserve'],
  moduleDetection: ['auto', 'legacy', 'force'],
  jsx: ['preserve', 'react', 'react-jsx', 'react-jsxdev', 'react-native'],
};

let seed = 1;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
}

/** Options for the runs of one set. */
function optionSets() {
  const sets = [];
  for (let bits = 0; bits < 1 << relational.length; bits++) {
    const set = { strict: false };
    relational.forEach((name, i) => (set[name] = (bits & (1 << i)) !== 0));
    if (set.exactOptionalPropertyTypes && !set.strictNullChecks) continue;
    sets.push(set);
  }
  for (const name of [...relational, ...others]) {
    for (const value of [true, false]) sets.push({ [name]: value }, { strict: true, [name]: value });
  }
  for (const [name, values] of Object.entries(enums)) for (const value of values) sets.push({ [name]: value });
  for (let i = 0; i < randomCount; i++) {
    const set = { strict: random() < 0.5 };
    for (const name of [...relational, ...others]) if (random() < 0.5) set[name] = random() < 0.5;
    for (const [name, values] of Object.entries(enums)) {
      if (random() < 0.5) set[name] = values[Math.floor(random() * values.length)];
    }
    sets.push(set);
  }
  return sets.map(valid);
}

/** `set` without combinations tsgo rejects, which would stop it before checking. */
function valid(set) {
  const result = { ...set };
  const enabled = (name) => result[name] ?? result.strict === true;
  if ((result.exactOptionalPropertyTypes || enabled('strictPropertyInitialization')) && !enabled('strictNullChecks'))
    result.strictNullChecks = true;
  if ((result.isolatedModules || result.verbatimModuleSyntax) && result.preserveConstEnums === false)
    delete result.preserveConstEnums;
  if (result.isolatedDeclarations) {
    result.declaration = true;
    delete result.allowJs;
    delete result.checkJs;
  }
  if (result.emitDecoratorMetadata) result.experimentalDecorators = true;
  if (result.checkJs) result.allowJs = true;
  if (result.allowImportingTsExtensions) result.noEmit = true;
  return result;
}

function compile(compilerOptions, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-libraries-'));
  writeFileSync(join(dir, 'a.ts'), 'export {};\n');
  const config = { compilerOptions: { types: [], noEmit: true, ...compilerOptions }, files: ['a.ts'] };
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
  return new Promise((done) => {
    const options = { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 };
    execFile(tsgo, ['-p', '.', '--pretty', 'false', '--singleThreaded', ...extraArgs], options, (error, stdout) => {
      rmSync(dir, { recursive: true, force: true });
      done({ stdout, status: error ? error.code : 0 });
    });
  });
}

const libraryName = (line) => /^bundled:\/\/\/libs\/(lib\.[\w.]*d\.ts)$/.exec(line.trim())?.[1];

async function verifyAll(list) {
  const results = [];
  const tasks = [];
  for (const candidate of list) {
    const listed = await compile(candidate.options, ['--listFilesOnly']);
    const libraries = listed.stdout
      .split('\n')
      .map(libraryName)
      .filter((name) => name !== undefined)
      .sort();
    if (libraries.length === 0) throw new Error(`${candidate.name}: no library files listed\n${listed.stdout}`);
    const result = { name: candidate.name, libraries, runs: 0, failures: [] };
    results.push(result);
    for (const [i, set] of optionSets().entries()) {
      const options = { ...set, ...candidate.options };
      if (options.lib !== undefined && options.target === undefined) options.target = targets[i % targets.length];
      tasks.push({ result, options });
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < tasks.length) {
        const { result, options } = tasks[next++];
        if (result.failures.length >= 5) continue;
        const { stdout, status } = await compile(options);
        result.runs++;
        if (stdout !== '' || status !== 0) result.failures.push({ options, output: stdout.split('\n').slice(0, 5) });
      }
    }),
  );
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** The text hash of every bundled library, as tsc-ts computes file versions. */
async function libraryTexts() {
  const { hash128String, toHex } = await import('../src/compiler/xxh3.ts');
  const texts = new Map();
  for (const name of readdirSync(libs).sort()) {
    if (name.startsWith('lib.') && name.endsWith('.d.ts'))
      texts.set(name, toHex(hash128String(readFileSync(join(libs, name), 'utf8'))));
  }
  return texts;
}

/** A set of libraries as a mask over `names`, in hex digits of four names each. */
function mask(libraries, names) {
  const digits = Array.from({ length: Math.ceil(names.length / 4) }, () => 0);
  for (const library of libraries) {
    const index = names.indexOf(library);
    if (index < 0) throw new Error(`unknown library ${library}`);
    digits[index >> 2] |= 1 << (index & 3);
  }
  return digits.map((d) => d.toString(16)).join('');
}

async function write(results) {
  const texts = await libraryTexts();
  const names = [...texts.keys()].sort();
  const verified = new Set();
  for (const result of results) {
    if (result.failures.length === 0) verified.add(mask(result.libraries, names));
    else {
      console.error(`${result.name}: not verified`);
      for (const failure of result.failures)
        console.error(`  ${JSON.stringify(failure.options)}\n    ${failure.output.join('\n    ')}`);
    }
  }
  const lines = [
    '// Generated by scripts/verify-libraries.mjs from tsgo 7.0.2; do not edit.',
    '',
    '/** The bundled library files in order, with the hash of their text, as in build info file versions. */',
    'export const verifiedLibraries: readonly (readonly [string, string])[] = [',
    ...names.map((name) => `  ['${name}', '${texts.get(name)}'],`),
    '];',
    '',
    '/** Library sets with no diagnostics under any options, as hex masks over `verifiedLibraries`, four files a digit. */',
    'export const verifiedLibrarySets: ReadonlySet<string> = new Set([',
    ...[...verified].sort().map((m) => `  '${m}',`),
    ']);',
    '',
  ];
  writeFileSync(output, lines.join('\n'));
  const runs = results.reduce((n, r) => n + r.runs, 0);
  const passed = results.filter((result) => result.failures.length === 0).length;
  console.error(`${passed} of ${results.length} candidates (${verified.size} library sets) verified in ${runs} runs`);
}

if (args.includes('--merge')) {
  const files = args.slice(args.indexOf('--merge') + 1);
  await write(files.flatMap((file) => JSON.parse(readFileSync(file, 'utf8'))));
} else {
  let list = candidates();
  const shard = /^(\d+)\/(\d+)$/.exec(option('--shard', ''));
  if (shard !== null) {
    list = list.filter((_, i) => i % Number(shard[2]) === Number(shard[1]) - 1);
    process.stdout.write(JSON.stringify(await verifyAll(list)) + '\n');
  } else await write(await verifyAll(list));
}
