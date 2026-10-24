import type { LawResult } from './types.ts';

/** The concrete next action for an agent that reads a result, or undefined when nothing needs doing. */
export function hintFor(result: LawResult): string | undefined {
  switch (result.status) {
    case 'proved':
      return undefined;
    case 'failed': {
      const seed = result.seed !== undefined ? ` Reproduce with \`--seed ${result.seed}\`.` : '';
      const example = result.counterexample !== undefined ? ` The counterexample is ${result.counterexample}.` : '';
      return `The code breaks this law.${example} Fix the code, not the law, then rerun.${seed}`;
    }
    case 'open':
      return (
        'Declared `proved` but no proof for every input was found' +
        `${result.message !== undefined ? ` (${firstLine(result.message)})` : ''}. ` +
        'Make the code provable: use int or bigint for whole numbers, boolean, string and records with const/if/return and calls; ' +
        'remove the unsupported construct the message names; arrays and loops only reach `bounded`. ' +
        'If the law cannot be proved, ask a person to drop `proved` from it. Do not edit the law yourself.'
      );
    case 'bounded':
      return (
        `Proved only within bounds${result.message !== undefined ? ` (${firstLine(result.message)})` : ''}: ` +
        'array length and loop iterations up to --bound (default 4), int values within +-2^26. ' +
        'Raise the array and loop bound with `--bound N`. Passing; no action needed unless a person wants a full proof.'
      );
    case 'tested':
      return (
        `Only property-tested${result.runs !== undefined ? ` (${result.runs} runs)` : ''}, not proved: ` +
        `the prover did not lower this law${result.method !== 'property' && result.method !== '' ? ` (${firstLine(result.method)})` : ''}. ` +
        'Passing; to get a proof, restrict the code to int/bigint/boolean/string and simple control flow. More inputs: `--runs N`.'
      );
    case 'uncovered':
      return (
        'No law reaches this exported code. Ask a person for a law, or write a proposal in a `*.proposed.laws.ts` file ' +
        'and try it with `tslaws check --proposed`. Never edit a `*.laws.ts` file or add `@tslaws-exempt` yourself.'
      );
    case 'tampered':
      return (
        'A law or coverage exemption differs from tsc-laws.lock. Never edit laws or the lock, and never run `tslaws accept`. ' +
        'Undo any change you made to laws or exemptions; if the change is intended, tell the person to review it and run `tslaws accept`.'
      );
    case 'error':
      return `The law could not run${result.message !== undefined ? `: ${firstLine(result.message)}` : ''}. Fix the cause in the code. If the law itself is at fault (not exported, untyped parameter), do not edit it; tell the person.`;
  }
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}
