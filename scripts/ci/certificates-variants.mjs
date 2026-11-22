// TEMPORARY diagnostics: tries cvc5 and Carcara option sets on each problem and prints one line per combination.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const problems = JSON.parse(readFileSync('packages/tslaws/test/certificates.problems.json', 'utf8'));
const { problemText, rareRulesOf, rareDeclarations } = await import('../../packages/tslaws/dist/certificates.js');
const base = ['--lang', 'smt2', '--dump-proofs', '--proof-format-mode=alethe', '--tlimit', '10000'];
const variants = {
  current: ['--proof-granularity=dsl-rewrite', '--proof-alethe-res-pivots', '--dag-thresh=0', '--simplification=none', '--enum-inst-interleave', '--cegqi-all'],
  'no-res-pivots': ['--proof-granularity=dsl-rewrite', '--dag-thresh=0', '--simplification=none', '--enum-inst-interleave', '--cegqi-all'],
  'theory-rewrite': ['--proof-granularity=theory-rewrite', '--proof-alethe-res-pivots', '--dag-thresh=0', '--simplification=none', '--enum-inst-interleave', '--cegqi-all'],
  'theory-rewrite-nopivots': ['--proof-granularity=theory-rewrite', '--dag-thresh=0', '--simplification=none', '--enum-inst-interleave', '--cegqi-all'],
  'dsl+elim-subtypes': ['--proof-granularity=dsl-rewrite', '--proof-elim-subtypes', '--proof-alethe-res-pivots', '--dag-thresh=0', '--simplification=none', '--enum-inst-interleave', '--cegqi-all'],
  'dsl+pivots-only': ['--proof-granularity=dsl-rewrite', '--proof-alethe-res-pivots'],
  'default-granularity': ['--proof-alethe-res-pivots', '--dag-thresh=0', '--simplification=none'],
  'bare': [],
  'simp-none-only': ['--simplification=none', '--dag-thresh=0'],
};
const carcaras = {
  current: ['--allow-int-real-subtyping', '--expand-let-bindings'],
  'no-expand': ['--allow-int-real-subtyping'],
  'ignore-unknown': ['--allow-int-real-subtyping', '--expand-let-bindings', '--ignore-unknown-rules'],
};
const dir = mkdtempSync(join(tmpdir(), 'cert-var-'));
const tag = (n) => n.replace(/\W/g, '_');
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
    const proof = join(dir, `${name}.${tag(vn)}.alethe`);
    writeFileSync(proof, proofText);
    const rare = rareRulesOf(proofText);
    const extra = [];
    let note = '';
    if (rare.length > 0) {
      const declared = await rareDeclarations(rare, dir, 30000);
      if (declared.text === undefined) note = ` [rare unavailable: ${declared.reason}]`;
      else {
        const f = join(dir, `${name}.${tag(vn)}.rare`);
        writeFileSync(f, declared.text);
        extra.push('--rare-file', f);
      }
    }
    for (const [cn, cargs] of Object.entries(carcaras)) {
      const c = spawnSync(process.env.TSLAWS_CARCARA, ['check', proof, problem, ...cargs, ...extra], { encoding: 'utf8' });
      const err = (c.stdout + c.stderr).split('\n').filter((l) => /error|pivot|not found|unknown/i.test(l)).slice(0, 1).join('').replace(/\u001b\[[0-9;]*m/g, '').trim();
      console.log(`${name} | ${vn} | ${cn} | ${c.stdout.split('\n')[0]} ${err}${note}`);
    }
  }
}
