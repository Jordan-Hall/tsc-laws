// Checks packages/tslaws/README.md, the page npm shows for `tslaws`, so it cannot drift from the code.
//
//   node scripts/ci/package-readme.mjs
//
// npm cannot resolve a relative path against the repository, so every link and image must be an absolute URL (or a
// `#fragment` on the page). Every `tslaws <command>`, `tslaws <command> a|b|c` alternative and `--flag` the README shows
// in code must also exist in the usage text of packages/tslaws/src/cli.ts (with the migrate and security usage it
// interpolates).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const readme = readFileSync(join(root, 'packages/tslaws/README.md'), 'utf8');
const problems = [];

// Links, images and HTML attributes that point somewhere.
const targets = [
  ...[...readme.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]),
  ...[...readme.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map((m) => m[1]),
  ...[...readme.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]),
];
for (const target of targets) {
  if (!/^(?:https?:\/\/|mailto:|#)/.test(target)) problems.push(`relative link or image: ${target}`);
}

// The usage text: the `usage` template in cli.ts and the usage constants it interpolates.
const usageSources = [
  'packages/tslaws/src/cli.ts',
  'packages/tslaws/src/migrate/index.ts',
  'packages/tslaws/src/security/cli.ts',
];
const usage = usageSources
  .flatMap((file) => [...readFileSync(join(root, file), 'utf8').matchAll(/const \w*[uU]sage = `([^`]*)`/g)])
  .map((m) => m[1])
  .join('\n');
if (usage === '') problems.push('found no usage text in cli.ts');
const usageLines = usage.split('\n');

// What the README shows as code: fenced blocks and inline spans.
const code = [...readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
const prose = readme.replace(/```[^\n]*\n[\s\S]*?```/g, '');
code.push(...[...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
const shown = code.join('\n');

const commands = new Set([...usage.matchAll(/^tslaws ([a-z][a-z-]*)/gm)].map((m) => m[1]));
const extraFlags = new Set(['--help']);
for (const [, command] of shown.matchAll(/\btslaws ([a-z][a-z-]*)/g)) {
  if (!commands.has(command)) problems.push(`tslaws ${command}: not a command in the cli.ts usage`);
}
for (const [, command, alternatives] of shown.matchAll(/\btslaws ([a-z][a-z-]*) ([a-z]+(?:\|[a-z]+)+)/g)) {
  const lines = usageLines.filter((line) => line.startsWith(`tslaws ${command} `)).join('\n');
  for (const word of alternatives.split('|')) {
    if (!new RegExp(`\\b${word}\\b`).test(lines)) problems.push(`tslaws ${command} ${word}: not in the cli.ts usage`);
  }
}
for (const [flag] of shown.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) {
  if (!extraFlags.has(flag) && !usage.includes(flag)) problems.push(`${flag}: not a flag in the cli.ts usage`);
}

if (problems.length > 0) {
  console.error(`packages/tslaws/README.md:\n${[...new Set(problems)].map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`packages/tslaws/README.md: ${targets.length} links absolute, commands and flags match the usage text`);
