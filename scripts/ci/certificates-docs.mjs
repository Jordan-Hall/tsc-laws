// Turns what `tslaws check --certify` and `tslaws accept` leave in the certificates demo into the certificate gallery,
// docs/certificates/: one page with every law's source, status, lock hashes, invariants, a proof excerpt and the Carcara
// command, beside the full problems and proofs. The `certificates` workflow runs both commands with the real tools.
//
//   generate --report <check --json output> [--demo DIR] [--out DIR]   write the gallery
//   check --fresh <a generated gallery> [--docs DIR] [--recheck]       fail when the committed gallery is stale
//
// `generate` reads the demo's tsc-laws.lock (what `accept` wrote) and falls back to .tslaws/certificates.json (what `check`
// wrote, and what `accept` copies after checking it). The report is the `check --json` run made before `accept`.
//
// Beside the page are the two shields.io endpoint badges the README shows (badge-laws.json and badge-certificates.json),
// written by the same code as `tslaws badge` from the index. They are small and deterministic, so `check` compares them
// exactly, with what the committed index and a fresh run give.
//
// Proofs can differ between runs in details that do not change what they prove (and the invariant Z3 finds for a loop can
// too, which changes that law's problem, proof and hashes), so `check` does not compare them byte for byte. It compares what
// the code determines: the laws and their source, whether each one is certified, the law's lock hash and the hash that
// binds the certificate to the code (the problem, or the Horn clauses for a loop). It also checks that the committed files
// hash as the index says, that the page is what the index renders to, and, with --recheck, that Carcara accepts every
// committed proof against its committed problem, with the command the page shows.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..', '..');
const slash = (path) => path.split(sep).join('/');

const tool = await import(pathToFileURL(join(root, 'packages/tslaws/dist/certificates.js')).href).catch(
  () => undefined,
);
if (tool === undefined) fail('tslaws is not built yet: run `npm run build -w tslaws` first');
const badge = await import(pathToFileURL(join(root, 'packages/tslaws/dist/badge.js')).href).catch(() => undefined);
if (badge === undefined) fail('tslaws is not built yet: run `npm run build -w tslaws` first');
const { badgeTexts, badgesOf } = badge;
const { carcaraArgs, certificateName, cvc5ProofArgs, hashOf, rareDeclarations, rareRulesOf } = tool;

function fail(message) {
  console.error(`certificates-docs: ${message}`);
  process.exit(1);
}

function options(argv) {
  const found = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) found._.push(argv[i]);
    else if (argv[i] === '--recheck') found.recheck = true;
    else found[argv[i].slice(2)] = argv[++i];
  }
  return found;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// What the page shows of the code: a law's statement, and the functions it calls, cut out of the source by balancing brackets.
function blockAt(text, startLine, open, close) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let depth = 0;
  let started = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    out.push(lines[i]);
    const code = lines[i].replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/.*$/g, '""');
    for (const ch of code) {
      if (ch === open) {
        depth++;
        started = true;
      } else if (ch === close) depth--;
    }
    // A declaration with no body, such as `const small = (n: int) => n > 0;`, ends at its semicolon.
    if (started ? depth <= 0 : code.trimEnd().endsWith(';')) break;
  }
  return out.join('\n');
}

const sourceOf = (demo, file) => readFileSync(join(demo, file), 'utf8');

