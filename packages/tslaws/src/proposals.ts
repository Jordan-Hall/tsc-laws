// Proposals: laws an agent (or a person) suggests, kept in `.tslaws/proposals/` at the project root. The directory is
// tool-owned and git-ignored, outside the tree the lock covers, so a proposal protects nothing and an edit to the tree
// can never turn an accepted law into a proposed one. Only this module writes there; it never touches the lock.
//
// Imports in a proposal that start with `./` are written relative to the PROJECT ROOT (`./src/cart`), which is what an
// author at the project root expects. They are stored relative to the file (`../../src/cart`), so the stored file is
// ordinary TypeScript that resolves, type-checks and runs where it is. `../` and package imports are left alone.
// `promote` rewrites the stored form again for the directory the law moves to.
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  closeSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { moduleSpecifiers } from './lawKinds.ts';
import { ignoredDirs, proposalsDir } from './lawFiles.ts';
import ts from 'typescript';
import {
  assertHelpersSafe,
  assertImportStatements,
  isPlainConst,
  parseLawFile,
  sameCode,
  withDeclarations,
} from './promote.ts';

/** A refusal with a message for the person or agent that asked. */
export class ProposalError extends Error {}

const nameShape = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:ts|mts|cts)$/;

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The proposals directory, checked on the real file system: neither `.tslaws` nor `proposals` may be a link (or a
 * junction) that leads out of the project. Creates the directory when `create` is set.
 */
export function proposalsDirectory(cwd: string, create: boolean): string | undefined {
  let real = realpathSync(cwd);
  let shown = cwd;
  for (const part of ['.tslaws', 'proposals']) {
    shown = join(shown, part);
    const expected = join(real, part);
    if (existsSync(shown) || isLink(shown)) {
      if (isLink(shown) || realpathSync(shown) !== expected)
        throw new ProposalError(
          `${posix.join('.tslaws', part)} is a link that leaves the project; proposals are written inside the project only`,
        );
    } else if (create) mkdirSync(shown);
    else return undefined;
    real = expected;
  }
  return shown;
}

/**
 * The project-relative path of a proposal: `name.ts` or `.tslaws/proposals/name.ts`. Anything that names another
 * directory, climbs out, is absolute or is not a plain `.ts` file name is refused.
 */
