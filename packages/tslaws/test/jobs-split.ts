const gibibyte = 2 ** 30;

/**
 * The CPU budget (TSLAWS_JOBS) of one of `files` test processes that run side by side: the cores split between them, and no
 * more than one slot per GiB of free memory split between them as well, since a Z3 instance holds a large WebAssembly
 * heap. `src/pool.ts` takes an explicit TSLAWS_JOBS as it is, without its own memory cap, so the cap is applied here.
 * At most 8, as in `src/pool.ts`, and at least 1.
 */
export function jobsPerFile(files: number, cores: number, freeBytes: number): number {
  const byCores = Math.floor(cores / files);
  const byMemory = Math.floor(freeBytes / gibibyte / files);
  return Math.max(1, Math.min(8, byCores, byMemory));
}