/** One entry per law the demo checked, from the report, the lock records and the saved problems and proofs. */
function entriesOf({ demo, report, records, saved }) {
  const entries = {};
  const results = [...report.results].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const result of results) {
    const outcome = result.proposal ?? result;
    const key = `${result.file}::${result.name}`;
    if (!['proved', 'bounded', 'tested'].includes(outcome.status))
      fail(
        `${key} is ${outcome.status}${outcome.message === undefined ? '' : ` (${outcome.message})`}: the demo must pass`,
      );
    const certificate = outcome.certificate ?? result.certificate;
    if (certificate?.status === 'unavailable') fail(`${key}: ${certificate.reason}`);
    const record = records[key];
    const certified = certificate?.status === 'certified';
    if (certified !== (record !== undefined))
      fail(`${key} is ${certified ? 'certified but has no lock record' : 'not certified but has a lock record'}`);
    const entry = {
      file: result.file,
      line: result.line,
      name: result.name,
      outcome: outcome.status,
      certificate:
        certificate === undefined
          ? 'none'
          : certificate.reason === undefined
            ? certificate.status
            : `${certificate.status} (${certificate.reason})`,
      ...(outcome.status === 'tested' && outcome.message !== undefined ? { note: outcome.message } : {}),
      source: blockAt(sourceOf(demo, result.file), result.line, '(', ')'),
      calls: Object.fromEntries(
        (result.exercises ?? []).map((fn) => [
          fn.name,
          blockAt(sourceOf(demo, fn.declaration.file), fn.declaration.line, '{', '}'),
        ]),
      ),
    };
    if (certified) {
      const name = certificateName(key);
      for (const ext of ['smt2', 'alethe', ...(record.systemHash === undefined ? [] : ['horn', 'inv'])]) {
        if (!saved.has(`${name}.${ext}`)) fail(`${key}: ${name}.${ext} is missing from the saved certificates`);
      }
      entry.files = name;
      entry.record = {
        law: record.law,
        problemHash: record.problemHash,
        ...(record.systemHash === undefined ? {} : { systemHash: record.systemHash }),
        proofHash: record.proofHash,
        checkerHash: record.checkerHash,
      };
    }
    entries[key] = entry;
  }
  return entries;
}

const extensionsOf = (entry) => [
  'smt2',
  'alethe',
  ...(entry.record.systemHash === undefined ? [] : ['horn', 'inv']),
  ...(entry.rare ? ['rare'] : []),
];