export function proposalName(file: string): string {
  const given = file.replaceAll('\\', '/').replace(/^\.\//, '');
  const bare = given.startsWith(`${proposalsDir}/`) ? given.slice(proposalsDir.length + 1) : given;
  if (!nameShape.test(bare) || /\.d\.(?:ts|mts|cts)$/.test(bare) || bare.includes('..'))
    throw new ProposalError(
      `'${file}' is not a proposal file: proposals are plain .ts files directly inside ${proposalsDir}/ (for example ${proposalsDir}/cart.ts)`,
    );
  return `${proposalsDir}/${bare}`;
}

/** The absolute path a write to a proposal may use, after refusing links. Creates the directory. */
function writablePath(cwd: string, file: string): { rel: string; abs: string } {
  const rel = proposalName(file);
  const dir = proposalsDirectory(cwd, true)!;
  const abs = join(dir, rel.slice(proposalsDir.length + 1));
  if (isLink(abs)) throw new ProposalError(`${rel} is a link; a proposal must be a plain file`);
  if (existsSync(abs) && !lstatSync(abs).isFile()) throw new ProposalError(`${rel} is not a plain file`);
  return { rel, abs };
}

/** The absolute path of an existing proposal for reading or removing; refuses links the same way. */
export function existingProposal(cwd: string, file: string): { rel: string; abs: string } {
  const rel = proposalName(file);
  const dir = proposalsDirectory(cwd, false);
  const abs = dir === undefined ? undefined : join(dir, rel.slice(proposalsDir.length + 1));
  if (abs === undefined || !existsSync(abs)) throw new ProposalError(`no proposal ${rel}`);
  if (isLink(abs) || !lstatSync(abs).isFile()) throw new ProposalError(`${rel} is not a plain file`);
  return { rel, abs };
}

function rewrite(text: string, change: (specifier: string) => string | undefined): string {
  let out = text;
  for (const spec of moduleSpecifiers(text, 'proposal.ts').reverse()) {
    const next = change(spec.value);
    if (next !== undefined && next !== spec.value) out = out.slice(0, spec.start) + next + out.slice(spec.end);
  }
  return out;
}

const dotted = (path: string): string => (path.startsWith('.') ? path : `./${path}`);

/** Stores root-relative `./x` imports relative to the proposals directory. Idempotent for stored text. */
export function toStoredImports(text: string): string {
  return rewrite(text, (specifier) => {
    if (!specifier.startsWith('./')) return undefined;
    const fromRoot = posix.normalize(specifier);
    if (fromRoot.startsWith('..'))
      throw new ProposalError(
        `import '${specifier}' leaves the project; imports starting with ./ are relative to the project root`,
      );
    return dotted(posix.relative(proposalsDir, fromRoot));
  });
}

/** Re-expresses the relative imports of a stored proposal for a file in the project-relative directory `toDir`. */
export function importsForTarget(text: string, toDir: string): string {
  return rewrite(text, (specifier) => {
    if (!specifier.startsWith('.')) return undefined;
    return dotted(posix.relative(toDir === '' ? '.' : toDir, posix.join(proposalsDir, specifier)));
  });
}

/**
 * Whether git ignores `path` (absolute, or relative to `cwd`): `ignored`, `kept`, or `unknown` when git is missing,
 * `cwd` is not in a repository or the check fails for any other reason. Callers treat `unknown` as a refusal.
 */
function gitIgnoreState(cwd: string, path: string): 'ignored' | 'kept' | 'unknown' {
  const result = spawnSync('git', ['check-ignore', '-q', '--', path], {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error !== undefined || result.status === null) return 'unknown';
  if (result.status === 0) return 'ignored';
  return result.status === 1 ? 'kept' : 'unknown';
}

const sourceSuffixes = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '/index.ts',
  '/index.js',
];

/** The files a relative specifier may name: the path itself, the same with an extension or `index`, and `.js` read as `.ts`. */
function specifierCandidates(target: string): string[] {
  const swapped = target.replace(/\.([cm]?)js$/, '.$1ts');
  const all = [...new Set([target, swapped].flatMap((base) => sourceSuffixes.map((suffix) => base + suffix)))];
  const found = all.filter((candidate) => existsSync(candidate));
  return found.length > 0 ? [target, ...found] : [target];
}

/**
 * The canonical path of `path`: links followed and the file system's own spelling of every part (long names and case
 * on Windows and macOS), as far as it exists; the parts that do not exist yet are appended to the nearest existing parent.
 */
function realish(path: string): string {
  const rest: string[] = [];
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) {
    rest.unshift(basename(probe));
    probe = dirname(probe);
  }
  return join(realpathSync.native(probe), ...rest);
}

/**
 * Throws unless every file the module specifiers of `text` name (an import, a re-export, `require` or `import()`)
 * is code a person has reviewed: inside the project, not under `.tslaws/` (the proposals area), `node_modules` or
 * `.git`, and not git-ignored. Specifiers are read relative to the project-relative directory `fromDir`, where the file
 * stands. A package name is not a path and is left alone. Any specifier with `%`, `?`, `#` or a control character is
 * refused (percent escapes, queries, fragments and package `imports` aliases make the file the runtime loads differ
 * from the text). A path specifier is resolved as the runtime does, as a URL against the importing directory, then
 * made canonical on the real file system; the reserved names are compared without regard to case. Git must answer: when
 * git is missing, the project is not in a repository or the check fails, the import is refused. A project that sits
 * inside an ignored directory of a larger repository has no usable ignore rules, so each file is not asked.
 */
