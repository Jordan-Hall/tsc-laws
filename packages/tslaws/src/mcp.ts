// `tslaws mcp`: a Model Context Protocol server over stdio (JSON-RPC 2.0, one message per line).
//
// Safety property: an agent that talks to this server can run checks and write PROPOSED laws, nothing else. No tool
// accepts laws, writes tsc-laws.lock or edits a `*.laws.ts` file that is not a `*.proposed.laws.ts`; the server sets
// TSLAWS_AGENT so nothing it spawns can run `accept` either. A person promotes proposals with `tslaws promote`.
// stdout is the protocol channel: this module writes nothing else to it.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { check } from './check.ts';
import { readConfig } from './coverage.ts';
import type { CheckReport } from './check.ts';
import { hintFor } from './hints.ts';
import { parseLawFile } from './promote.ts';
import { resolveSettings } from './settings.ts';
import type { CheckOptions, LawResult } from './types.ts';

const ignoredDirs = new Set(['node_modules', '.tslaws', '.git']);
const passing = new Set(['proved', 'bounded', 'tested']);
const supportedVersions = ['2025-06-18', '2025-03-26', '2024-11-05'];
const defaultProposalFile = 'agent.proposed.laws.ts';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const tools: Tool[] = [
  {
    name: 'tslaws_check',
    description:
      'Check the accepted laws (*.laws.ts) of the project, as `tslaws check --json`: each result has a status and a hint with the next action. Never changes any file the person owns.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'laws files to check; default: all' },
        summary: { type: 'boolean', description: 'only the laws that do not pass, and the totals' },
      },
    },
  },
  {
    name: 'tslaws_check_proposed',
    description: 'Check the proposed laws (*.proposed.laws.ts), as `tslaws check --proposed`.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tslaws_explain',
    description:
      'Show a law: its source, its status and hint from the last check in this session, and the next action.',
    inputSchema: {
      type: 'object',
      properties: { law: { type: 'string', description: 'the law name' } },
      required: ['law'],
    },
  },
  {
    name: 'tslaws_propose',
    description:
      'Write a law into a *.proposed.laws.ts file (appended; a law of the same name is replaced) and check it. Only proposed files can be written. A person promotes proposals with `tslaws promote`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the law name' },
        source: { type: 'string', description: 'the full `export law ...` declaration, with any imports it needs' },
        file: {
          type: 'string',
          description: `project-relative *.proposed.laws.ts path; default ${defaultProposalFile}`,
        },
      },
      required: ['name', 'source'],
    },
  },
];

export interface McpOptions {
  cwd: string;
  compiler: string;
}

class ToolError extends Error {}

function slash(path: string): string {
  return path.replace(/\\/g, '/');
}

function discover(cwd: string, proposed: boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (ignoredDirs.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.laws.ts') && entry.endsWith('.proposed.laws.ts') === proposed) found.push(full);
    }
  };
  walk(cwd);
  return found.map((f) => slash(relative(cwd, f))).sort();
}

