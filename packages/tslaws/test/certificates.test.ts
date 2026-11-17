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
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
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
  async function certifiedProject(name: string): Promise<{
    options: CheckOptions;
    laws: ManifestLaw[];
    certificate: NonNullable<LawResult['certificate']>;
  }> {
    process.env.TSLAWS_CVC5 = cvc5Proves().path;
    process.env.TSLAWS_CARCARA = carcaraAccepts().path;
    const { result, options } = await run(name, booleanLaw, { certify: true });
    assert.equal(result.certificate?.status, 'certified');
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

// TSLAWS_REQUIRE_CERT_TOOLS=1 (set by the certificates workflow) makes missing tools a failure instead of a skip.
const requireTools = process.env.TSLAWS_REQUIRE_CERT_TOOLS === '1';
const realTools = installed('TSLAWS_CVC5', 'cvc5') && installed('TSLAWS_CARCARA', 'carcara');
// cvc5 1.4.2 and Carcara cannot yet check these together: `ite-eq` is not declared for Carcara, and Carcara does not know `div_total`.
const limited = new Set(['int-define-fun-ite', 'bigint-div']);
const problems = JSON.parse(readFileSync(join(here, 'certificates.problems.json'), 'utf8')) as Record<string, string>;

describe(
  'with the real cvc5 and Carcara',
  { skip: realTools || requireTools ? false : 'cvc5 or carcara is not installed' },
  () => {
    it('has the tools when they are required', () => {
      if (requireTools)
        assert.ok(realTools, 'TSLAWS_REQUIRE_CERT_TOOLS=1 but cvc5 or carcara does not answer --version');
    });

    // The problems are shaped like the prover's queries: int and bigint (Int) and boolean laws, with define-fun terms.
    for (const name of Object.keys(problems)) {
      if (limited.has(name)) continue;
      it(`certifies ${name}`, async () => {
        const certificate = await certify(problems[name]!, { timeoutMs: 20000 });
        assert.equal(certificate.status, 'certified', certificate.reason);
        assert.match(certificate.proofHash ?? '', /^[0-9a-f]{64}$/);
      });
    }

    // The honest answers are `certified` (a newer cvc5 or Carcara) or `uncertified`; never a certificate that was not checked.
    for (const name of limited) {
      it(`certifies ${name}, or declines to`, async () => {
        const certificate = await certify(problems[name]!, { timeoutMs: 20000 });
        assert.ok(
          ['certified', 'uncertified'].includes(certificate.status),
          `${certificate.status}: ${certificate.reason}`,
        );
      });
    }

    it('refuses to certify a satisfiable query', async () => {
      const open = await certify(
        ['(declare-const x Int)', '(assert (> x 5))', '(check-sat)'].join(String.fromCharCode(10)),
        { timeoutMs: 10000 },
      );
      assert.equal(open.status, 'uncertified');
    });
  },
);