export function assertImportsAllowed(cwd: string, text: string, fromDir: string): void {
  const all = [...new Set(moduleSpecifiers(text, 'proposal.ts').map((s) => s.value))];
  const refuse = (specifier: string, why: string): never => {
    throw new ProposalError(
      `import '${specifier}' ${why}; an import must name code that is inside the project, outside .tslaws/, node_modules and .git, and not git-ignored, so that a person has reviewed it`,
    );
  };
  for (const specifier of all)
    if (/[%?#]/.test(specifier) || [...specifier].some((c) => c.charCodeAt(0) < 0x20 || c === '\u007f'))
      refuse(specifier, 'has a %, ?, # or control character, which can make the loaded file differ from its text');
  const specifiers = all.filter(
    (v) =>
      v.startsWith('.') ||
      v.startsWith('/') ||
      v.startsWith('file:') ||
      /^[A-Za-z]:[\\/]/.test(v) ||
      v.startsWith('\\'),
  );
  if (specifiers.length === 0) return;
  const root = realpathSync.native(cwd);
  const reserved = new Set([...ignoredDirs].map((name) => name.toLowerCase()));
  let rootIgnored: boolean | undefined;
  const ignored = (specifier: string, path: string): boolean => {
    const state = gitIgnoreState(root, path);
    if (state === 'unknown')
      refuse(
        specifier,
        'could not be checked against git ignore rules (git is missing, this is not a repository or the check failed)',
      );
    return state === 'ignored';
  };
  for (const specifier of specifiers) {
    if (specifier.startsWith('file:')) refuse(specifier, 'is a file URL');
    // Resolve as the runtime does: a URL against the directory of the importing file.
    let url: URL;
    try {
      url = new URL(specifier, pathToFileURL(join(root, fromDir) + sep));
    } catch {
      return refuse(specifier, 'is not a path');
    }
    if (url.protocol !== 'file:' || url.host !== '') refuse(specifier, 'is not a path inside the project');
    const target = fileURLToPath(url);
    for (const candidate of specifierCandidates(target)) {
      const rel = relative(root, realish(candidate)).replaceAll('\\', '/');
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) refuse(specifier, 'resolves outside the project');
      const name = rel.split('/').find((part) => reserved.has(part.toLowerCase()));
      if (name !== undefined) refuse(specifier, `resolves into ${name}/ (${rel})`);
      rootIgnored ??= ignored(specifier, root);
      if (!rootIgnored && ignored(specifier, rel)) refuse(specifier, `resolves to ${rel}, which git ignores`);
    }
  }
}

/** Whether a top-level statement may stand in a proposal beside the laws: a `const`, function, type or interface. */
function isHelper(statement: ts.Statement): boolean {
  if (ts.isVariableStatement(statement)) return isPlainConst(statement);
  return (
    ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)
  );
}

/**
 * The proposal's own text after `parseLawFile`: imports, law declarations and the helpers the laws need (top-level
 * `const`, function, type and interface declarations, with their comments). Any other top-level statement, such as a
 * bare call, a loop, `export default` or `let`, runs on its own or changes shared state, so it is refused.
 */
