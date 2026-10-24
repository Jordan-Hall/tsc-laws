import { createInterface } from 'node:readline/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { check, exemptionsOf } from './check.ts';
import { readManifest } from './compile.ts';
import { writeLock } from './lock.ts';
import type { CheckOptions, LawResult } from './types.ts';

const usage = `tslaws check [files...] [--json] [--runs N] [--seed N] [--no-prove] [--bound N] [--proof-timeout MS] [--proposed] [--compiler PATH]
tslaws accept [files...]     record the current laws in tsc-laws.lock (people only: needs a terminal)

Without files, every *.laws.ts under the current directory is checked (*.proposed.laws.ts only with --proposed).
Exit status is 0 only when every law is proved or tested and nothing is open, failed or tampered with.`;

function discover(cwd: string, proposed: boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.tslaws' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.laws.ts') && entry.endsWith('.proposed.laws.ts') === proposed) found.push(full);
    }
  };
  walk(cwd);
  return found.map((f) => relative(cwd, f).replace(/\\/g, '/')).sort();
}

function parse(args: string[]): { command: string; flags: Map<string, string | true>; files: string[] } {
  const flags = new Map<string, string | true>();
  const files: string[] = [];
  let command = 'check';
  const valued = new Set(['runs', 'seed', 'compiler', 'bound', 'proof-timeout']);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valued.has(name)) flags.set(name, args[(i += 1)] ?? '');
      else flags.set(name, true);
    } else if (i === 0 && (arg === 'check' || arg === 'accept')) command = arg;
    else files.push(arg);
  }
  return { command, flags, files };
}

function describe(result: LawResult): string {
  const where = `${result.file}:${result.line}`;
  const head = `${result.status.toUpperCase().padEnd(8)} ${result.name} (${where}) [${result.method}]`;
  const lines = [head];
  if (result.message !== undefined) lines.push(`         ${result.message}`);
  if (result.counterexample !== undefined) lines.push(`         counterexample: ${result.counterexample}`);
  if (result.status === 'failed' && result.seed !== undefined) lines.push(`         reproduce with --seed ${result.seed}`);
  return lines.join('\n');
}

export async function main(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const { command, flags, files } = parse(args);
  const cwd = process.cwd();
  const proposed = flags.has('proposed');
  const chosen = files.length > 0 ? files.map((f) => relative(cwd, resolve(cwd, f)).replace(/\\/g, '/')) : discover(cwd, proposed);
  const options: CheckOptions = {
    files: chosen,
    cwd,
    runs: Number(flags.get('runs') ?? 200),
    seed: flags.has('seed') ? Number(flags.get('seed')) : undefined,
    compiler: String(flags.get('compiler') ?? process.env.TSC_LAWS_BIN ?? 'tsc-laws'),
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: flags.has('no-prove'),
    bound: Number(flags.get('bound') ?? 4),
    proofTimeoutMs: Number(flags.get('proof-timeout') ?? 5000),
  };
  if (chosen.length === 0) {
    process.stderr.write('no laws files found (looking for *.laws.ts)\n');
    return 1;
  }

  if (command === 'accept') {
    if (!process.stdin.isTTY || process.env.TSLAWS_AGENT !== undefined || process.env.CI !== undefined) {
      process.stderr.write('accept records laws as correct and needs a person at a terminal; it will not run here\n');
      return 1;
    }
    const laws = readManifest(options.compiler, options.files, cwd);
    process.stdout.write(`${laws.length} laws in ${chosen.length} files:\n${laws.map((l) => `  ${l.file}:${l.line} ${l.name}`).join('\n')}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type ACCEPT to write tsc-laws.lock: ');
    rl.close();
    if (answer.trim() !== 'ACCEPT') return 1;
    const exempt = exemptionsOf(options);
    if (exempt.length > 0) process.stdout.write(`exempt from coverage:\n${exempt.map((e) => `  ${e}`).join('\n')}\n`);
    writeLock(options.lockFile, laws, exempt);
    process.stdout.write('tsc-laws.lock written\n');
    return 0;
  }

  const report = await check(options, !proposed);
  if (flags.has('json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }
  if (report.compileDiagnostics !== '') process.stdout.write(`${report.compileDiagnostics}\n\n`);
  if (report.lockMissing) process.stdout.write('tsc-laws.lock is missing: a person must run `tslaws accept`\n\n');
  for (const result of report.results) process.stdout.write(`${describe(result)}\n`);
  const count = (status: string): number => report.results.filter((r) => r.status === status).length;
  process.stdout.write(
    `\n${report.results.length} laws: ${count('proved')} proved, ${count('bounded')} bounded, ${count('tested')} tested, ${count('open')} open, ${count('failed')} failed, ${count('tampered')} tampered, ${count('error')} errors\n`,
  );
  return report.ok ? 0 : 1;
}
