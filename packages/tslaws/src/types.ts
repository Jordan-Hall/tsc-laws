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
}