function parts(source: string, cwd: string): ReturnType<typeof parseLawFile> {
  const parsed = parseLawFile(source);
  const file = ts.createSourceFile('proposal.ts', parsed.rest, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  for (const statement of file.statements)
    if (!isHelper(statement) && !ts.isEmptyStatement(statement)) {
      const shown = parsed.rest.slice(statement.getStart(file), statement.end).replace(/\s+/g, ' ');
      throw new ProposalError(
        `a proposal may contain only imports, law declarations and top-level const, function, type and interface declarations; found \`${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown}\``,
      );
    }
  try {
    assertImportStatements(parsed.imports);
    assertHelpersSafe(parsed.declarations);
    // The source is stored in the proposals directory, so its specifiers are read from there.
    assertImportsAllowed(cwd, source, proposalsDir);
  } catch (error) {
    throw new ProposalError(error instanceof Error ? error.message : String(error));
  }
  return parsed;
}

/**
 * The imports and helper declarations of `source` as they would be stored, after the same checks `addProposal` makes.
 * `packages` lists the package specifiers the source loads (anything that is not a relative path), which are code
 * outside the project that no person has reviewed.
 */
export function previewProposal(
  source: string,
  cwd: string,
): { imports: string[]; packages: string[]; helpers: { names: string[]; text: string }[] } {
  const parsed = parts(toStoredImports(source), cwd);
  const packages = moduleSpecifiers(source, 'proposal.ts')
    .map((s) => s.value)
    .filter((v) => !v.startsWith('.'));
  return {
    imports: parsed.imports.map((i) => i.trim()),
    packages: [...new Set(packages)],
    helpers: parsed.declarations.map((d) => ({ names: d.names, text: d.text.trim() })),
  };
}

interface Helper {
  names: string[];
  text: string;
}

/**
 * The proposed file with the proposal's laws appended (same-named laws replaced), its imports added once and its
 * helpers placed after the declarations already there (a helper of the same name with other code replaces the old one,
 * and throws when that would drop a name its statement bound together with it; an identical one is kept as it is).
 */
export function mergeProposal(
  current: string,
  imports: string[],
  laws: { name: string; text: string }[],
  helpers: Helper[] = [],
): string {
  const parsed = parseLawFile(current);
  const added = helpers.filter(
    (helper) =>
      !parsed.declarations.some((d) => d.names.some((n) => helper.names.includes(n)) && sameCode(d.text, helper.text)),
  );
  const replaced = parsed.declarations.filter((d) => added.some((h) => h.names.some((n) => d.names.includes(n))));
  for (const declaration of replaced) {
    // One statement may bind several names (`const a = 1, b = 2`); dropping it must not take a name nobody redeclares.
    const lost = declaration.names.find((n) => !added.some((h) => h.names.includes(n)));
    if (lost !== undefined)
      throw new ProposalError(
        `'${lost}' is declared together with ${declaration.names
          .filter((n) => n !== lost)
          .map((n) => `'${n}'`)
          .join(', ')} in the proposal; send the whole declaration again, or rename the helper`,
      );
  }
  const drops = [...parsed.laws.filter((law) => laws.some((l) => l.name === law.name)), ...replaced].sort(
    (a, b) => b.start - a.start,
  );
  let text = current;
  for (const { start, end } of drops) {
    let to = end;
    while (text[to] === '\r' || text[to] === '\n') to += 1;
    text = text.slice(0, start) + text.slice(to);
  }
  if (added.length > 0) text = withDeclarations(text, added.map((h) => h.text.trim()).join('\n\n'));
  const have = new Set(parseLawFile(text).imports.map((i) => i.replace(/\s+/g, ' ').trim()));
  const missing = imports.filter((i) => !have.has(i.replace(/\s+/g, ' ').trim()));
  const head = missing.length > 0 ? `${missing.join('\n')}\n` : '';
  const body = `${text.trim() === '' ? '' : `${text.trim()}\n\n`}${laws.map((l) => l.text.trim()).join('\n\n')}\n`;
  return `${head}${head !== '' && !body.startsWith('import') ? '\n' : ''}${body}`;
}

function write(abs: string, text: string): void {
  // No following of a link planted at the last moment, where the platform can say so.
  const fd = openSync(
    abs,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

export interface Written {
  /** Project-relative path of the proposal. */
  file: string;
  /** The names of the laws the source declared. */
  laws: string[];
  /** The names of the helpers the source declared. */
  helpers: string[];
}

/**
 * Keeps the proposals directory out of git, on first use: appends `.tslaws/proposals` to an existing .gitignore (or
 * creates one in a git checkout) unless `.tslaws` or the directory is already listed. `tslaws init` leaves this to us.
 */
function ignoreProposals(cwd: string): void {
  const ignore = join(cwd, '.gitignore');
  const has = existsSync(ignore);
  if (!has && !existsSync(join(cwd, '.git'))) return;
  const text = has ? readFileSync(ignore, 'utf8') : '';
  const listed = text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '').replace(/\/$/, ''));
  if (listed.includes('.tslaws') || listed.includes('.tslaws/proposals')) return;
  const lead = text === '' || text.endsWith('\n') ? '' : '\n';
  if (has) appendFileSync(ignore, `${lead}.tslaws/proposals\n`);
  else writeFileSync(ignore, '.tslaws/proposals\n');
}

/**
 * Adds laws to a proposal (appended; a law of the same name is replaced). `source` holds imports, `export law`
 * declarations and the helpers they need (see `parts`); with `only`, it must declare that law. Writes inside `.tslaws/proposals/` and nowhere else.
 */
export function addProposal(cwd: string, file: string, source: string, only?: string): Written {
  const { rel, abs } = writablePath(cwd, file);
  const stored = toStoredImports(source);
  const parsed = parts(stored, cwd);
  if (parsed.laws.length === 0)
    throw new ProposalError('source must declare at least one law (`export law name(...) ...`)');
  if (only !== undefined && !parsed.laws.some((l) => l.name === only))
    throw new ProposalError(`source must contain \`export law ${only}\`…`);
  const current = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  write(abs, mergeProposal(current, parsed.imports, parsed.laws, parsed.declarations));
  ignoreProposals(cwd);
  return { file: rel, laws: parsed.laws.map((l) => l.name), helpers: parsed.declarations.flatMap((d) => d.names) };
}

/**
 * Stores the root-relative imports of a proposal someone placed in the directory by hand, so it resolves where it is.
 * Returns whether the file changed. Does nothing for a path that is not a plain file in the directory.
 */
export function normaliseProposal(cwd: string, file: string): boolean {
  const { abs } = existingProposal(cwd, file);
  const text = readFileSync(abs, 'utf8');
  const stored = toStoredImports(text);
  if (stored === text) return false;
  write(abs, stored);
  return true;
}
