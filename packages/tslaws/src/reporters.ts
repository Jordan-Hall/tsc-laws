import { appendFileSync } from 'node:fs';
import type { CheckReport } from './check.ts';
import { hintFor } from './hints.ts';
import type { LawResult } from './types.ts';

/** The values of `tslaws check --reporter`. `text` and `json` are rendered by the CLI itself. */
export const reporterNames = ['text', 'json', 'junit', 'github'] as const;
export type ReporterName = (typeof reporterNames)[number];

const passing = new Set(['proved', 'bounded', 'tested']);
const isPassing = (result: LawResult): boolean => passing.has(result.status);

/** Whether XML 1.0 can carry the code point at all. */
function xmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Escape text for XML, dropping characters XML 1.0 cannot carry at all. */
export function escapeXml(text: string): string {
  let kept = '';
  for (const char of text) if (xmlChar(char.codePointAt(0)!)) kept += char;
  return kept
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Escape an attribute value: as text, plus the whitespace a parser would normalise away. */
export function escapeAttr(text: string): string {
  return escapeXml(text).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

/** Escape a workflow command message (the text after `::`). */
export function escapeGithubData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a workflow command property value. */
export function escapeGithubProperty(text: string): string {
  return escapeGithubData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** The one-line account of why a result is not passing (or what a passing one is). */
function detail(result: LawResult): string {
  const parts: string[] = [];
  if (result.message !== undefined) parts.push(result.message);
  if (result.counterexample !== undefined) parts.push(`counterexample ${result.counterexample}`);
  if (result.status === 'failed' && result.seed !== undefined) parts.push(`seed ${result.seed}`);
  return parts.join('; ');
}

function failureText(result: LawResult): string {
  const lines = [`${result.status.toUpperCase()} ${result.name} (${result.file}:${result.line}) [${result.method}]`];
  if (result.message !== undefined) lines.push(result.message);
  if (result.counterexample !== undefined) lines.push(`counterexample: ${result.counterexample}`);
  const hint = hintFor(result);
  if (hint !== undefined) lines.push(`hint: ${hint}`);
  return lines.join('\n');
}

/** JUnit XML: one `testsuite` per law file, one `testcase` per law. */
export function junit(report: CheckReport): string {
  const byFile = new Map<string, LawResult[]>();
  for (const result of report.results) {
    const list = byFile.get(result.file);
    if (list === undefined) byFile.set(result.file, [result]);
    else list.push(result);
  }
  const compileFailed = !report.compileOk || report.compileDiagnostics !== '';
  const extra: string[] = [];
  if (compileFailed) extra.push(`compile diagnostics:\n${report.compileDiagnostics}`);
  if (report.lockMissing) extra.push('tsc-laws.lock is missing: a person must run `tslaws accept`');

  const suites: string[] = [];
  let tests = 0;
  let failures = 0;
  const open = (name: string, count: number, failed: number): string =>
    `  <testsuite name="${escapeAttr(name)}" tests="${count}" failures="${failed}" errors="0" skipped="0">`;
  if (extra.length > 0) {
    const body = escapeXml(extra.join('\n'));
    suites.push(
      `${open('tslaws', 1, 1)}\n    <testcase classname="tslaws" name="project">\n      <failure message="${escapeAttr(extra[0]!.split('\n')[0]!)}">${body}</failure>\n    </testcase>\n  </testsuite>`,
    );
    tests += 1;
    failures += 1;
  }
  for (const [file, results] of byFile) {
    const failed = results.filter((r) => !isPassing(r));
    const cases = results.map((r) => {
      const head = `    <testcase classname="${escapeAttr(file)}" name="${escapeAttr(r.name)}"`;
      if (isPassing(r)) return `${head}/>`;
      const summary = [r.status, detail(r)].filter((s) => s !== '').join(': ');
      return `${head}>\n      <failure message="${escapeAttr(summary)}" type="${r.status}">${escapeXml(failureText(r))}</failure>\n    </testcase>`;
    });
    tests += results.length;
    failures += failed.length;
    suites.push(`${open(file, results.length, failed.length)}\n${cases.join('\n')}\n  </testsuite>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="tslaws" tests="${tests}" failures="${failures}" errors="0">\n${suites.join('\n')}\n</testsuites>\n`;
}

function command(kind: 'error' | 'notice', props: Record<string, string>, message: string): string {
  const list = Object.entries(props)
    .map(([k, v]) => `${k}=${escapeGithubProperty(v)}`)
    .join(',');
  return `::${kind} ${list}::${escapeGithubData(message)}`;
}

/** GitHub Actions workflow commands: an annotation per failing result and a notice for bounded or tested ones. */
export function github(report: CheckReport): string {
  const lines: string[] = [];
  if (report.compileDiagnostics !== '') {
    lines.push(
      `::error title=${escapeGithubProperty('tslaws compile')}::${escapeGithubData(report.compileDiagnostics)}`,
    );
  }
  if (report.lockMissing) {
    lines.push(
      `::error title=${escapeGithubProperty('tslaws lock')}::${escapeGithubData('tsc-laws.lock is missing: a person must run `tslaws accept`')}`,
    );
  }
  for (const result of report.results) {
    const props: Record<string, string> = { file: result.file };
    if (result.line > 0) props.line = String(result.line);
    props.title = `${result.name} ${result.status}`;
    if (!isPassing(result)) {
      const hint = hintFor(result);
      const message = [detail(result) || result.status, hint !== undefined ? `hint: ${hint}` : undefined]
        .filter((s): s is string => s !== undefined)
        .join('\n');
      lines.push(command('error', props, message));
    } else if (result.status !== 'proved') {
      lines.push(command('notice', props, detail(result) || `${result.name} is ${result.status}, not proved`));
    }
  }
  const proved = report.results.filter((r) => r.status === 'proved').length;
  const failing = report.results.filter((r) => !isPassing(r)).length;
  lines.push(`tslaws: ${report.results.length} laws, ${proved} proved, ${failing} failing`);
  return `${lines.join('\n')}\n`;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** A markdown table of the results, for `GITHUB_STEP_SUMMARY`. */
export function githubSummary(report: CheckReport): string {
  const rows = report.results.map(
    (r) =>
      `| ${r.status} | ${cell(r.name)} | ${cell(`${r.file}:${r.line}`)} | ${cell(r.method)} | ${cell(detail(r))} |`,
  );
  const verdict = report.ok ? 'passed' : 'failed';
  return `### tslaws: ${verdict}\n\n| Status | Law | Location | Method | Detail |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}${rows.length > 0 ? '\n' : ''}\n`;
}

/** Append the step-summary table to the file named by `GITHUB_STEP_SUMMARY`, when set. */
export function writeStepSummary(report: CheckReport, env: NodeJS.ProcessEnv = process.env): void {
  const path = env.GITHUB_STEP_SUMMARY;
  if (path === undefined || path === '') return;
  appendFileSync(path, githubSummary(report));
}

/** Render a report with `junit` or `github`. */
export function reportAs(name: 'junit' | 'github', report: CheckReport, env: NodeJS.ProcessEnv = process.env): string {
  if (name === 'junit') return junit(report);
  writeStepSummary(report, env);
  return github(report);
}
