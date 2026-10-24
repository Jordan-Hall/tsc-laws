// `tslaws promote`: the pure core. A person moves proposed laws into the accepted file; the lock is not touched here.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface ParsedLaw {
  name: string;
  /** The declaration as written, from `export` to its end. */
  text: string;
  start: number;
  end: number;
}

export interface ParsedLawFile {
  /** Whole import statements, in order. */
  imports: string[];
  laws: ParsedLaw[];
}

/** `foo.proposed.laws.ts` -> `foo.laws.ts`; undefined for any other name. */
export function acceptedPathFor(proposed: string): string | undefined {
  return proposed.endsWith('.proposed.laws.ts')
    ? `${proposed.slice(0, -'.proposed.laws.ts'.length)}.laws.ts`
    : undefined;
}

/**
 * Finds the import statements and the `export law ...` declarations of a laws file. `law` is not standard TypeScript, so
 * this scans tokens with the TypeScript scanner (strings, comments and templates are skipped correctly) and matches
 * brackets: a law ends at its closing `}` or at a `;` at depth 0.
 */
export function parseLawFile(text: string): ParsedLawFile {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const imports: string[] = [];
  const laws: ParsedLaw[] = [];
  const templates: number[] = []; // depth at which each open template substitution started
  let depth = 0;
  let statement: { kind: 'import' | 'law'; start: number; name: string; sawString: boolean } | undefined;
  let arrow = false;
  const finish = (end: number): void => {
    if (statement === undefined) return;
    if (statement.kind === 'import') imports.push(text.slice(statement.start, end));
    else laws.push({ name: statement.name, text: text.slice(statement.start, end), start: statement.start, end });
    statement = undefined;
    arrow = false;
  };
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    const tokenStart = scanner.getTokenStart();
    if (kind === ts.SyntaxKind.CloseBraceToken && templates.length > 0 && templates[templates.length - 1] === depth) {
      templates.pop();
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateMiddle) templates.push(depth);
    } else if (kind === ts.SyntaxKind.TemplateHead) {
      templates.push(depth);
    } else if (depth === 0 && statement === undefined) {
      if (kind === ts.SyntaxKind.ImportKeyword) {
        statement = { kind: 'import', start: tokenStart, name: '', sawString: false };
      } else if (kind === ts.SyntaxKind.ExportKeyword) {
        const rest = scanner.getTokenEnd();
        const next = ts.createScanner(
          ts.ScriptTarget.Latest,
          true,
          ts.LanguageVariant.Standard,
          text,
          undefined,
          rest,
          text.length - rest,
        );
        const word = next.scan();
        if (word === ts.SyntaxKind.Identifier && next.getTokenValue() === 'law') {
          let n = next.scan();
          if (n === ts.SyntaxKind.Identifier && next.getTokenValue() === 'proved') n = next.scan();
          if (n === ts.SyntaxKind.Identifier || n > ts.SyntaxKind.LastReservedWord)
            statement = { kind: 'law', start: tokenStart, name: next.getTokenValue(), sawString: false };
        }
      }
    }
    if (
      kind === ts.SyntaxKind.OpenBraceToken ||
      kind === ts.SyntaxKind.OpenParenToken ||
      kind === ts.SyntaxKind.OpenBracketToken
    ) {
      depth += 1;
    } else if (
      kind === ts.SyntaxKind.CloseBraceToken ||
      kind === ts.SyntaxKind.CloseParenToken ||
      kind === ts.SyntaxKind.CloseBracketToken
    ) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && kind === ts.SyntaxKind.CloseBraceToken && statement?.kind === 'law') {
        // A block-bodied law ends here; the arrow form ends at its `;`.
        if (!arrow) {
          let end = scanner.getTokenEnd();
          const peek = ts.createScanner(
            ts.ScriptTarget.Latest,
            true,
            ts.LanguageVariant.Standard,
            text,
            undefined,
            end,
            text.length - end,
          );
          if (peek.scan() === ts.SyntaxKind.SemicolonToken) end = peek.getTokenEnd();
          finish(end);
          if (end > scanner.getTokenEnd()) scanner.resetTokenState(end);
          kind = scanner.scan();
          continue;
        }
      }
    } else if (depth === 0 && kind === ts.SyntaxKind.EqualsGreaterThanToken && statement?.kind === 'law') {
      arrow = true;
    } else if (depth === 0 && kind === ts.SyntaxKind.SemicolonToken) {
      finish(scanner.getTokenEnd());
    } else if (depth === 0 && statement?.kind === 'import' && kind === ts.SyntaxKind.StringLiteral) {
      statement.sawString = true;
      const end = scanner.getTokenEnd();
      const peek = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.Standard,
        text,
        undefined,
        end,
        text.length - end,
      );
      const after = peek.scan();
      const attributes =
        after === ts.SyntaxKind.WithKeyword ||
        (after === ts.SyntaxKind.Identifier && peek.getTokenValue() === 'assert');
      if (!attributes) {
        const stop = after === ts.SyntaxKind.SemicolonToken ? peek.getTokenEnd() : end;
        finish(stop);
        if (stop > end) scanner.resetTokenState(stop);
      }
    }
    kind = scanner.scan();
  }
  finish(text.length);
  return { imports, laws };
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Joins the import statements, dropping repeats by whitespace-insensitive text. */
export function dedupeImports(existing: string[], added: string[]): string[] {
  const seen = new Set(existing.map(squash));
  const out = [...existing];
  for (const statement of added) {
    if (seen.has(squash(statement))) continue;
    seen.add(squash(statement));
    out.push(statement);
  }
  return out;
}

