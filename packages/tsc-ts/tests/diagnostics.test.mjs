import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from './temp.mjs';

// Compares messages, translations, locale matching, formatting and diagnostic output with tsgo's
// (packages/tsgo/dist/diag-oracle, built by `npm run build:oracle`).
const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const oracle = join(repo, 'packages/tsgo/dist/diag-oracle');
const skip = existsSync(oracle) ? false : 'diag-oracle is not built';

let compiled;
function compile() {
  if (compiled !== undefined) return compiled;
  const out = tempDir('tsc-ts-diag-');
  execFileSync(
    join(repo, 'node_modules/.bin/tsc'),
    [
      '--outDir',
      out,
      '--rootDir',
      join(root, 'src'),
      '--target',
      'es2024',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--strict',
      '--skipLibCheck',
      '--types',
      'node',
      join(root, 'src/drivers/diagnostics.ts'),
    ],
    { stdio: 'inherit' },
  );
  compiled = out;
  return out;
}

function run(request, name) {
  const out = compile();
  const file = join(out, name + '.json');
  writeFileSync(file, JSON.stringify(request));
  const options = { maxBuffer: 1 << 30, encoding: 'utf8' };
  const expected = JSON.parse(execFileSync(oracle, [file], options));
  const actual = JSON.parse(execFileSync(process.execPath, [join(out, 'drivers/diagnostics.js'), file], options));
  // DIAG_NATIVE names a scriptc build of src/drivers/diagnostics.ts, which must print the same.
  if (process.env.DIAG_NATIVE) {
    const native = JSON.parse(execFileSync(process.env.DIAG_NATIVE, [file], options));
    assert.deepEqual(native, actual, `${name}: native`);
  }
  return { expected, actual };
}

async function localeTags() {
  const { localeTags } = await import(pathToFileURL(join(compile(), 'compiler/diagnostic-locales.js')).href);
  return localeTags;
}

/** Reports the first few differing entries of two equal-length arrays. */
function compareLists(name, expected, actual) {
  assert.equal(actual.length, expected.length, `${name}: length`);
  const bad = [];
  for (let i = 0; i < expected.length; i++) {
    if (JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) bad.push(i);
  }
  for (const i of bad.slice(0, Number(process.env.DIAG_SHOW ?? 5))) {
    console.log(`${name}[${i}]\n  expected ${JSON.stringify(expected[i])}\n  actual   ${JSON.stringify(actual[i])}`);
  }
  assert.equal(bad.length, 0, `${name}: ${bad.length} of ${expected.length} differ`);
}

test('messages and translations match tsgo in every locale', { skip }, async () => {
  const tags = ['en', ...(await localeTags()).slice(1)];
  const { expected, actual } = run({ locales: tags, matches: [], formats: [], renders: [] }, 'messages');
  compareLists(
    'messages',
    expected.messages.map((m) => ({ code: m.code, category: m.category, key: m.key, text: m.text, flags: m.flags })),
    actual.messages,
  );
  // Enum members carry tsgo's names.
  const source = readFileSync(join(root, 'src/compiler/diagnostic-messages.ts'), 'utf8');
  const names = [...source.matchAll(/^ {2}(\w+) = \d+,$/gm)].map((m) => m[1]);
  compareLists(
    'names',
    expected.messages.map((m) => m.name),
    names,
  );
  for (const tag of tags) compareLists(tag, expected.localized[tag], actual.localized[tag]);
  console.log(`${expected.messages.length} messages, ${tags.length} locales`);
});

test('formatting with arguments matches tsgo', { skip }, async () => {
  const tags = await localeTags();
  const { expected: table } = run({ locales: ['en'], matches: [], formats: [], renders: [] }, 'table');
  const formats = [];
  for (const m of table.messages) {
    const count = Math.max(0, ...[...m.text.matchAll(/\{(\d+)\}/g)].map((p) => Number(p[1]) + 1));
    const args = Array.from({ length: count }, (_, i) => `<${String.fromCharCode(0x41 + i)}${i}{${i}}>`);
    for (const locale of tags) formats.push({ locale, key: m.key, args });
    if (count > 0) {
      formats.push({ locale: 'en', key: m.key, args: [] });
      formats.push({ locale: 'de', key: m.key, args: args.slice(0, count - 1) });
      formats.push({ locale: 'ja', key: m.key, args: [...args, 'extra'] });
    }
  }
  formats.push({ locale: 'en', key: '_0_expected_1005', args: ['😀 {0} $& $1'] });
  const { expected, actual } = run({ locales: [], matches: [], formats, renders: [] }, 'formats');
  compareLists('formats', expected.formats, actual.formats);
  console.log(`${formats.length} formatted messages`);
});

