import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const hookCommand = 'node node_modules/tslaws/hooks/claude-hook.mjs';
export const agentsBegin = '<!-- tslaws:begin -->';
export const agentsEnd = '<!-- tslaws:end -->';
export const nextStep = 'Next, a person at a terminal runs `tslaws accept` to record the laws in tsc-laws.lock.';

const hooksDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

const starterLaws = `// A starter law. A person owns this file: agents propose laws in *.proposed.laws.ts instead.
// Replace it with laws about your own code, then run \`tslaws accept\`.
import type { int } from 'tslaws';

export law additionCommutes(a: int, b: int) {
  return a + b === b + a;
}
`;

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

export interface InitOptions {
  cwd: string;
  /** Overwrite tslaws.json, replace the AGENTS.md section and replace an unparseable settings file. */
  force?: boolean;
}

function writeFile(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function hasLawsFile(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.tslaws' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (hasLawsFile(full)) return true;
    } else if (entry.endsWith('.laws.ts')) return true;
  }
  return false;
}

function commandsOf(entries: unknown[]): string[] {
  return (entries as HookEntry[]).flatMap((e) =>
    Array.isArray(e?.hooks) ? e.hooks.map((h) => String(h?.command)) : [],
  );
}

/** Adds the template's hook entries to settings, keeping every other key and entry. Returns whether anything was added. */
export function mergeHooks(
  settings: Record<string, unknown>,
  template: { hooks: Record<string, HookEntry[]> },
): boolean {
  let changed = false;
  const existing = settings.hooks;
  const hooks: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  for (const [event, entries] of Object.entries(template.hooks)) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const present = commandsOf(current);
    for (const entry of entries) {
      if (commandsOf([entry]).every((c) => present.includes(c))) continue;
      current.push(entry);
      changed = true;
    }
    hooks[event] = current;
  }
  settings.hooks = hooks;
  return changed;
}

function agentsSection(): string {
  const snippet = readFileSync(join(hooksDir, 'AGENTS.snippet.md'), 'utf8').trim();
  return `${agentsBegin}\n${snippet}\n${agentsEnd}\n`;
}

function initAgents(cwd: string, force: boolean): string {
  const file = join(cwd, 'AGENTS.md');
  const section = agentsSection();
  if (!existsSync(file)) {
    writeFile(file, section);
    return 'wrote    AGENTS.md';
  }
  const text = readFileSync(file, 'utf8');
  const begin = text.indexOf(agentsBegin);
  const end = text.indexOf(agentsEnd);
  if (begin >= 0 && end > begin) {
    if (!force) return 'kept     AGENTS.md (laws section present; --force replaces it)';
    writeFile(file, `${text.slice(0, begin)}${section.trimEnd()}${text.slice(end + agentsEnd.length)}`);
    return 'updated  AGENTS.md (laws section replaced)';
  }
  const sep = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  writeFile(file, `${text}${sep}${section}`);
  return 'updated  AGENTS.md (laws section appended)';
}

function initSettings(cwd: string, force: boolean): string {
  const file = join(cwd, '.claude', 'settings.json');
  const template = JSON.parse(
    readFileSync(join(hooksDir, 'claude-settings.example.json'), 'utf8').replaceAll(
      'node packages/tslaws/hooks/claude-hook.mjs',
      hookCommand,
    ),
  );
  const exists = existsSync(file);
  let settings: Record<string, unknown> = {};
  if (exists) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      settings = parsed as Record<string, unknown>;
    } catch {
      if (!force) return 'skipped  .claude/settings.json (not valid JSON; fix it or use --force to replace it)';
    }
  }
  const changed = mergeHooks(settings, template);
  if (exists && !changed) return 'kept     .claude/settings.json (hooks already present)';
  writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return 'updated  .claude/settings.json (tslaws hooks)';
}

/** Scaffolds a project for tslaws without overwriting its files. Returns one line per thing done or skipped. */
export function init(options: InitOptions): string[] {
  const { cwd, force = false } = options;
  const out: string[] = [];

  const config = join(cwd, 'tslaws.json');
  if (existsSync(config) && !force) out.push('kept     tslaws.json (exists; --force overwrites)');
  else {
    writeFile(config, `${JSON.stringify({ cover: ['src/**/*.ts', '!src/**/*.laws.ts'] }, null, 2)}\n`);
    out.push('wrote    tslaws.json');
  }

  const ignore = join(cwd, '.gitignore');
  const ignoreText = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (ignoreText.split(/\r?\n/).some((l) => ['.tslaws', '.tslaws/', '/.tslaws', '/.tslaws/'].includes(l.trim())))
    out.push('kept     .gitignore (.tslaws already listed)');
  else {
    writeFile(ignore, `${ignoreText}${ignoreText === '' || ignoreText.endsWith('\n') ? '' : '\n'}.tslaws\n`);
    out.push('updated  .gitignore (.tslaws)');
  }

  out.push(initAgents(cwd, force));
  out.push(initSettings(cwd, force));

  if (hasLawsFile(cwd)) out.push('kept     no starter law added (a *.laws.ts file exists)');
  else {
    writeFile(join(cwd, 'src', 'example.laws.ts'), starterLaws);
    out.push('wrote    src/example.laws.ts (starter law)');
  }
  return out;
}
