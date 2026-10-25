// Mutation testing: change the covered code in small ways and re-run the laws. A mutant that no law fails
// (SURVIVED) shows the laws cannot tell that behaviour apart; a failed, erroring or timed-out check KILLS it.
// Every mutant is checked in a scratch copy of the project under .tslaws/mutants/<n>; the originals are never written.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { check } from './check.ts';
import { coverFiles, readConfig } from './coverage.ts';
import { mutateDefaults } from './settings.ts';
import type { CheckOptions } from './types.ts';

export interface Mutant {
  file: string;
  line: number;
  /** Offsets of the replaced text in the original file. */
  start: number;
  end: number;
  replacement: string;
  original: string;
  mutated: string;
}

export interface MutantResult extends Mutant {
  status: 'killed' | 'survived' | 'skipped';
  /** Why a killed mutant died, or why one was skipped. */
  reason?: string;
}

export interface MutateOptions {
  cwd: string;
  /** The laws files, as `tslaws check` takes them. */
  lawFiles: string[];
  /** Restrict mutation to these covered files; empty mutates every covered file. */
  targets?: string[];
  compiler: string;
  max: number;
  /** True when the person named law files: only the sources those laws reach are mutated. */
  lawsNamed?: boolean;
  seed?: number;
  /** Run settings as `check` takes them; unset ones come from tslaws.json, then the mutate defaults (30 runs). */
  runs?: number;
  bound?: number;
  proofTimeoutMs?: number;
  propertyTimeoutMs?: number;
  browser?: CheckOptions['browser'];
  onProgress?: (line: string) => void;
}

export interface MutateReport {
  results: MutantResult[];
  killed: number;
  survived: number;
  skipped: number;
  /** Percent of tried mutants killed; 100 when none were tried. */
  score: number;
  /** Set when the unmutated project's laws do not pass, so mutation testing means nothing. */
  baselineError?: string;
  ok: boolean;
}

const ignoredDirs = new Set(['node_modules', '.tslaws', '.git']);
const sourceExt = /\.(ts|tsx|mts|cts)$/;
const copiedExt = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;

const relational: Record<number, string[]> = {
  [ts.SyntaxKind.LessThanToken]: ['<=', '>='],
  [ts.SyntaxKind.LessThanEqualsToken]: ['<', '>'],
  [ts.SyntaxKind.GreaterThanToken]: ['>=', '<='],
  [ts.SyntaxKind.GreaterThanEqualsToken]: ['>', '<'],
  [ts.SyntaxKind.EqualsEqualsToken]: ['!='],
  [ts.SyntaxKind.ExclamationEqualsToken]: ['=='],
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: ['!=='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ['==='],
  [ts.SyntaxKind.PlusToken]: ['-'],
  [ts.SyntaxKind.MinusToken]: ['+'],
  [ts.SyntaxKind.AsteriskToken]: ['/'],
  [ts.SyntaxKind.SlashToken]: ['*'],
  [ts.SyntaxKind.AmpersandAmpersandToken]: ['||'],
  [ts.SyntaxKind.BarBarToken]: ['&&'],
};

/** The source files the laws cover: the `cover` globs, or every project module the laws import. */
export function mutableFiles(cwd: string, lawFiles: string[], reachOnly = false): string[] {
  const globs = readConfig(cwd).cover ?? [];
  const isLaws = (f: string): boolean => f.endsWith('.laws.ts');
  const found = new Set<string>();
  const reached = new Set<string>();
  if (globs.length > 0 && !reachOnly) for (const f of coverFiles(cwd, globs)) found.add(f);
  else {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const full = join(cwd, file);
      if (!existsSync(full)) return;
      for (const imp of ts.preProcessFile(readFileSync(full, 'utf8'), true, true).importedFiles) {
        if (!imp.fileName.startsWith('.')) continue;
        const base = join(dirname(file), imp.fileName).replaceAll('\\', '/');
        const stem = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '');
        const hit = [
          base,
          `${stem}.ts`,
          `${stem}.tsx`,
          `${stem}.mts`,
          `${stem}.cts`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
        ].find((c) => sourceExt.test(c) && existsSync(join(cwd, c)) && statSync(join(cwd, c)).isFile());
        if (hit === undefined) continue;
        if (!isLaws(hit)) found.add(hit);
        visit(hit);
      }
    };
    for (const f of lawFiles) visit(f);
    // Named laws with a `cover` list: mutate only the covered files those laws reach.
    if (globs.length > 0) {
      const covered = new Set(coverFiles(cwd, globs));
      for (const f of found) if (covered.has(f)) reached.add(f);
      found.clear();
      for (const f of reached) found.add(f);
    }
  }
  return [...found]
    .filter((f) => !/\.d\.(ts|mts|cts)$/.test(f) && !isLaws(f) && !/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(f))
    .filter((f) => !f.split('/').some((p) => p === 'test' || p === 'tests' || p === '__tests__'))
    .sort();
}

