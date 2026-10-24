export type LawStatus = 'proved' | 'tested' | 'open' | 'failed' | 'tampered' | 'error';

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
  /** How the prover models JavaScript numbers. */
  numbers: 'real' | 'fp';
  proofTimeoutMs: number;
}
