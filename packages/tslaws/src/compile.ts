import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ManifestLaw } from './types.ts';

export interface BuildResult {
  outDir: string;
  /** Diagnostics the compiler printed; empty when the files type-check. */
  diagnostics: string;
  ok: boolean;
}

/** The compiler finds its lib files in TSC_TS_LIB_DIR; without it, use the TypeScript 7 libs scriptc ships. */
function compilerEnv(cwd: string): NodeJS.ProcessEnv {
  if (process.env.TSC_TS_LIB_DIR !== undefined) return process.env;
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
  const run = spawnSync(compiler, ['--laws-manifest', ...files], { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: compilerEnv(cwd) });
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
    '--target', 'es2022',
    '--module', 'commonjs',
    '--moduleResolution', 'bundler',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--declaration',
    '--rootDir', cwd,
    '--outDir', outDir,
    ...files,
  ];
  const run = spawnSync(compiler, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: compilerEnv(cwd) });
  if (run.error !== undefined) throw new Error(`cannot run ${compiler}: ${run.error.message}`);
  return { outDir, diagnostics: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim(), ok: run.status === 0 };
}