const size = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`);

function excerpt(proof) {
  const lines = proof.split(/\r?\n/).filter((line) => line !== '');
  const cut = (line) => (line.length > 150 ? `${line.slice(0, 150)} ...` : line);
  if (lines.length <= 12) return lines.map(cut).join('\n');
  const hidden = lines.length - 11;
  return [...lines.slice(0, 8), `; ... ${hidden} more lines ...`, ...lines.slice(-3)].map(cut).join('\n');
}

const carcaraCommand = (entry) =>
  [
    'carcara check',
    `${entry.files}.alethe`,
    `${entry.files}.smt2`,
    ...carcaraArgs,
    ...(entry.rare ? [`--rare-file ${entry.files}.rare`] : []),
  ].join(' ');

/** The page, a pure function of the index and of the saved files it links (`read` gives a file's text by its name). */
function render(index, read) {
  const entries = Object.entries(index.laws);
  const certified = entries.filter(([, entry]) => entry.files !== undefined);
  const kind = (entry) =>
    entry.files === undefined ? 'not proved' : entry.record.systemHash === undefined ? 'straight-line' : 'loop';
  const rows = entries.map(([, entry]) => [
    entry.name,
    entry.files === undefined ? 'not certified' : 'certified',
    kind(entry),
    entry.files === undefined ? '-' : size(Buffer.byteLength(read(`${entry.files}.alethe`))),
  ]);
  const header = ['Law', 'Status', 'Kind', 'Proof size'];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const line = (cells) => `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;
  const demo = index.demo;
  const out = [
    '# Certificate gallery',
    '',
    `Real certificates for the laws of the [certificates demo](../../${demo}), the project the \`certificates\` workflow checks with the real tools. For a law that certifies, cvc5 wrote an [Alethe](https://verit.loria.fr/documentation/alethe-spec.pdf) proof of its SMT-LIB problem and [Carcara](https://github.com/ufmg-smite/carcara) accepted it. Beside this page are the full problems and proofs, so you can check them yourself. [Proof certificates](../certificates.md) says what a certificate does and does not guarantee.`,
    '',
    `${certified.length} of ${entries.length} laws are certified. This page and the files beside it are generated by \`node scripts/ci/certificates-docs.mjs generate\` from a run of the workflow; do not edit them by hand. The workflow fails when they no longer match a fresh run (see [How this page is kept current](#how-this-page-is-kept-current)).`,
    '',
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
    '',
    '## Check a proof yourself',
    '',
    'cvc5 wrote each proof from its `.smt2` problem with',
    '',
    '```sh',
    `cvc5 ${cvc5ProofArgs.join(' ')} --tlimit <proof timeout> problem.smt2`,
    '```',
    '',
    'and Carcara checks it with the command under each law below. Run it from this directory. Carcara prints `valid` when it accepts the proof.',
    'A `.rare` file holds the rewrite rules the proof cites, which `tslaws` asks the cvc5 binary for.',
    '',
    '## Laws',
  ];
  for (const [key, entry] of entries) {
    out.push('', `### ${entry.name}`, '');
    const link = `[${entry.file}:${entry.line}](../../${posix.join(demo, entry.file)}#L${entry.line})`;
    if (entry.files === undefined) {
      const status =
        entry.certificate === 'none'
          ? '**not certified**: the law is only property-tested, so there is no proof to certify'
          : `**${entry.certificate}**`;
      out.push(
        `${link}. Status: ${status}.`,
        '',
        ...(entry.note === undefined ? [] : [`The prover said: ${entry.note}.`, '']),
        'Source:',
        '',
        '```ts',
        entry.source,
        '```',
      );
      out.push(...callsOf(entry));
      continue;
    }
    const files = (ext) => `[\`${entry.files}.${ext}\`](${entry.files}.${ext})`;
    const bytes = (ext) => size(Buffer.byteLength(read(`${entry.files}.${ext}`)));
    const loop = entry.record.systemHash !== undefined;
    out.push(
      `${link}. Status: **certified**${loop ? ', a law about a loop, certified through the loop invariants' : ''}.`,
      '',
      'Source:',
      '',
      '```ts',
      entry.source,
      '```',
      ...callsOf(entry),
      '',
      'The lock records this certificate (`tsc-laws.lock`, `certificates`):',
      '',
      '```json',
      JSON.stringify({ [key]: entry.record }, null, 2),
      '```',
    );
    if (loop)
      out.push(
        '',
        'Z3 found this invariant for the loop. The certificate does not trust it: cvc5 proved, and Carcara checked, that it holds on entry, survives every pass and implies the law.',
        '',
        '```smt2',
        read(`${entry.files}.inv`).replaceAll('\r', '').trim(),
        '```',
      );
    out.push(
      '',
      'Start and end of the Alethe proof:',
      '',
      '```text',
      excerpt(read(`${entry.files}.alethe`)),
      '```',
      '',
      `Full files: ${files('smt2')} (${bytes('smt2')}), ${files('alethe')} (${bytes('alethe')})${
        loop ? `, ${files('horn')} (${bytes('horn')}, the loop clauses) and ${files('inv')} (${bytes('inv')})` : ''
      }${entry.rare ? `, ${files('rare')} (${bytes('rare')})` : ''}.`,
      '',
      'Check it:',
      '',
      '```sh',
      carcaraCommand(entry),
      '```',
    );
  }
  out.push(
    '',
    '## How this page is kept current',
    '',
    "The `certificates` workflow runs the demo with cvc5 and Carcara, generates this gallery again and fails if the committed one is stale. It compares what the code determines: the laws and their source, whether each is certified, each law's lock hash, and the hash that binds its certificate to the code (the problem, or the Horn clauses for a loop). It does not compare the proofs byte for byte, because proofs and the invariants Z3 finds can differ from run to run without changing what they prove, and the page would drift on every run. Instead the workflow checks that the files here hash as `index.json` says, that this page is what `index.json` renders to, and that Carcara accepts every proof here against its problem with the commands above.",
    '',
    'To refresh it after a change, take the `certificate-docs` artifact of the workflow run and copy it over this directory.',
    '',
  );
  return out.join('\n');

  function callsOf(entry) {
    const calls = Object.entries(entry.calls);
    if (calls.length === 0) return [];
    return [
      '',
      `The law calls ${calls.map(([name]) => `\`${name}\``).join(' and ')}:`,
      '',
      '```ts',
      calls.map(([, source]) => source).join('\n\n'),
      '```',
    ];
  }
}