/** A project-relative path inside the root that names an existing or new file; throws ToolError otherwise. */
function insideRoot(cwd: string, file: string): string {
  if (isAbsolute(file)) throw new ToolError(`'${file}' must be relative to the project root`);
  const full = resolve(cwd, file);
  const rel = relative(cwd, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new ToolError(`'${file}' is outside the project`);
  if (rel.split(sep).some((part) => ignoredDirs.has(part))) throw new ToolError(`'${file}' is in a reserved directory`);
  // A symlinked directory must not lead out of the project either.
  let probe = dirname(full);
  while (!existsSync(probe)) probe = dirname(probe);
  const back = relative(realpathSync(cwd), realpathSync(probe));
  if (back.startsWith('..') || isAbsolute(back)) throw new ToolError(`'${file}' is outside the project`);
  return full;
}

/** The only files a tool may write. */
export function proposalPath(cwd: string, file: string): string {
  if (!file.endsWith('.proposed.laws.ts') || file.endsWith('/.proposed.laws.ts'))
    throw new ToolError(`'${file}' is not a *.proposed.laws.ts file; only proposed laws can be written`);
  return insideRoot(cwd, file);
}

function options(opts: McpOptions, files: string[]): CheckOptions {
  const settings = resolveSettings(new Map(), readConfig(opts.cwd));
  return {
    files,
    cwd: opts.cwd,
    runs: settings.runs,
    compiler: opts.compiler,
    lockFile: join(opts.cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: settings.bound,
    proofTimeoutMs: settings.proofTimeoutMs,
    propertyTimeoutMs: settings.propertyTimeoutMs,
  };
}

function withHints(report: CheckReport): unknown {
  return { ...report, results: report.results.map((r) => ({ ...r, hint: hintFor(r) })) };
}

function totals(report: CheckReport): string {
  const count = (status: string): number => report.results.filter((r) => r.status === status).length;
  return `${report.results.length} laws: ${count('proved')} proved, ${count('bounded')} bounded, ${count('tested')} tested, ${count('open')} open, ${count('failed')} failed, ${count('tampered')} tampered, ${count('error')} errors`;
}

function summarised(report: CheckReport): unknown {
  const full = withHints(report) as { results: (LawResult & { hint?: string })[] };
  return { ...full, results: full.results.filter((r) => !passing.has(r.status)), totals: totals(report) };
}

export class Session {
  private readonly last = new Map<string, LawResult>();

  private readonly opts: McpOptions;

  constructor(opts: McpOptions) {
    this.opts = opts;
  }

  private remember(report: CheckReport): void {
    for (const r of report.results) this.last.set(r.name, r);
  }

  private async run(files: string[], enforceLock: boolean): Promise<CheckReport> {
    if (files.length === 0)
      throw new ToolError(
        `no ${enforceLock ? '' : 'proposed '}laws files found (looking for *.${enforceLock ? '' : 'proposed.'}laws.ts)`,
      );
    const report = await check(options(this.opts, files), enforceLock);
    this.remember(report);
    return report;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { cwd } = this.opts;
    switch (name) {
      case 'tslaws_check': {
        const given = args.files;
        if (given !== undefined && (!Array.isArray(given) || given.some((f) => typeof f !== 'string')))
          throw new ToolError('files must be an array of strings');
        const files =
          given === undefined || given.length === 0
            ? discover(cwd, false)
            : (given as string[]).map((f) => slash(relative(cwd, insideRoot(cwd, f))));
        const report = await this.run(files, true);
        return args.summary === true ? summarised(report) : withHints(report);
      }
      case 'tslaws_check_proposed':
        return withHints(await this.run(discover(cwd, true), false));
      case 'tslaws_explain': {
        if (typeof args.law !== 'string' || args.law === '') throw new ToolError('law must be a law name');
        const sources: { file: string; source: string; line: number }[] = [];
        for (const file of [...discover(cwd, false), ...discover(cwd, true)]) {
          const text = readFileSync(join(cwd, file), 'utf8');
          for (const law of parseLawFile(text).laws)
            if (law.name === args.law)
              sources.push({ file, source: law.text, line: text.slice(0, law.start).split('\n').length });
        }
        const result = this.last.get(args.law);
        if (sources.length === 0 && result === undefined) throw new ToolError(`no law named '${args.law}'`);
        return {
          law: args.law,
          declarations: sources,
          lastResult: result === undefined ? null : { ...result, hint: hintFor(result) },
          nextAction:
            result === undefined
              ? 'Run tslaws_check (or tslaws_check_proposed for a proposal) to see its status.'
              : (hintFor(result) ?? 'Nothing to do: the law is proved.'),
        };
      }
      case 'tslaws_propose': {
        if (typeof args.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(args.name))
          throw new ToolError('name must be an identifier');
        if (typeof args.source !== 'string') throw new ToolError('source must be a string');
        const file = slash(typeof args.file === 'string' ? args.file : defaultProposalFile);
        const target = proposalPath(cwd, file);
        const proposal = parseLawFile(args.source);
        const mine = proposal.laws.find((l) => l.name === args.name);
        if (mine === undefined) throw new ToolError(`source must contain \`export law ${args.name}\`…`);
        let rest = args.source;
        for (const part of [...proposal.laws, ...proposal.imports.map((text) => ({ text }))])
          rest = rest.replace(part.text, '');
        if (rest.trim() !== '') throw new ToolError('source may contain only imports and law declarations');
        const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, mergeProposal(current, proposal.imports, proposal.laws));
        const report = await this.run([file], false);
        const names = new Set(proposal.laws.map((l) => l.name));
        const results = report.results.filter((r) => names.has(r.name));
        return { file, ...(withHints({ ...report, results }) as object) };
      }
      default:
        throw new ToolError(`unknown tool '${name}'`);
    }
  }
}

/** The proposed file with the proposal's laws appended (same-named laws replaced) and its imports added once. */
export function mergeProposal(current: string, imports: string[], laws: { name: string; text: string }[]): string {
  const parsed = parseLawFile(current);
  let text = current;
  for (const law of [...parsed.laws].reverse()) {
    if (laws.some((l) => l.name === law.name)) text = text.slice(0, law.start) + text.slice(law.end);
  }
  const have = new Set(parseLawFile(text).imports.map((i) => i.replace(/\s+/g, ' ').trim()));
  const missing = imports.filter((i) => !have.has(i.replace(/\s+/g, ' ').trim()));
  const head = missing.length > 0 ? `${missing.join('\n')}\n` : '';
  const body = `${text.trim() === '' ? '' : `${text.trim()}\n\n`}${laws.map((l) => l.text.trim()).join('\n\n')}\n`;
  return `${head}${head !== '' && !body.startsWith('import') ? '\n' : ''}${body}`;
}

type Id = string | number | null;

function reply(id: Id, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

function fail(id: Id, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`;
}

/** The reply line for one request line, or undefined for a notification. */
export async function handleLine(session: Session, line: string): Promise<string | undefined> {
  let message: { id?: Id; method?: unknown; params?: Record<string, unknown> };
  try {
    message = JSON.parse(line);
  } catch {
    return fail(null, -32700, 'parse error');
  }
  if (typeof message !== 'object' || message === null || typeof message.method !== 'string')
    return message?.id === undefined ? undefined : fail(message.id, -32600, 'invalid request');
  const id = message.id;
  const params = message.params ?? {};
  if (id === undefined) return undefined; // notifications/initialized and friends
  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply(id, {
        protocolVersion: typeof asked === 'string' && supportedVersions.includes(asked) ? asked : supportedVersions[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'tslaws', version: '0.1.1' },
        instructions:
          'Run checks and propose laws. Accepting laws and writing the lock are done by a person with `tslaws accept` and `tslaws promote`; no tool here does either.',
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !tools.some((t) => t.name === name))
        return fail(id, -32602, `unknown tool '${String(name)}'`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const out = await session.call(name, args);
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return reply(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${message.method}`);
  }
}

/** Serves MCP on stdin/stdout until stdin closes. Resolves the exit status. */
export async function serveMcp(opts: McpOptions): Promise<number> {
  process.env.TSLAWS_AGENT = '1';
  const session = new Session(opts);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain: Promise<void> = Promise.resolve();
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    chain = chain.then(async () => {
      const out = await handleLine(session, line);
      if (out !== undefined) process.stdout.write(out);
    });
  });
  await new Promise<void>((done) => lines.once('close', done));
  await chain;
  return 0;
}