/** Every mutation of one file, in source order. */
export function mutantsOf(file: string, text: string): Mutant[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, kind);
  const out: Mutant[] = [];
  const add = (node: ts.Node, start: number, end: number, replacement: string): void => {
    const ns = node.getStart(source);
    const ne = node.getEnd();
    const snip = (s: string): string => {
      const flat = s.replace(/\s+/g, ' ').trim();
      return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
    };
    out.push({
      file,
      line: source.getLineAndCharacterOfPosition(start).line + 1,
      start,
      end,
      replacement,
      original: snip(text.slice(ns, ne)),
      mutated: snip(text.slice(ns, start) + replacement + text.slice(end, ne)),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken;
      for (const op of relational[token.kind] ?? []) add(node, token.getStart(source), token.getEnd(), op);
    } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      add(node, node.getStart(source), node.getEnd(), node.kind === ts.SyntaxKind.TrueKeyword ? 'false' : 'true');
    } else if (ts.isNumericLiteral(node)) {
      const v = Number(node.text);
      const wrap = (n: number): string => (n < 0 ? `(${n})` : String(n));
      for (const n of new Set([v + 1, v - 1, 0])) {
        if (n !== v && Number.isFinite(n)) add(node, node.getStart(source), node.getEnd(), wrap(n));
      }
    } else if (ts.isIfStatement(node)) {
      const c = node.expression;
      add(node.expression, c.getStart(source), c.getEnd(), `!(${c.getText(source)})`);
    } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      add(node, node.getStart(source), node.operand.getStart(source), '');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** At most `max` mutants: all of them when they fit, else a seeded sample kept in source order. */
export function sample<T>(all: T[], max: number, seed: number): T[] {
  if (all.length <= max) return all;
  const rand = prng(seed);
  const idx = all.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx
    .slice(0, max)
    .sort((a, b) => a - b)
    .map((i) => all[i]!);
}

function copyProject(cwd: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (ignoredDirs.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (copiedExt.test(entry) || entry === 'tsc-laws.lock') {
        const dest = join(to, relative(cwd, full));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(full, dest);
      }
    }
  };
  walk(cwd);
}