/** Language, script and region subtags to combine, from the locale tables. */
function localeCorpus() {
  const source = readFileSync(join(root, 'src/compiler/locale-data.ts'), 'utf8');
  const block = (name) =>
    source
      .slice(source.indexOf(`const ${name} = `))
      .split('`')[1]
      .trim()
      .split(/\s+/);
  const list = (name) => {
    const start = source.indexOf(`const ${name} =`);
    const text = source.slice(start, source.indexOf(';', start));
    return [...text.matchAll(/'([^']*)'/g)]
      .map((m) => m[1])
      .join('')
      .split(' ');
  };
  const languages = block('likelyScripts').map((entry) => entry.split('=')[0]);
  const aliases = block('languageAliases').map((entry) => entry.split('=')[0]);
  // Zmth (mathematical notation) is left out: x/text's answers for it do not follow its data.
  const scripts = list('scripts')
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .filter((s) => s !== 'Zmth');
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const codes = [];
  for (const a of letters) for (const b of letters) codes.push(a + b);
  for (const a of letters) for (const b of letters) for (const c of letters) codes.push(a + b + c);
  const regions = codes.slice(0, 26 * 26).map((r) => r.toUpperCase());
  for (let i = 0; i < 1000; i += 7) regions.push(String(i).padStart(3, '0'));
  regions.push('001', '005', '013', '030', '034', '142', '150', '156', '158', '419', '999');

  const tags = [...codes];
  for (const language of ['und', ...languages, ...aliases]) {
    for (const script of ['', ...scripts]) tags.push(script === '' ? language : `${language}-${script}`);
    for (const script of ['', 'Latn', 'Cyrl', 'Hans', 'Hant', 'Arab', 'Armn', 'Xyzw']) {
      for (const region of regions)
        tags.push(script === '' ? `${language}-${region}` : `${language}-${script}-${region}`);
    }
  }
  for (const script of scripts) for (const region of regions) tags.push(`und-${script}-${region}`);
  for (const code of codes.slice(0, 26 * 26)) tags.push(`${code}-DE`, `${code}-Hant`, `${code}-TW`);
  // Odd and malformed values, and tags that only parse as tsgo does with its special cases.
  const odd = `
    - de- -de de--de de_DE DE-de zh_tw ZH-HANT pt-br en-US C POSIX C.UTF-8 de_DE.UTF-8 fr_FR@euro
    ja_JP.eucJP über de-ü toolong de-toolongsubtag x-de i-klingon i-lux I_LUX zh-guoyu zh-hakka zh-xiang
    zh-min zh-min-nan root en-GB-oed art-lojban no-bok sgn-CH-DE zh-cmn zh-cmn-Hant zh-yue-HK zh-xyz-TW
    de-a de-a-bb de-x de-x-a de-1901 de-DE-1901 de-u-co-phonebk de-Latn-DE-x-private arm arm-AM arm-Xyzw
    baq-ES baq-Xyzw ger-Xyzw chi-TW-Xyzw de-AAA qq-DE 12-DE
  `;
  tags.push('', ' ', ...odd.trim().split(/\s+/));
  return tags;
}

test('locale matching matches tsgo', { skip }, async () => {
  const tags = await localeTags();
  const matches = localeCorpus();
  const { expected, actual } = run({ locales: tags, matches, formats: [], renders: [] }, 'matches');
  // Identifier_expected tells the locales apart.
  const probes = tags.map((tag) => expected.localized[tag][1]);
  assert.equal(new Set(probes).size, tags.length);
  compareLists(
    'matches',
    expected.matches.map((text, i) => `${matches[i]}: ${tags[probes.indexOf(text)]}`),
    actual.matches.map((text, i) => `${matches[i]}: ${tags[probes.indexOf(text)]}`),
  );
  const translated = expected.matches.filter((text) => text !== probes[0]).length;
  console.log(`${matches.length} locale tags, ${translated} translated`);
});

function diag(file, pos, end, key, args = [], chain = [], related = []) {
  return { file, pos, end, key, args, chain, related };
}