/** The texts of the two badge files for an index: the laws proved, and the laws a checker certified. */
const badgesOfIndex = (index) =>
  badgeTexts(
    badgesOf(
      Object.values(index.laws).map((entry) => ({
        proved: entry.outcome === 'proved',
        certified: entry.files !== undefined,
      })),
    ),
  );

const filesOf = (dir) => new Set(existsSync(dir) ? readdirSync(dir) : []);

async function generate({ report, demo = 'scripts/ci/certificates-demo', out = 'docs/certificates' }) {
  if (report === undefined) fail('generate needs --report <the output of `tslaws check --json`>');
  const demoDir = resolve(root, demo);
  const outDir = resolve(root, out);
  const savedDir = join(demoDir, '.tslaws', 'certificates');
  const lockPath = join(demoDir, 'tsc-laws.lock');
  const sidecar = join(demoDir, '.tslaws', 'certificates.json');
  const records = existsSync(lockPath)
    ? (readJson(lockPath).certificates ?? {})
    : existsSync(sidecar)
      ? readJson(sidecar)
      : {};
  const entries = entriesOf({
    demo: demoDir,
    report: readJson(resolve(report)),
    records,
    saved: filesOf(savedDir),
  });
  mkdirSync(outDir, { recursive: true });
  const keep = new Set(['README.md', 'index.json']);
  const badges = badgesOfIndex({ laws: entries });
  const work = mkdtempSync(join(tmpdir(), 'certificate-docs-'));
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.files === undefined) continue;
    const read = (ext) => readFileSync(join(savedDir, `${entry.files}.${ext}`), 'utf8');
    // The saved files must be the ones the record is about; the page would otherwise show hashes of other files.
    const same = (ext, hash) => hash === undefined || hashOf(read(ext)) === hash;
    if (!same('smt2', entry.record.problemHash) || !same('alethe', entry.record.proofHash))
      fail(`${key}: the saved problem or proof does not hash as its record says`);
    if (entry.record.systemHash !== undefined && !same('horn', entry.record.systemHash))
      fail(`${key}: the saved clauses do not hash as the record says`);
    const rules = rareRulesOf(read('alethe'));
    if (rules.length > 0) {
      const declared = await rareDeclarations(rules, work, 60000);
      if (!('text' in declared)) fail(`${key}: ${declared.reason}`);
      writeFileSync(join(outDir, `${entry.files}.rare`), declared.text);
      entry.rare = true;
    }
    for (const ext of ['smt2', 'alethe', ...(entry.record.systemHash === undefined ? [] : ['horn', 'inv'])])
      copyFileSync(join(savedDir, `${entry.files}.${ext}`), join(outDir, `${entry.files}.${ext}`));
    for (const ext of extensionsOf(entry)) keep.add(`${entry.files}.${ext}`);
  }
  // Files of laws that are gone or no longer certified are not part of the gallery.
  for (const name of readdirSync(outDir))
    if (!keep.has(name) && /\.(smt2|alethe|horn|inv|rare)$/.test(name)) unlinkSync(join(outDir, name));
  const index = { demo: slash(demo), laws: entries };
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  for (const [name, text] of Object.entries(badges)) writeFileSync(join(outDir, name), text);
  writeFileSync(
    join(outDir, 'README.md'),
    render(index, (name) => readFileSync(join(outDir, name), 'utf8')),
  );
  console.log(`wrote ${Object.keys(entries).length} laws to ${slash(relative(root, outDir))}`);
}

// What the code determines of an entry: see the top of this file.
const stable = (entry) => ({
  file: entry.file,
  line: entry.line,
  name: entry.name,
  source: entry.source,
  calls: entry.calls,
  certified: entry.files !== undefined,
  ...(entry.record === undefined
    ? {}
    : {
        law: entry.record.law,
        binds: entry.record.systemHash ?? entry.record.problemHash,
        loop: entry.record.systemHash !== undefined,
      }),
});

/** Runs Carcara as the page says, from the gallery directory (TSLAWS_CARCARA names the binary, as it does for tslaws). */
function carcaraRun(docs, entry) {
  const binary = process.env.TSLAWS_CARCARA ?? 'carcara';
  const script = ['.js', '.mjs', '.cjs'].some((ext) => binary.endsWith(ext));
  const args = carcaraCommand(entry).split(' ').slice(1);
  return spawnSync(script ? process.execPath : binary, script ? [binary, ...args] : args, {
    cwd: docs,
    encoding: 'utf8',
    timeout: 300000,
  });
}

