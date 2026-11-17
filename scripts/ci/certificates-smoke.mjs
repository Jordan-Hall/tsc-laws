// Runs cvc5 and Carcara by hand on the problems in packages/tslaws/test/certificates.problems.json and prints
// everything they say. Used by the certificates workflow to see why a certificate fails; exits 1 if one does.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const problems = JSON.parse(readFileSync('packages/tslaws/test/certificates.problems.json', 'utf8'));
const { cvc5ProofArgs, carcaraArgs, problemText } = await import('../../packages/tslaws/dist/certificates.js').catch(
  () => ({ cvc5ProofArgs: undefined }),
);
if (cvc5ProofArgs === undefined) {
  console.log('tslaws is not built yet; build it before this step');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'cert-smoke-'));
let failed = false;
for (const [name, query] of Object.entries(problems)) {
  console.log(`::group::${name}`);
  const problem = join(dir, `${name}.smt2`);
  writeFileSync(problem, problemText(query));
  const cvc5 = spawnSync(process.env.TSLAWS_CVC5, [...cvc5ProofArgs, '--tlimit', '10000', problem], {
    encoding: 'utf8',
  });
  console.log(`cvc5 exit ${cvc5.status}\n${cvc5.stdout.slice(0, 4000)}\n${cvc5.stderr}`);
  const out = cvc5.stdout;
  if (cvc5.status === 0 && out.startsWith('unsat')) {
    const proof = join(dir, `${name}.alethe`);
    writeFileSync(proof, out.slice(out.indexOf('\n') + 1));
    const carcara = spawnSync(process.env.TSLAWS_CARCARA, ['check', proof, problem, ...carcaraArgs], {
      encoding: 'utf8',
    });
    console.log(`carcara exit ${carcara.status}\n${carcara.stdout}\n${carcara.stderr}`);
    if (carcara.status !== 0 || carcara.stdout.trim().split('\n')[0] !== 'valid') failed = true;
  } else failed = true;
  console.log('::endgroup::');
}
process.exit(failed ? 1 : 0);
