export type LawStatus = 'proved' | 'bounded' | 'tested' | 'open' | 'failed' | 'tampered' | 'uncovered' | 'error';

export interface ManifestLaw {
  file: string;
  name: string;
  exported: boolean;
  proved: boolean;
  line: number;
  params: string[];
  body: string;
  /** The declaration from the law's name to its end. */
  text: string;
  problems: string[];
}

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
  /** Project-relative path of a screenshot of the page at the counterexample (browser laws). */
  screenshot?: string;
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