/**
 * The accepted file after promoting `laws` (with the proposed file's imports) into it. `existing` is the current text
 * of the accepted file, or undefined when it does not exist yet. Throws when a law name is already taken there.
 */
export function buildAccepted(existing: string | undefined, imports: string[], laws: ParsedLaw[]): string {
  const base = existing ?? '';
  const parsed = parseLawFile(base);
  const taken = new Set(parsed.laws.map((l) => l.name));
  for (const law of laws)
    if (taken.has(law.name)) throw new Error(`law '${law.name}' already exists in the accepted file`);
  const missing = dedupeImports(parsed.imports, imports).slice(parsed.imports.length);
  let text = base;
  if (missing.length > 0) {
    // New imports go after the last existing import, or at the top.
    const lastEnd =
      parsed.imports.length > 0
        ? base.indexOf(parsed.imports[parsed.imports.length - 1]!) + parsed.imports[parsed.imports.length - 1]!.length
        : 0;
    const block = missing.map((m) => (m.endsWith(';') ? m : `${m};`)).join('\n');
    text =
      lastEnd === 0
        ? `${block}\n${base === '' ? '' : `${base.startsWith('\n') ? '' : '\n'}`}${base}`
        : `${base.slice(0, lastEnd)}\n${block}${base.slice(lastEnd)}`;
  }
  const body = laws.map((l) => l.text.trimEnd()).join('\n\n');
  const trimmed = text.trimEnd();
  return `${trimmed === '' ? '' : `${trimmed}\n\n`}${body}\n`;
}

/** The proposed file without the promoted laws, or undefined when no law is left (the file is deleted). */
export function buildRemaining(text: string, promoted: string[]): string | undefined {
  const parsed = parseLawFile(text);
  const drop = new Set(promoted);
  if (parsed.laws.every((l) => drop.has(l.name))) return undefined;
  let out = text;
  for (const law of [...parsed.laws].reverse()) {
    if (!drop.has(law.name)) continue;
    let end = law.end;
    while (out[end] === '\r' || out[end] === '\n') end += 1;
    out = out.slice(0, law.start) + out.slice(end);
  }
  return out;
}

export interface PromoteHost {
  cwd: string;
  /** Checks one proposed file and returns its results by law name (as `check --proposed` would). */
  checkFile: (file: string) => Promise<Map<string, string>>;
  ask: (question: string) => Promise<string>;
  out: (text: string) => void;
}

/** Walks the proposed files, asks per law, and rewrites the accepted and proposed files. Returns the number promoted. */
export async function promoteFiles(host: PromoteHost, proposedFiles: string[]): Promise<number> {
  let promoted = 0;
  for (const file of proposedFiles) {
    const accepted = acceptedPathFor(file);
    if (accepted === undefined) {
      host.out(`${file}: not a *.proposed.laws.ts file, skipped\n`);
      continue;
    }
    const proposedPath = join(host.cwd, file);
    const acceptedPath = join(host.cwd, accepted);
    const text = readFileSync(proposedPath, 'utf8');
    const parsed = parseLawFile(text);
    if (parsed.laws.length === 0) {
      host.out(`${file}: no laws\n`);
      continue;
    }
    const results = await host.checkFile(file);
    const chosen: ParsedLaw[] = [];
    for (const law of parsed.laws) {
      host.out(`\n${file}: ${law.name}  [${results.get(law.name) ?? 'not checked'}]\n${law.text.trim()}\n`);
      if ((await host.ask(`promote ${law.name}? [y/N] `)).trim().toLowerCase() === 'y') chosen.push(law);
    }
    if (chosen.length === 0) continue;
    const existing = existsSync(acceptedPath) ? readFileSync(acceptedPath, 'utf8') : undefined;
    let built: string;
    try {
      built = buildAccepted(existing, parsed.imports, chosen);
    } catch (error) {
      host.out(
        `${accepted}: ${error instanceof Error ? error.message : String(error)}; nothing promoted from ${file}\n`,
      );
      continue;
    }
    writeFileSync(acceptedPath, built);
    const remaining = buildRemaining(
      text,
      chosen.map((l) => l.name),
    );
    if (remaining === undefined) rmSync(proposedPath);
    else writeFileSync(proposedPath, remaining);
    promoted += chosen.length;
    host.out(
      `${chosen.length} law${chosen.length === 1 ? '' : 's'} moved to ${accepted}${remaining === undefined ? `; ${file} removed` : ''}\n`,
    );
  }
  if (promoted > 0)
    host.out('\nThe lock is unchanged. Review the diff, then run `tslaws accept` to record these laws.\n');
  return promoted;
}
