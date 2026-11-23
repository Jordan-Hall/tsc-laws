// Proof certificates: the SMT-LIB translation, the cvc5 + Carcara pipeline, the status in a check and the lock records.
// cvc5 and Carcara are fakes (Node scripts that TSLAWS_CVC5 and TSLAWS_CARCARA point at, which print a fixed proof and a
// fixed verdict). One test at the end runs the real tools and is skipped when either is not installed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  certificateFailure,
  certificateLabel,
  certify,
  cvc5ProofArgs,
  problemText,
  hashOf,
  noCertificate,
  readRecords,
  rareDeclarations,
  rareRulesOf,
  recordOf,
  uncertifiable,
  writeRecords,
} from '../dist/certificates.js';
import { certificatesToAccept, check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { parseConfig } from '../dist/coverage.js';
import {
  acceptChanges,
  certificatesFromRun,
  isCertified,
  lawHash,
  lawKey,
  lockChanges,
  readLock,
  writeLock,
  writeLockValue,
} from '../dist/lock.js';
import type { CheckOptions, LawResult, ManifestLaw } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'tslaws-cert-'));
const projects = mkdtempSync(join(here, '..', '.tmp-cert-'));
const savedCvc5 = process.env.TSLAWS_CVC5;
const savedCarcara = process.env.TSLAWS_CARCARA;

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
});

