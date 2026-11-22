// TEMPORARY diagnostics.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const problems = JSON.parse(readFileSync('packages/tslaws/test/certificates.problems.json', 'utf8'));
const { problemText, rareRulesOf, rareDeclarations } = await import('../../packages/tslaws/dist/certificates.js');
const base = ['--lang', 'smt2', '--dump-proofs', '--proof-format-mode=alethe', '--tlimit', '10000'];
const common = ['--proof-granularity=dsl-rewrite', '--dag-thresh=0', '--simplification=none', '--enum-inst-interleave', '--cegqi-all'];
const variants = { 'explicit-no-pivots': [...common, '--no-proof-alethe-res-pivots'] };
const iteEq = {
  upstream: '(declare-rare-rule ite-eq ((@T0 Type) (C Bool) (t1 @T0) (t2 @T1))\n  :args (C t1 t2)\n  :conclusion (= (ite C (= (ite C t1 t2) t1) (= (ite C t1 t2) t2)) true))\n',
  fixed: '(declare-rare-rule ite-eq ((@T0 Type) (C Bool) (t1 @T0) (t2 @T0))\n  :args (C t1 t2)\n  :conclusion (= (ite C (= (ite C t1 t2) t1) (= (ite C t1 t2) t2)) true))\n',
};
const dir = mkdtempSync(join(tmpdir(), 'cert-var-'));
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
for (const [name, query] of Object.entries(problems)) {
  const problem = join(dir, `${name}.smt2`);
  writeFileSync(problem, problemText(query));
  for (const [vn, vargs] of Object.entries(variants)) {
    const cvc5 = spawnSync(process.env.TSLAWS_CVC5, [...base, ...vargs, problem], { encoding: 'utf8' });
    if (cvc5.status !== 0 || !cvc5.stdout.startsWith('unsat')) {
      console.log(`${name} | ${vn} | cvc5: ${cvc5.stdout.split('\n')[0]} ${cvc5.stderr.split('\n')[0]}`);
      continue;
    }
    const proofText = cvc5.stdout.slice(cvc5.stdout.indexOf('\n') + 1);
    const proof = join(dir, `${name}.alethe`);
    writeFileSync(proof, proofText);
    const rare = rareRulesOf(proofText);
    const rest = rare.filter((r) => r !== 'ite-eq');
    const declared = rest.length > 0 ? await rareDeclarations(rest, dir, 30000) : { text: '' };
    if (declared.text === undefined) { console.log(`${name} | rare unavailable: ${declared.reason}`); continue; }
    const forms = rare.includes('ite-eq') ? Object.entries(iteEq) : [['none', '']];
    for (const [fn, text] of forms) {
      const f = join(dir, `${name}.${fn}.rare`);
      writeFileSync(f, declared.text + text);
      const c = spawnSync(process.env.TSLAWS_CARCARA, ['check', proof, problem, '--allow-int-real-subtyping', '--expand-let-bindings', ...(rare.length ? ['--rare-file', f] : [])], { encoding: 'utf8' });
      console.log(`${name} | ${vn} | ite-eq=${fn} | ${c.stdout.split('\n')[0]} | ${strip(c.stdout + c.stderr).split('\n').filter((l) => /error|note/.test(l)).slice(0, 2).join(' ; ')}`);
    }
  }
}