const sources = [
  { name: '/project/src/a.ts', text: 'let x: number = "one";\nfunction f() {\n\treturn  \t\n}\n' },
  { name: '/project/src/b.ts', text: 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n' },
  {
    name: '/project/lib/c.ts',
    text: 'line1 line2 line3\rline4\nline5\nline6\nline7  　\nline8 😀 x\nline9\nline10\nline11',
  },
  { name: '/project/d.ts', text: 'export {};' },
  { name: '/Project/Src/E.ts', text: '' },
  { name: '/other/root/f.ts', text: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n' },
];

const scenarios = [
  // One error in one file, with a chain.
  [
    diag(
      0,
      4,
      5,
      'Type_0_is_not_assignable_to_type_1_2322',
      ['string', 'number'],
      [
        diag(
          -1,
          0,
          0,
          'Type_0_is_not_assignable_to_type_1_2322',
          ['"one"', 'number'],
          [diag(-1, 0, 0, 'Property_0_is_missing_in_type_1_but_required_in_type_2_2741', ['p', 'A', 'B'])],
        ),
        diag(-1, 0, 0, 'The_types_of_0_are_incompatible_between_these_types_2200', ['x']),
      ],
    ),
  ],
  // A single global error.
  [diag(-1, -1, -1, 'Cannot_find_global_type_0_2318', ['Array'])],
  // Errors, warnings, suggestions and messages over several files, with related information.
  [
    diag(
      0,
      16,
      21,
      'Type_0_is_not_assignable_to_type_1_2322',
      ['string', 'number'],
      [],
      [
        diag(0, 4, 5, 'The_expected_type_comes_from_property_0_which_is_declared_here_on_type_1_6500', ['x', 'T']),
        diag(-1, -1, -1, 'Did_you_mean_0_1369', ['y']),
        diag(1, 15, 20, '_0_is_declared_here_2728', ['b']),
      ],
    ),
    diag(1, 0, 40, 'Unreachable_code_detected_7027'),
    diag(1, 14, 14, 'Identifier_expected_1003'),
    diag(2, 0, sources[2].text.length, 'Unused_label_7028'),
    diag(2, 6, 18, '_0_is_declared_but_its_value_is_never_read_6133', ['line2']),
    diag(2, 70, 75, 'Cannot_find_name_0_2304', ['x']),
    diag(3, 0, 6, 'An_export_assignment_cannot_be_used_in_a_module_with_other_exported_elements_2309'),
    diag(4, 0, 0, 'File_appears_to_be_binary_1490'),
    diag(5, 2, 20, 'Cannot_find_name_0_2304', ['b']),
    diag(5, 4, 4, 'Cannot_find_name_0_2304', ['c']),
    diag(-1, -1, -1, 'Found_1_error_Watching_for_file_changes_6193'),
    diag(-1, -1, -1, 'Cannot_find_global_type_0_2318', ['Promise']),
  ],
  // Many errors in one file.
  Array.from({ length: 12 }, (_, i) => diag(5, i * 2, i * 2 + 1, 'Cannot_find_name_0_2304', [String(i)])),
  // Over nine errors in several files, for the table's padding.
  [
    ...Array.from({ length: 11 }, (_, i) => diag(0, i, i + 1, 'Identifier_expected_1003')),
    diag(1, 0, 1, 'Identifier_expected_1003'),
  ],
  // No errors.
  [
    diag(0, 0, 3, 'Unreachable_code_detected_7027'),
    diag(-1, -1, -1, 'Found_0_errors_Watching_for_file_changes_6194', ['0']),
  ],
];

test('diagnostic output matches tsgo', { skip }, async () => {
  const tags = await localeTags();
  const renders = [];
  for (const locale of tags) {
    for (const diagnostics of scenarios) {
      for (const [currentDirectory, useCaseSensitiveFileNames] of [
        ['/project', true],
        ['/project/src', false],
        ['/PROJECT/src', false],
        ['', true],
      ]) {
        for (const newLine of ['\n', '\r\n']) {
          renders.push({ locale, currentDirectory, useCaseSensitiveFileNames, newLine, files: sources, diagnostics });
        }
      }
    }
  }
  const { expected, actual } = run({ locales: [], matches: [], formats: [], renders }, 'renders');
  for (const field of ['plain', 'pretty', 'summary', 'flattened', 'status']) {
    compareLists(
      field,
      expected.renders.map((r) => r[field]),
      actual.renders.map((r) => r[field]),
    );
  }
  console.log(`${renders.length} renders`);
});
