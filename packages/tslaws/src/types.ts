export type LawStatus = 'proved' | 'bounded' | 'tested' | 'open' | 'failed' | 'tampered' | 'uncovered' | 'error';

export interface ManifestLaw {
  file: string;
  name: string;
  /** The exported function the law lowers to, when its name is not itself an identifier. Defaults to `name`. */
  symbol?: string;
  exported: boolean;
  proved: boolean;
  line: number;
  params: string[];
  body: string;
  /** The declaration from the law's name to its end. */
  text: string;
  problems: string[];
}

import type { Certificate, CertifyMode } from './certificates.ts';
import type { Exercised } from './exercises.ts';

export interface LawResult {
  file: string;
  name: string;
  line: number;
  status: LawStatus;
  /** How the status was reached: `smt`, `property` or a reason. */
  method: string;
  runs?: number;
  seed?: number;
  counterexample?: string;
  message?: string;
  /** The domain assumptions a `proved` or `bounded` result rests on, for the parameter types of this law only. */
  assumptions?: string[];
  /** Set when certifying was on and Z3 proved the law (`proved` or `bounded`): whether a checker accepted a proof of it. */
  certificate?: Certificate;
  /** Project-relative path of a screenshot of the page at the counterexample (browser laws). */
  screenshot?: string;
  /** The project functions the law reaches and where they are declared, for an editor to mark on both ends. */
  exercises?: Exercised[];
  /**
   * Set on a `tampered` result whose law is not (or no longer) the one in the lock: what the law would be if a person
   * accepted it. The law still ran, so a reviewer sees whether the proposal holds; the result stays `tampered`, so the
   * check still fails until the lock records the law.
   */
  proposal?: ProposalOutcome;
}

/** Why a law is a proposal, and what it did when it ran. */
export interface ProposalOutcome {
  reason: 'added' | 'changed' | 'removed' | 'level' | 'exempt';
  /** The status the law would have if accepted; `removed` and `exempt` proposals run nothing and hold trivially. */
  status: Exclude<LawStatus, 'tampered' | 'uncovered'>;
  method: string;
  counterexample?: string;
  message?: string;
  /** The certificate of the proof, for `tslaws accept` to record with the law. */
  certificate?: Certificate;
}

export interface CheckOptions {
  files: string[];
  cwd: string;
  runs: number;
  seed?: number;
  /** Path of the tsc-laws binary. */
  compiler: string;
  lockFile: string;
  /** Skip the Z3 prover. */
  noProve: boolean;
  /** Check each proof with cvc5 and Carcara; `"require"` makes a proof without a certificate an error. See certificates.ts. */
  certify?: CertifyMode;
  /** Longest array, most loop iterations and deepest recursion a proof considers. */
  bound: number;
  proofTimeoutMs: number;
  /** Longest a law's property test may run before it counts as non-terminating. Default 30000. */
  propertyTimeoutMs?: number;
  /** How long a browser law's page stays as the law left it before it is cleaned, so a watcher can see it. Default 0. */
  browserPauseMs?: number;
  /** The engine that runs browser laws. Default chromium, or `TSLAWS_BROWSER_ENGINE`. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Flags the person gave on the command line, which beat `tslaws.json`: `runs`, `property-timeout`. */
  explicit?: ('runs' | 'property-timeout')[];
  /** Skip the regression corpus: nothing is replayed and nothing is saved. */
  noRegressions?: boolean;
  /** Stored counterexamples to replay before the random search, as JSON text from `encodeExample`. Set by `check`. */
  regressionExamples?: string[];
  /** Check only the laws with these names; the others are skipped without a result or an event. */
  only?: string[];
  /** Told as the check proceeds: which laws there are, which is running, each result, and frames of a browser page. */
  onEvent?: (event: LawEvent) => void;
}

export type LawEvent =
  | { type: 'plan'; laws: { file: string; name: string; line: number }[] }
  | { type: 'start'; file: string; name: string }
  | { type: 'result'; result: LawResult }
  | { type: 'frame'; file: string; name: string; jpeg: Buffer };