afterEach(() => {
  for (const [name, saved] of [
    ['TSLAWS_CVC5', savedCvc5],
    ['TSLAWS_CARCARA', savedCarcara],
  ] as const) {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
});

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

let count = 0;

interface Fake {
  path: string;
  args: () => string[];
}

/** A fake tool: a Node script that records its arguments beside itself, then runs `body` (which sees `args`). */
function fake(body: string): Fake {
  const dir = join(root, `fake${count++}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'tool.mjs');
  writeFileSync(
    path,
    [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const dir = dirname(fileURLToPath(import.meta.url));',
      'const args = process.argv.slice(2);',
      "writeFileSync(join(dir, 'args.json'), JSON.stringify(args));",
      body,
      '',
    ].join('\n'),
  );
  return { path, args: () => JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[] };
}

const proof = '(\n(assume a0 (> x x))\n(step t1 (cl) :rule resolution :premises (a0))\n)';
/** cvc5 saying `unsat` and printing `proof` after it. */
const cvc5Proves = (): Fake => fake(`console.log('unsat'); console.log(${JSON.stringify(proof)});`);
/** Carcara that accepts: it prints `valid` only if the proof and problem files it was given exist. */
const carcaraAccepts = (): Fake =>
  fake("if (existsSync(args[1]) && existsSync(args[2])) console.log('valid'); else process.exitCode = 2;");

const query = '(set-option :timeout 5000)\n(declare-const x Int)\n(assert (> x x))\n(check-sat)';

describe('"certify" in tslaws.json', () => {
  it('accepts true, false, "require" and no key at all', () => {
    assert.equal(parseConfig({ certify: true }).certify, true);
    assert.equal(parseConfig({ certify: false }).certify, false);
    assert.equal(parseConfig({ certify: 'require' }).certify, 'require');
    assert.equal(parseConfig({}).certify, undefined);
  });

  it('refuses anything else with a message that names the key', () => {
    for (const certify of ['yes', 1, null, ['require']])
      assert.throws(
        () => parseConfig({ certify }),
        (error: Error) =>
          error.message.startsWith('tslaws.json: "certify"') && /true, false or "require"/.test(error.message),
      );
  });
});

describe('the RARE rules of a proof', () => {
  it('finds the rules, with or without premises, once each', () => {
    const proof = [
      '(step t1 (cl (= a b)) :rule rare_rewrite :args ("eq-refl" a))',
      '(step t2 (cl (= c d)) :rule rare_rewrite :premises (t1) :args ("arith-int-div-total" a 2))',
      '(step t3 (cl (= e f)) :rule rare_rewrite :args ("eq-refl" e))',
      '(step t4 (cl) :rule resolution :premises (t1 t2))',
    ].join(String.fromCharCode(10));
    assert.deepEqual(rareRulesOf(proof), ['eq-refl', 'arith-int-div-total']);
  });

  it('finds none in a proof that uses no RARE rule', () => {
    assert.deepEqual(rareRulesOf('(step t1 (cl) :rule hole)'), []);
  });
});

describe('the RARE declarations for Carcara', () => {
  const eol = String.fromCharCode(10);
  /** What cvc5 1.4.2's `-o rare-db` prints: no `ite-eq`, and `div_total` in the integer `div` rule. */
  const db = [
    '(declare-rule eq-refl ((@T0 Type) (t1 @T0))',
    '  :args (t1)',
    '  :conclusion (= (= t1 t1) true)',
    ')',
    '(declare-rule arith-int-div-total ((t1 Int) (s1 Int))',
    '  :premises ((= (= s1 0) false))',
    '  :args (t1 s1)',
    '  :conclusion (= (div t1 s1) (div_total t1 s1))',
    ')',
    '',
  ].join(eol);
  const cvc5PrintsDb = (): string => fake(`console.log(${JSON.stringify(db)});`).path;

  it('takes the rules a proof names from the database cvc5 prints, as RARE declarations', async () => {
    process.env.TSLAWS_CVC5 = cvc5PrintsDb();
    const declared = await rareDeclarations(['eq-refl'], root, 5000);
    assert.ok('text' in declared, JSON.stringify(declared));
    assert.match(declared.text, /^\(declare-rare-rule eq-refl /);
    assert.doesNotMatch(declared.text, /div_total/);
  });

  it('declares ite-eq, which cvc5 cites in Alethe proofs but leaves out of its database', async () => {
    process.env.TSLAWS_CVC5 = cvc5PrintsDb();
    const declared = await rareDeclarations(['eq-refl', 'ite-eq'], root, 5000);
    assert.ok('text' in declared, JSON.stringify(declared));
    assert.match(declared.text, /\(declare-rare-rule ite-eq \(\(@T0 Type\) \(C Bool\) \(t1 @T0\) \(t2 @T0\)\)/);
    assert.match(declared.text, /^\(declare-rare-rule eq-refl /);
  });

  it('declares the integer div rule without div_total, which Carcara does not read', async () => {
    process.env.TSLAWS_CVC5 = cvc5PrintsDb();
    const declared = await rareDeclarations(['arith-int-div-total'], root, 5000);
    assert.ok('text' in declared, JSON.stringify(declared));
    assert.match(declared.text, /:conclusion \(= \(div t1 s1\) \(div t1 s1\)\)/);
    assert.doesNotMatch(declared.text, /div_total/);
  });

  it('is uncertified, naming the rule, for a rule cvc5 does not declare and tslaws does not know', async () => {
    process.env.TSLAWS_CVC5 = cvc5PrintsDb();
    const declared = await rareDeclarations(['eq-refl', 'no-such-rule'], root, 5000);
    assert.ok('status' in declared, JSON.stringify(declared));
    assert.equal(declared.status, 'uncertified');
    assert.match(declared.reason, /no-such-rule/);
  });
});

describe('the SMT-LIB translation for cvc5', () => {
  it('drops the Z3 timeout and get-model, and sets a logic', () => {
    assert.equal(
      problemText(`${query}\n(get-model)\n`),
      '(set-logic ALL)\n(declare-const x Int)\n(assert (> x x))\n(check-sat)\n',
    );
  });

  it('certifies integer, boolean and array-free queries', () => {
    assert.equal(uncertifiable(query), undefined);
    assert.equal(uncertifiable('(declare-const a Bool)\n(assert (and a (not a)))\n(check-sat)'), undefined);
  });

  it('marks floating-point queries uncertifiable with a reason', () => {
    for (const text of [
      '(declare-const x (_ FloatingPoint 11 53))\n(check-sat)',
      '(define-fun y () Float64 ((_ to_fp 11 53) RNE 1.0))\n(check-sat)',
      '(assert (fp.lt x y))\n(check-sat)',
      '(assert (= r RNE))\n(check-sat)',
    ])
      assert.match(uncertifiable(text) ?? '', /floating-point.*Alethe/);
  });

  it('marks string queries uncertifiable with a reason', () => {
    assert.match(uncertifiable('(declare-const s String)\n(check-sat)') ?? '', /strings.*Alethe/);
    assert.match(uncertifiable('(assert (= (str.len s) 0))\n(check-sat)') ?? '', /strings/);
  });

  it('does not read a quoted symbol as syntax', () => {
    assert.equal(uncertifiable('(declare-const |String x| Int)\n(check-sat)'), undefined);
  });
});

describe('certify', () => {
  it('runs cvc5 for an Alethe proof, has Carcara check it and hashes both', async () => {
    const cvc5 = cvc5Proves();
    const carcara = carcaraAccepts();
    process.env.TSLAWS_CVC5 = cvc5.path;
    process.env.TSLAWS_CARCARA = carcara.path;
    const certificate = await certify(query, { timeoutMs: 4321 });
    assert.equal(certificate.status, 'certified');
    const args = cvc5.args();
    for (const arg of cvc5ProofArgs) assert.ok(args.includes(arg), `cvc5 was not given ${arg}`);
    assert.ok(args.includes('--dump-proofs') && args.includes('--proof-format-mode=alethe'));
    // Pivots named by cvc5 are not found in a clause that repeats a literal, so Carcara refuses a sound proof.
    assert.ok(args.includes('--no-proof-alethe-res-pivots'));
    assert.ok(!args.includes('--proof-alethe-res-pivots'));
    assert.equal(args[args.indexOf('--tlimit') + 1], '4321');
    assert.match(args.at(-1)!, /problem\.smt2$/);
    const checked = carcara.args();
    assert.equal(checked[0], 'check');
    assert.match(checked[1]!, /proof\.alethe$/);
    assert.match(checked[2]!, /problem\.smt2$/);
    assert.ok(checked.includes('--allow-int-real-subtyping'));
    const problemHash = sha256(problemText(query));
    const proofHash = sha256(`${proof}\n`);
    assert.equal(certificate.problemHash, problemHash);
    assert.equal(certificate.proofHash, proofHash);
    assert.equal(
      certificate.checkerHash,
      sha256(JSON.stringify({ verdict: 'valid', problem: problemHash, proof: proofHash })),
    );
    assert.equal(certificateLabel(certificate), 'certified');
  });

  it('keeps the problem and proof of a certified law when asked to', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    const kept = join(root, 'kept', 'certificates');
    const certificate = await certify(query, {
      timeoutMs: 1000,
      keep: { dir: kept, name: 'law-1', root: join(root, 'kept') },
    });
    assert.equal(certificate.proofFile, 'certificates/law-1.alethe');
    assert.equal(readFileSync(join(kept, 'law-1.alethe'), 'utf8'), `${proof}\n`);
    assert.equal(readFileSync(join(kept, 'law-1.smt2'), 'utf8'), problemText(query));
  });

  it('does not start a tool for a query that cannot be certified', async () => {
    process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
    const certificate = await certify('(declare-const s String)\n(check-sat)', { timeoutMs: 1000 });
    assert.equal(certificate.status, 'uncertified');
    assert.match(certificateLabel(certificate), /^uncertified \(the law uses strings/);
  });

  it('is uncertified when cvc5 does not answer unsat or prints no proof', async () => {
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    process.env.TSLAWS_CVC5 = fake("console.log('sat');").path;
    assert.deepEqual(await certify(query, { timeoutMs: 1000 }), {
      status: 'uncertified',
      reason: 'cvc5 gave no Alethe proof (sat)',
    });
    process.env.TSLAWS_CVC5 = fake(
      'console.log(\'(error "proofs are not supported for this logic")\'); process.exitCode = 1;',
    ).path;
    assert.match(
      (await certify(query, { timeoutMs: 1000 })).reason ?? '',
      /gave no Alethe proof \(\(error "proofs are not supported/,
    );
    process.env.TSLAWS_CVC5 = fake("console.log('unsat');").path;
    assert.equal((await certify(query, { timeoutMs: 1000 })).reason, 'cvc5 answered unsat but printed no proof');
  });

  it("is uncertified, with Carcara's reason, when the checker rejects the proof", async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = fake(
      "console.log('invalid'); console.error('checking failed on step t1'); process.exitCode = 1;",
    ).path;
    const certificate = await certify(query, { timeoutMs: 1000 });
    assert.equal(certificate.status, 'uncertified');
    assert.equal(certificate.reason, 'Carcara did not accept the proof (invalid)');
    assert.equal(certificate.proofHash, undefined);
  });

  it('says which step Carcara rejected, from its error line', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = fake(
      [
        "console.log('invalid');",
        "console.error('error: pivot was not found in clause: (not (>= a 1))');",
        "console.error('  --> in file /tmp/x/proof.alethe');",
        'process.exitCode = 1;',
      ].join(String.fromCharCode(10)),
    ).path;
    const certificate = await certify(query, { timeoutMs: 1000 });
    assert.equal(certificate.status, 'uncertified');
    assert.equal(
      certificate.reason,
      'Carcara did not accept the proof (invalid: error: pivot was not found in clause: (not (>= a 1)))',
    );
  });

  it('does not call a proof rejected when Carcara cannot read the rewrite rules cvc5 declared', async () => {
    const rareProof = proof.replace(
      '(step t1',
      '(step t0 (cl (= (= x x) true)) :rule rare_rewrite :args ("eq-refl" x))\n(step t1',
    );
    const db = '(declare-rule eq-refl ((t1 Int))\n  :args (t1)\n  :conclusion (= (= t1 t1) true)\n)';
    process.env.TSLAWS_CVC5 = fake(
      `if (args.includes('rare-db')) console.log(${JSON.stringify(db)});
else { console.log('unsat'); console.log(${JSON.stringify(rareProof)}); }`,
    ).path;
    process.env.TSLAWS_CARCARA = fake(
      [
        "console.log('invalid');",
        'console.error("error: identifier \'div_total\' is not defined");',
        "console.error('  --> in file ' + args[args.indexOf('--rare-file') + 1] + ':4:31');",
        'process.exitCode = 1;',
      ].join(String.fromCharCode(10)),
    ).path;
    const certificate = await certify(query, { timeoutMs: 1000 });
    assert.equal(certificate.status, 'uncertified');
    assert.equal(
      certificate.reason,
      "Carcara could not read the rewrite rules cvc5 declared (error: identifier 'div_total' is not defined)",
    );
  });

  it('does not certify a proof Carcara could only partly check', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = fake("console.log('holey');").path;
    const certificate = await certify(query, { timeoutMs: 1000 });
    assert.equal(certificate.status, 'uncertified');
    assert.match(certificate.reason ?? '', /steps Carcara could not check/);
  });

  it('does not certify when Carcara exits non-zero, whatever it printed', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = fake("console.log('valid'); process.exitCode = 1;").path;
    assert.equal((await certify(query, { timeoutMs: 1000 })).status, 'uncertified');
  });

  it('is unavailable, never a failure, when cvc5 or Carcara is missing', async () => {
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
    const noCvc5 = await certify(query, { timeoutMs: 1000 });
    assert.equal(noCvc5.status, 'unavailable');
    assert.match(noCvc5.reason ?? '', /install cvc5.*TSLAWS_CVC5/);
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = join(root, 'missing', 'carcara');
    const noCarcara = await certify(query, { timeoutMs: 1000 });
    assert.equal(noCarcara.status, 'unavailable');
    assert.match(noCarcara.reason ?? '', /install Carcara.*TSLAWS_CARCARA/);
  });

  it('only "require" turns a missing certificate into a failure', () => {
    const missing = { status: 'unavailable', reason: 'no cvc5' } as const;
    assert.equal(certificateFailure(true, missing), undefined);
    assert.equal(certificateFailure(false, missing), undefined);
    assert.equal(certificateFailure(undefined, missing), undefined);
    assert.match(certificateFailure('require', missing) ?? '', /"certify": "require".*unavailable \(no cvc5\)/);
    assert.equal(certificateFailure('require', { status: 'certified' }), undefined);
  });
});

const law = (name: string, text = `export law ${name}() { return true; }`): ManifestLaw => ({
  file: 'src/f.laws.ts',
  name,
  exported: true,
  proved: false,
  line: 1,
  params: [],
  body: '',
  text,
  problems: [],
});

const certified = {
  status: 'certified',
  problemHash: 'a'.repeat(64),
  proofHash: 'b'.repeat(64),
  checkerHash: 'c'.repeat(64),
} as const;

describe('certificate records in the lock', () => {
  it('records the hashes of a certified proof and nothing for any other status', () => {
    assert.deepEqual(recordOf('h', certified), {
      law: 'h',
      problemHash: 'a'.repeat(64),
      proofHash: 'b'.repeat(64),
      checkerHash: 'c'.repeat(64),
    });
    assert.equal(recordOf('h', { status: 'uncertified', reason: 'x' }), undefined);
    assert.equal(recordOf('h', { status: 'unavailable', reason: 'x' }), undefined);
  });

  it('writes a record beside the law it certifies and reads it back', () => {
    const path = join(root, 'a.lock');
    const laws = [law('one'), law('two')];
    const key = lawKey('src/f.laws.ts', 'one');
    writeLock(path, laws, [], undefined, { [key]: recordOf(lawHash(laws[0]!), certified)! });
    const lock = readLock(path)!;
    assert.deepEqual(Object.keys(lock.certificates ?? {}), [key]);
    assert.equal(lock.certificates![key]!.proofHash, 'b'.repeat(64));
    assert.equal(isCertified(lock, key), true);
    assert.equal(isCertified(lock, lawKey('src/f.laws.ts', 'two')), false);
  });

  it('drops a record whose law changed or went away, so an edit voids the certificate', () => {
    const path = join(root, 'b.lock');
    const before = [law('one')];
    const key = lawKey('src/f.laws.ts', 'one');
    const records = {
      [key]: recordOf(lawHash(before[0]!), certified)!,
      'src/f.laws.ts::gone': recordOf('x', certified)!,
    };
    writeLock(path, [law('one', 'export law one() { return 1 === 1; }')], [], undefined, records);
    assert.equal(readLock(path)!.certificates, undefined);
    writeLock(path, before, [], undefined, records);
    assert.deepEqual(Object.keys(readLock(path)!.certificates ?? {}), [key]);
  });

  it('leaves the lock format unchanged when nothing is certified', () => {
    const a = join(root, 'c1.lock');
    const b = join(root, 'c2.lock');
    writeLock(a, [law('one')], []);
    writeLock(b, [law('one')], [], undefined, {});
    assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
    assert.doesNotMatch(readFileSync(a, 'utf8'), /certificates/);
  });

  it('writes a certificate only from the ones given, never from the old lock', () => {
    const path = join(root, 'd.lock');
    const laws = [law('one'), law('two')];
    const key = lawKey('src/f.laws.ts', 'one');
    writeLock(path, laws, [], undefined, { [key]: recordOf(lawHash(laws[0]!), certified)! });
    const lock = readLock(path)!;
    const given = { [key]: recordOf(lawHash(laws[0]!), certified)! };
    const accept = (now: ManifestLaw[], records = given) =>
      acceptChanges(lock, now, [], undefined, new Set(lockChanges(lock, now, []).map((c) => c.fingerprint)), records);
    assert.equal(
      acceptChanges(lock, laws, [], undefined, new Set()).certificates,
      undefined,
      'the old lock certificate is not carried over',
    );
    const withThree = accept([...laws, law('three')]);
    assert.deepEqual(Object.keys(withThree.certificates ?? {}), [key]);
    writeLockValue(path, withThree);
    assert.deepEqual(Object.keys(readLock(path)!.certificates ?? {}), [key]);
    assert.equal(accept([laws[1]!]).certificates, undefined, 'removing the law removes its certificate');
    assert.equal(
      accept([law('one', 'export law one() { return 1 === 1; }'), laws[1]!]).certificates,
      undefined,
      'accepting an edit removes the certificate of the old text',
    );
  });

  it('keeps the records a check leaves for accept to copy, and replaces them per law', () => {
    const cwd = mkdtempSync(join(root, 'records-'));
    assert.deepEqual(readRecords(cwd), {});
    const record = recordOf('h1', certified)!;
    writeRecords(
      cwd,
      new Map([
        ['k1', record],
        ['k2', record],
      ]),
    );
    writeRecords(cwd, new Map([['k2', undefined]]));
    assert.deepEqual(Object.keys(readRecords(cwd)), ['k1']);
    assert.ok(existsSync(join(cwd, '.tslaws', 'certificates.json')));
  });
});

function project(name: string, files: Record<string, string>): CheckOptions {
  const cwd = join(projects, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const options: CheckOptions = {
    files: ['src/f.laws.ts'],
    cwd,
    runs: 100,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 10000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return options;
}

const booleanLaw = 'export law commutes(a: boolean, b: boolean) { return (a && b) === (b && a); }\n';
const floatLaw = 'export law commutes(a: number, b: number) { return a + b === b + a; }\n';

async function run(
  name: string,
  text: string,
  config: Record<string, unknown>,
  flag?: CheckOptions['certify'],
): Promise<{ result: LawResult; options: CheckOptions }> {
  const options = project(name, { 'src/f.laws.ts': text, 'tslaws.json': JSON.stringify(config) });
  const found = (await check({ ...options, certify: flag }, true)).results.find((r) => r.name === 'commutes');
  assert.ok(found, 'no result for commutes');
  return { result: found, options };
}

describe('certificates in a check', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('does nothing about certificates unless asked', async () => {
    process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
    const { result, options } = await run('off', booleanLaw, {});
    assert.equal(result.status, 'proved');
    assert.equal(result.certificate, undefined);
    assert.equal(existsSync(join(options.cwd, '.tslaws', 'certificates.json')), false);
  });

  it('certifies a proved law from tslaws.json and records it for the lock', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    const { result, options } = await run('config', booleanLaw, { certify: true });
    assert.equal(result.status, 'proved');
    assert.equal(result.certificate?.status, 'certified');
    assert.match(result.certificate?.proofFile ?? '', /^\.tslaws\/certificates\/commutes-[0-9a-f]{8}\.alethe$/);
    assert.ok(existsSync(join(options.cwd, result.certificate!.proofFile!)));
    // `tslaws accept` copies the records into the lock, where they sit beside the law's hash.
    const laws = readManifest(compiler!, options.files, options.cwd);
    writeLock(options.lockFile, laws, [], undefined, readRecords(options.cwd));
    const lock = readLock(options.lockFile)!;
    const key = lawKey('src/f.laws.ts', 'commutes');
    assert.equal(isCertified(lock, key), true);
    assert.equal(lock.certificates![key]!.proofHash, result.certificate!.proofHash);
    assert.equal(lock.certificates![key]!.checkerHash, result.certificate!.checkerHash);
  });

  it('certifies from the flag when tslaws.json is silent', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    assert.equal((await run('flag', booleanLaw, {}, true)).result.certificate?.status, 'certified');
  });

  it('stays proved, as uncertified with a reason, when the checker rejects the proof', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = fake("console.log('invalid'); process.exitCode = 1;").path;
    const { result, options } = await run('rejected', booleanLaw, { certify: true });
    assert.equal(result.status, 'proved');
    assert.equal(result.certificate?.status, 'uncertified');
    assert.match(certificateLabel(result.certificate!), /^uncertified \(Carcara did not accept the proof/);
    assert.deepEqual(readRecords(options.cwd), {});
  });

  it('stays proved, as unavailable, when the tools are missing', async () => {
    process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
    const { result } = await run('unavailable', booleanLaw, { certify: true });
    assert.equal(result.status, 'proved');
    assert.equal(result.certificate?.status, 'unavailable');
  });

  it('is an error with "require" when a proof cannot be certified', async () => {
    process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
    const required = await run('require-config', booleanLaw, { certify: 'require' });
    assert.equal(required.result.status, 'error');
    assert.match(required.result.message ?? '', /"certify": "require".*unavailable/);
    assert.equal((await run('require-flag', booleanLaw, {}, 'require')).result.status, 'error');
  });

  it('fails "require" for a proof that has no certificate at all, and for a result cvc5 did not confirm', async () => {
    assert.match(certificateFailure('require', noCertificate) ?? '', /uncertified \(no certificate produced\)/);
    // With the second solver set, cvc5 disagrees (it says sat), so Z3's proof does not stand: the law is only bounded,
    // and with "require" that must still fail, not pass for want of a certificate.
    process.env.TSLAWS_CVC5 = fake("console.log('sat');").path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    const config = { certify: 'require', solvers: ['z3', 'cvc5'] };
    const required = await run('require-unconfirmed', booleanLaw, config);
    assert.equal(required.result.status, 'error');
    assert.match(required.result.message ?? '', /"certify": "require" is set but the proof is uncertified/);
    // Without "require" the law keeps its status and says it is uncertified.
    const lenient = await run('lenient-unconfirmed', booleanLaw, { ...config, certify: true });
    assert.equal(lenient.result.status, 'bounded');
    assert.equal(lenient.result.certificate?.status, 'uncertified');
    assert.deepEqual(readRecords(lenient.options.cwd), {});
  });

  it('passes "require" when the proof is certified', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    assert.equal((await run('require-ok', booleanLaw, { certify: 'require' })).result.status, 'proved');
  });

  it('marks a floating-point proof uncertified without running a tool', async () => {
    process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
    const { result } = await run('float', floatLaw, { certify: true });
    assert.equal(result.status, 'proved');
    assert.equal(result.certificate?.status, 'uncertified');
    assert.match(result.certificate?.reason ?? '', /floating-point/);
  });
});

describe('accepting certificates', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  const key = lawKey('src/f.laws.ts', 'commutes');
  /** A project whose law was certified by the fakes, with the sidecar record and saved files a check leaves. */
  async function certifiedProject(
    name: string,
    law = booleanLaw,
  ): Promise<{
    options: CheckOptions;
    laws: ManifestLaw[];
    certificate: NonNullable<LawResult['certificate']>;
  }> {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    const { result, options } = await run(name, law, { certify: true });
    assert.equal(result.certificate?.status, 'certified', JSON.stringify(result));
    return {
      options,
      laws: readManifest(compiler!, options.files, options.cwd),
      certificate: result.certificate!,
    };
  }
  const saved = (options: CheckOptions, extension: string): string => {
    const dir = join(options.cwd, '.tslaws', 'certificates');
    return join(
      dir,
      readdirSync(dir).find((f) => f.endsWith(extension))!,
    );
  };
  const accept = async (
    options: CheckOptions,
    laws: ManifestLaw[],
    held?: Record<string, NonNullable<ReturnType<typeof recordOf>>>,
  ): Promise<{ records: Record<string, unknown>; said: string }> => {
    let said = '';
    const records = await certificatesToAccept(options, laws, held, (text) => (said += text));
    return { records, said };
  };

  it('keeps a record whose files, hashes and Carcara check all hold', async () => {
    const { options, laws, certificate } = await certifiedProject('accept-ok');
    const { records, said } = await accept(options, laws);
    assert.deepEqual(Object.keys(records), [key]);
    assert.equal((records[key] as { proofHash: string }).proofHash, certificate.proofHash);
    assert.equal(said, '');
  });

  it('keeps the record of a law proved for arrays of any length', async () => {
    // The prover sends arrays as unbounded SMT arrays; accept must rebuild that same problem to find the record's hash.
    const arrayLaw = [
      "import type { int } from 'tslaws';",
      'export law commutes(xs: int[]) { return xs.length + 0 === xs.length; }',
      '',
    ].join(String.fromCharCode(10));
    const { options, laws } = await certifiedProject('accept-arrays', arrayLaw);
    const { records, said } = await accept(options, laws);
    assert.deepEqual(Object.keys(records), [key]);
    assert.equal(said, '');
  });

  it('drops a forged record whose saved problem and proof are missing', async () => {
    const { options, laws } = await certifiedProject('accept-forged');
    rmSync(join(options.cwd, '.tslaws', 'certificates'), { recursive: true, force: true });
    const { records, said } = await accept(options, laws);
    assert.deepEqual(records, {});
    assert.match(said, /certificate dropped for .*commutes: the saved problem or proof is missing/);
  });

  it('drops a record when a saved file no longer matches its hash', async () => {
    const proofEdited = await certifiedProject('accept-proof-edited');
    writeFileSync(saved(proofEdited.options, '.alethe'), '(step t1 (cl) :rule hole)\n');
    const first = await accept(proofEdited.options, proofEdited.laws);
    assert.deepEqual(first.records, {});
    assert.match(first.said, /the saved proof does not match the record/);
    const problemEdited = await certifiedProject('accept-problem-edited');
    writeFileSync(saved(problemEdited.options, '.smt2'), '(assert true)\n');
    const second = await accept(problemEdited.options, problemEdited.laws);
    assert.deepEqual(second.records, {});
    assert.match(second.said, /the saved problem does not match the record/);
  });

  it('drops a record Carcara no longer accepts, and keeps none when Carcara is missing', async () => {
    const { options, laws } = await certifiedProject('accept-recheck');
    process.env.TSLAWS_CARCARA = fake("console.log('invalid'); process.exitCode = 1;").path;
    const rejected = await accept(options, laws);
    assert.deepEqual(rejected.records, {});
    assert.match(rejected.said, /Carcara did not accept the proof/);
    process.env.TSLAWS_CARCARA = join(root, 'missing', 'carcara');
    const missing = await accept(options, laws);
    assert.deepEqual(missing.records, {});
    assert.match(missing.said, /no new certificates were recorded/);
  });

  it('drops a record for a law that changed since it was certified', async () => {
    const { options, laws } = await certifiedProject('accept-law-changed');
    const edited = laws.map((l) => ({ ...l, text: l.text.replace('return', 'return true &&') }));
    const { records, said } = await accept(options, edited);
    assert.deepEqual(records, {});
    assert.match(said, /the law changed since it was certified/);
  });

  it('drops a record that is for another problem than the law yields, even with matching files', async () => {
    const { options, laws } = await certifiedProject('accept-other-problem');
    // A forger who writes a different problem and a matching record still cannot bind it to this law.
    const other = '(set-logic ALL)\n(declare-const x Int)\n(assert (> x x))\n(check-sat)\n';
    const record = readRecords(options.cwd)[key]!;
    writeFileSync(saved(options, '.smt2'), other);
    const forged = { ...record, problemHash: hashOf(other) };
    writeFileSync(join(options.cwd, '.tslaws', 'certificates.json'), JSON.stringify({ [key]: forged }));
    const { records, said } = await accept(options, laws);
    assert.deepEqual(records, {});
    assert.match(said, /different proof problem than the law yields now/);
  });

  it('keeps the certificate of a law the lock does not record yet, so accepting it can record the proof', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    const options = project('accept-new-law', {
      'src/f.laws.ts': booleanLaw,
      'tslaws.json': JSON.stringify({ certify: true }),
    });
    writeLock(options.lockFile, []);
    const checked = await check(options, true);
    const result = checked.results.find((r) => r.name === 'commutes')!;
    assert.equal(result.status, 'tampered');
    assert.equal(result.proposal?.status, 'proved');
    assert.equal(result.proposal?.certificate?.status, 'certified');
    assert.deepEqual(Object.keys(readRecords(options.cwd)), [key]);
    const laws = readManifest(compiler!, options.files, options.cwd);
    assert.deepEqual(Object.keys((await accept(options, laws)).records), [key]);
    // The GitHub flow takes the certificate from the same result once the lock records the law.
    const lock = acceptChanges(
      undefined,
      laws,
      [],
      undefined,
      new Set(lockChanges(undefined, laws, []).map((c) => c.fingerprint)),
    );
    assert.deepEqual(Object.keys(certificatesFromRun(lock, laws, checked.results)), [key]);
  });

  it('carries a lock certificate over only while its law and its problem still match', async () => {
    const { options, laws, certificate } = await certifiedProject('accept-old-lock');
    rmSync(join(options.cwd, '.tslaws', 'certificates.json'));
    const current = recordOf(lawHash(laws[0]!), certificate)!;
    const kept = await accept(options, laws, { [key]: current });
    assert.deepEqual(Object.keys(kept.records), [key]);
    const stale = await accept(options, laws, { [key]: { ...current, problemHash: 'd'.repeat(64) } });
    assert.deepEqual(stale.records, {});
    assert.match(stale.said, /the law or its proof problem changed since it was certified/);
  });
});

/** Whether a tool answers `--version`. */
function installed(env: string, binary: string): boolean {
  const path = process.env[env] ?? binary;
  const mjs = ['.js', '.mjs', '.cjs'].includes(path.slice(path.lastIndexOf('.')));
  const found = mjs ? spawnSync(process.execPath, [path, '--version']) : spawnSync(path, ['--version']);
  return found.error === undefined && found.status === 0;
}

const loopSource = [
  "import type { int } from 'tslaws';",
  'export function twice(n: int): int {',
  '  let s = 0;',
  '  let i = 0;',
  '  while (i < n) {',
  '    s += 2;',
  '    i += 1;',
  '  }',
  '  return s as int;',
  '}',
  '',
].join(String.fromCharCode(10));
const loopLaws = [
  "import { assume } from 'tslaws';",
  "import type { int } from 'tslaws';",
  "import { twice } from './f';",
  'export law proved twiceIsDouble(n: int) { assume(n >= 0 && n <= 1000000); return twice(n) === 2 * n; }',
  '',
].join(String.fromCharCode(10));

describe('certificates for loop proofs', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  const key = lawKey('src/f.laws.ts', 'twiceIsDouble');
  const loopOptions = (name: string): CheckOptions => ({
    ...project(name, { 'src/f.ts': loopSource, 'src/f.laws.ts': loopLaws }),
    certify: true,
  });
  const certifiedLoop = async (
    name: string,
  ): Promise<{ options: CheckOptions; laws: ManifestLaw[]; result: LawResult }> => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    const options = loopOptions(name);
    const result = (await check(options, true)).results.find((r) => r.name === 'twiceIsDouble')!;
    assert.equal(result.status, 'proved', JSON.stringify(result));
    return { options, laws: readManifest(compiler!, options.files, options.cwd), result };
  };
  const savedFile = (options: CheckOptions, extension: string): string => {
    const dir = join(options.cwd, '.tslaws', 'certificates');
    return join(
      dir,
      readdirSync(dir).find((f) => f.endsWith(extension))!,
    );
  };
  const accept = async (options: CheckOptions, laws: ManifestLaw[]): Promise<{ keys: string[]; said: string }> => {
    let said = '';
    const records = await certificatesToAccept(options, laws, undefined, (text) => (said += text));
    return { keys: Object.keys(records), said };
  };

  it('certifies the invariants Z3 found, binds the record to the clauses and saves what accept needs', async () => {
    const { options, result } = await certifiedLoop('loop-certified');
    assert.equal(result.certificate?.status, 'certified', JSON.stringify(result.certificate));
    assert.match(result.certificate?.systemHash ?? '', /^[0-9a-f]{64}$/);
    for (const extension of ['.smt2', '.alethe', '.horn', '.inv']) assert.ok(savedFile(options, extension));
    const query = readFileSync(savedFile(options, '.smt2'), 'utf8');
    assert.doesNotMatch(
      query,
      /forall|define-fun|declare-fun/,
      'the problem has no quantifier and no unknown predicate',
    );
    assert.equal(result.certificate?.systemHash, hashOf(readFileSync(savedFile(options, '.horn'), 'utf8')));
    assert.equal(readRecords(options.cwd)[key]?.systemHash, result.certificate?.systemHash);
  });

  it('passes "require" now that a loop proof has a certificate', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    const options = { ...loopOptions('loop-require'), certify: 'require' as const };
    const result = (await check(options, true)).results.find((r) => r.name === 'twiceIsDouble')!;
    assert.equal(result.status, 'proved', JSON.stringify(result));
    assert.equal(result.certificate?.status, 'certified');
  });

  it('is not certified, and "require" fails, when Carcara rejects the proof of the invariants', async () => {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = fake("console.log('invalid'); process.exitCode = 1;").path;
    const options = { ...loopOptions('loop-rejected'), certify: 'require' as const };
    const result = (await check(options, true)).results.find((r) => r.name === 'twiceIsDouble')!;
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.match(result.message ?? '', /Carcara did not accept the proof/);
  });

  it('accepts the record while the clauses, invariants and proof check out', async () => {
    const { options, laws } = await certifiedLoop('loop-accept');
    const { keys, said } = await accept(options, laws);
    assert.deepEqual(keys, [key]);
    assert.equal(said, '');
    const lock = acceptChanges(
      undefined,
      laws,
      [],
      undefined,
      new Set(lockChanges(undefined, laws, []).map((c) => c.fingerprint)),
      readRecords(options.cwd),
    );
    assert.equal(lock.certificates?.[key]?.systemHash, readRecords(options.cwd)[key]?.systemHash);
  });

  it('drops a record whose saved invariants are not the ones that made the saved problem', async () => {
    const { options, laws } = await certifiedLoop('loop-invariant-edited');
    const file = savedFile(options, '.inv');
    console.log('INV<<' + readFileSync(file, 'utf8') + '>>');
    // An invariant that is false at entry would make a different problem; the saved one must not stand for it.
    writeFileSync(file, readFileSync(file, 'utf8').replace(/Bool\s[\s\S]*$/, 'Bool false)'));
    const { keys, said } = await accept(options, laws);
    assert.deepEqual(keys, []);
    assert.match(said, /the saved invariants do not turn the clauses into the saved problem/);
  });

  it('drops a record whose saved clauses were swapped, or whose saved files are gone', async () => {
    const swapped = await certifiedLoop('loop-clauses-edited');
    writeFileSync(savedFile(swapped.options, '.horn'), '(set-logic HORN)\n(check-sat)\n');
    const first = await accept(swapped.options, swapped.laws);
    assert.deepEqual(first.keys, []);
    assert.match(first.said, /the saved clauses do not match the record/);
    const gone = await certifiedLoop('loop-files-gone');
    rmSync(savedFile(gone.options, '.inv'));
    const second = await accept(gone.options, gone.laws);
    assert.deepEqual(second.keys, []);
    assert.match(second.said, /the saved clauses or invariants are missing/);
  });

  it('drops a record for another system of clauses than the law yields now', async () => {
    const { options, laws } = await certifiedLoop('loop-other-clauses');
    const other = '(set-logic HORN)\n(check-sat)\n';
    const record = readRecords(options.cwd)[key]!;
    writeFileSync(savedFile(options, '.horn'), other);
    writeFileSync(
      join(options.cwd, '.tslaws', 'certificates.json'),
      JSON.stringify({ [key]: { ...record, systemHash: hashOf(other) } }),
    );
    const { keys, said } = await accept(options, laws);
    assert.deepEqual(keys, []);
    assert.match(said, /different proof problem than the law yields now/);
  });
});

// TSLAWS_REQUIRE_CERT_TOOLS=1 (set by the certificates workflow) makes missing tools a failure instead of a skip.
const requireTools = process.env.TSLAWS_REQUIRE_CERT_TOOLS === '1';
const realTools = installed('TSLAWS_CVC5', 'cvc5') && installed('TSLAWS_CARCARA', 'carcara');
const problems = JSON.parse(readFileSync(join(here, 'certificates.problems.json'), 'utf8')) as Record<string, string>;

describe(
  'with the real cvc5 and Carcara',
  { skip: realTools || requireTools ? false : 'cvc5 or carcara is not installed' },
  () => {
    it('has the tools when they are required', () => {
      if (requireTools)
        assert.ok(realTools, 'TSLAWS_REQUIRE_CERT_TOOLS=1 but cvc5 or carcara does not answer --version');
    });

    // The problems are shaped like the prover's queries: int and bigint (Int) and boolean laws, among them the integer
    // range obligations (`ite` and `div` included) that a law over `int` carries.
    for (const name of Object.keys(problems)) {
      it(`certifies ${name}`, async () => {
        const certificate = await certify(problems[name]!, { timeoutMs: 20000 });
        assert.equal(certificate.status, 'certified', certificate.reason);
        assert.match(certificate.proofHash ?? '', /^[0-9a-f]{64}$/);
      });
    }

    // cvc5 1.4.2 declares no `mod-elim` rule, so a law with `mod` is not certified yet; it must say why, not fail.
    it('declines a law with mod, naming the rule cvc5 leaves undeclared', async () => {
      const certificate = await certify(
        '(set-option :timeout 5000)\n(declare-const a Int)\n(assert (not (= (mod (* 2 a) 2) 0)))\n(check-sat)',
        { timeoutMs: 20000 },
      );
      assert.ok(['certified', 'uncertified'].includes(certificate.status), certificate.reason);
      if (certificate.status === 'uncertified') assert.match(certificate.reason ?? '', /mod-elim/);
    });

    it('does not certify a proof that Carcara rejects, and says so', async () => {
      process.env.TSLAWS_CVC5 = fake(`console.log('unsat'); console.log(${JSON.stringify(proof)});`).path;
      const certificate = await certify(query, { timeoutMs: 10000 });
      assert.equal(certificate.status, 'uncertified');
      assert.match(certificate.reason ?? '', /^Carcara did not accept the proof \(invalid/);
    });
    it('refuses to certify a satisfiable query', async () => {
      const open = await certify(
        ['(declare-const x Int)', '(assert (> x 5))', '(check-sat)'].join(String.fromCharCode(10)),
        { timeoutMs: 10000 },
      );
      assert.equal(open.status, 'uncertified');
    });
  },
);