function check({ fresh, docs = 'docs/certificates', recheck }) {
  if (fresh === undefined) fail('check needs --fresh <a gallery generated by this run>');
  const docsDir = resolve(root, docs);
  const freshDir = resolve(fresh);
  const problems = [];
  const indexPath = join(docsDir, 'index.json');
  if (!existsSync(indexPath)) fail(`${docs}/index.json is missing: generate the gallery and commit it`);
  const committed = readJson(indexPath);
  if (!existsSync(join(freshDir, 'index.json'))) fail(`no fresh gallery in ${fresh}: the generate step did not finish`);
  const current = readJson(join(freshDir, 'index.json'));
  for (const key of new Set([...Object.keys(committed.laws), ...Object.keys(current.laws)])) {
    const have = committed.laws[key];
    const now = current.laws[key];
    if (have === undefined) problems.push(`${key}: a law of the demo that the gallery does not have`);
    else if (now === undefined) problems.push(`${key}: in the gallery, but no longer a law of the demo`);
    else if (JSON.stringify(stable(have)) !== JSON.stringify(stable(now)))
      problems.push(
        `${key}: differs from a fresh run\n    committed ${JSON.stringify(stable(have))}\n    fresh     ${JSON.stringify(stable(now))}`,
      );
  }
  const read = (name) => readFileSync(join(docsDir, name), 'utf8');
  for (const [key, entry] of Object.entries(committed.laws)) {
    if (entry.files === undefined) continue;
    const missing = extensionsOf(entry).filter((ext) => !existsSync(join(docsDir, `${entry.files}.${ext}`)));
    if (missing.length > 0) {
      problems.push(`${key}: files missing from the gallery: ${missing.join(', ')}`);
      continue;
    }
    const hashes = [
      ['smt2', 'problemHash'],
      ['alethe', 'proofHash'],
      ...(entry.record.systemHash === undefined ? [] : [['horn', 'systemHash']]),
    ];
    for (const [ext, field] of hashes)
      if (hashOf(read(`${entry.files}.${ext}`)) !== entry.record[field])
        problems.push(`${key}: ${entry.files}.${ext} does not hash as ${field} in index.json says`);
  }
  for (const [source, index] of [
    ['index.json', committed],
    ['a fresh run', current],
  ])
    for (const [name, text] of Object.entries(badgesOfIndex(index)))
      if (!existsSync(join(docsDir, name)) || read(name) !== text) problems.push(`${name} is not what ${source} gives`);
  if (problems.length === 0) {
    if (!existsSync(join(docsDir, 'README.md')) || read('README.md') !== render(committed, read))
      problems.push('README.md is not what index.json renders to');
  }
  if (recheck && problems.length === 0)
    for (const [key, entry] of Object.entries(committed.laws)) {
      if (entry.files === undefined) continue;
      const ran = carcaraRun(docsDir, entry);
      const verdict = (ran.stdout ?? '').trim().split('\n')[0]?.trim();
      if (ran.error !== undefined) problems.push(`${key}: carcara did not run (${ran.error.message})`);
      else if (ran.status !== 0 || verdict !== 'valid')
        problems.push(
          `${key}: carcara did not accept the committed proof (${verdict || ran.stderr.trim().split('\n')[0]})`,
        );
      else console.log(`valid  ${entry.name}`);
    }
  if (problems.length > 0) {
    console.error(
      `::error::The certificate gallery in ${docs} is stale. Copy the certificate-docs artifact of this run over it.`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`the certificate gallery in ${docs} is current (${Object.keys(committed.laws).length} laws)`);
}

const [command] = process.argv.slice(2);
const given = options(process.argv.slice(3));
if (command === 'generate') await generate(given);
else if (command === 'check') check(given);
else
  fail(
    'usage: certificates-docs.mjs generate --report FILE [--demo DIR] [--out DIR] | check --fresh DIR [--docs DIR] [--recheck]',
  );