export async function mutate(options: MutateOptions): Promise<MutateReport> {
  const { cwd } = options;
  const say = options.onProgress ?? (() => undefined);
  const scratchRoot = join(cwd, '.tslaws', 'mutants');
  const config = readConfig(cwd);
  const checkOptions = (dir: string): CheckOptions => ({
    files: options.lawFiles,
    cwd: dir,
    runs: options.runs ?? config.runs ?? mutateDefaults.runs,
    seed: options.seed,
    compiler: options.compiler,
    lockFile: join(dir, 'tsc-laws.lock'),
    noProve: false,
    bound: options.bound ?? config.bound ?? mutateDefaults.bound,
    proofTimeoutMs: options.proofTimeoutMs ?? config.proofTimeoutMs ?? mutateDefaults.proofTimeoutMs,
    propertyTimeoutMs: options.propertyTimeoutMs ?? config.propertyTimeoutMs ?? mutateDefaults.propertyTimeoutMs,
    browser: options.browser,
    // The lock is not enforced on mutants; it is copied so the scratch project is complete.
    explicit: options.runs === undefined ? [] : ['runs'],
  });
  const empty = (baselineError?: string): MutateReport => ({
    results: [],
    killed: 0,
    survived: 0,
    skipped: 0,
    score: 100,
    baselineError,
    ok: baselineError === undefined,
  });

  try {
    // The unmutated copy must pass, or every mutant would count as killed.
    const baseDir = join(scratchRoot, '0');
    copyProject(cwd, baseDir);
    const base = await check(checkOptions(baseDir), false);
    if (!base.compileOk) return empty(`the project does not compile:\n${base.compileDiagnostics}`);
    if (!base.ok) {
      const failing = base.results.find(
        (r) => r.status !== 'proved' && r.status !== 'bounded' && r.status !== 'tested',
      );
      const first = failing?.message?.split(/\r?\n/)[0];
      const which =
        failing === undefined
          ? 'unknown'
          : `${failing.name} (${failing.file}:${failing.line}) is ${failing.status}${first === undefined ? '' : `: ${first}`}`;
      return empty(
        `the laws do not pass on the unmutated code; fix them before mutation testing. First failure: ${which}. If it timed out, raise --proof-timeout or --property-timeout (or set them in tslaws.json)`,
      );
    }

    const wanted = new Set((options.targets ?? []).map((t) => t.replaceAll('\\', '/')));
    const files = mutableFiles(cwd, options.lawFiles, options.lawsNamed === true).filter(
      (f) => wanted.size === 0 || wanted.has(f),
    );
    const originals = new Map(files.map((f) => [f, readFileSync(join(cwd, f), 'utf8')]));
    const all = files.flatMap((f) => mutantsOf(f, originals.get(f)!));
    const chosen = sample(all, options.max, options.seed ?? 1);
    say(`${chosen.length} of ${all.length} mutants in ${files.length} files`);

    const results: MutantResult[] = [];
    for (const [n, mutant] of chosen.entries()) {
      const dir = join(scratchRoot, String(n + 1));
      let result: MutantResult;
      try {
        copyProject(cwd, dir);
        const text = originals.get(mutant.file)!;
        writeFileSync(
          join(dir, mutant.file),
          text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end),
        );
        const report = await check(checkOptions(dir), false);
        if (!report.compileOk) result = { ...mutant, status: 'skipped', reason: 'does not compile' };
        else if (report.ok) result = { ...mutant, status: 'survived' };
        else {
          const failing = report.results.find(
            (r) => r.status !== 'proved' && r.status !== 'bounded' && r.status !== 'tested',
          );
          result = {
            ...mutant,
            status: 'killed',
            reason: failing === undefined ? 'check failed' : `${failing.name}: ${failing.status}`,
          };
        }
      } catch (error) {
        result = {
          ...mutant,
          status: 'killed',
          reason: `check errored: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      results.push(result);
      say(
        `[${n + 1}/${chosen.length}] ${result.status} ${mutant.file}:${mutant.line} ${mutant.original} -> ${mutant.mutated}`,
      );
    }
    const killed = results.filter((r) => r.status === 'killed').length;
    const survived = results.filter((r) => r.status === 'survived').length;
    const tried = killed + survived;
    return {
      results,
      killed,
      survived,
      skipped: results.length - tried,
      score: tried === 0 ? 100 : Math.round((killed / tried) * 1000) / 10,
      ok: survived === 0,
    };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

export function renderMutation(report: MutateReport): string {
  if (report.baselineError !== undefined) return `mutation testing not run: ${report.baselineError}\n`;
  let text = '';
  for (const r of report.results.filter((x) => x.status === 'survived')) {
    text += `SURVIVED ${r.file}:${r.line}  ${r.original}  ->  ${r.mutated}\n  hint: add or strengthen a law that tells these apart\n`;
  }
  const tried = report.killed + report.survived;
  return `${text}${text === '' ? '' : '\n'}mutation score ${report.score}% (${report.killed} killed, ${report.survived} survived of ${tried} tried, ${report.skipped} skipped)\n`;
}
