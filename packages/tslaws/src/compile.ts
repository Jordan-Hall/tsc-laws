import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ManifestLaw } from './types.ts';

export interface BuildResult {
  outDir: string;
  /** Diagnostics the compiler printed; empty when the files type-check. */
  diagnostics: string;
  ok: boolean;
}

/**
 * Runs the compiler, trying again when the system could not start it. On Windows a freshly built executable can be
 * briefly unavailable (a scanner holds it, the machine is out of handles), which surfaces as ENOENT or UNKNOWN.
 */
function launch(
  compiler: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  let run = spawnSync(compiler, args, options);
  for (
    let attempt = 0;
    attempt < 4 && run.error !== undefined && /UNKNOWN|EBUSY|EAGAIN|EMFILE/.test(String(run.error));
    attempt += 1
  ) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (attempt + 1));
    run = spawnSync(compiler, args, options);
  }
  return run;
}

/** The compiler finds its lib files in TSC_TS_LIB_DIR; without it, use the TypeScript 7 libs scriptc ships. */
function compilerEnv(cwd: string, compiler: string): NodeJS.ProcessEnv {
  if (process.env.TSC_TS_LIB_DIR !== undefined) return process.env;
  // The npm compiler package keeps the lib files beside the executable.
  const beside = dirname(compiler);
  if (existsSync(join(beside, 'lib.d.ts'))) return { ...process.env, TSC_TS_LIB_DIR: beside };
  for (let dir = cwd; ; dir = dirname(dir)) {
    const scope = join(dir, 'node_modules', '@scriptc');
    if (existsSync(scope)) {
      for (const entry of readdirSync(scope)) {
        const lib = join(scope, entry, 'dist', 'lib', 'typescript', 'lib');
        if (existsSync(join(lib, 'lib.d.ts'))) return { ...process.env, TSC_TS_LIB_DIR: lib };
      }
    }
    if (dirname(dir) === dir) return process.env;
  }
}

/** Lists the laws of `files` with the problems that stop them running. */
export function readManifest(compiler: string, files: string[], cwd: string): ManifestLaw[] {
  const run = launch(compiler, ['--laws-manifest', ...files], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    env: compilerEnv(cwd, compiler),
  });
  if (run.error !== undefined) throw new Error(`cannot run ${compiler}: ${run.error.message}`);
  const text = (run.stdout ?? '').trim();
  if (text === '') throw new Error(`${compiler} --laws-manifest printed nothing: ${run.stderr ?? ''}`);
  return (JSON.parse(text) as { laws: ManifestLaw[] }).laws;
}

/** Compiles `files` to CommonJS plus declarations in `.tslaws/out` under `cwd`, so `node_modules` still resolves. */
export function build(compiler: string, files: string[], cwd: string): BuildResult {
  const outDir = join(cwd, '.tslaws', 'out');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // The output is CommonJS whatever the project's own package.json says.
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const args = [
    '--ignoreConfig',
    '--target',
    'es2022',
    '--module',
    'commonjs',
    '--moduleResolution',
    'bundler',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--declaration',
    '--rootDir',
    cwd,
    '--outDir',
    outDir,
    ...files,
  ];
  let run = launch(compiler, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: compilerEnv(cwd, compiler) });
  // A compiler that dies without a word (out of memory on a busy machine) is run again; a type error always says so.
  for (
    let attempt = 0;
    attempt < 2 &&
    run.error === undefined &&
    run.status !== 0 &&
    `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() === '';
    attempt += 1
  )
    run = launch(compiler, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: compilerEnv(cwd, compiler) });
  if (run.error !== undefined) throw new Error(`cannot run ${compiler}: ${run.error.message}`);
  return { outDir, diagnostics: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim(), ok: run.status === 0 };
}
