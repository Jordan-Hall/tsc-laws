// Law file names. A law's level (Node, browser or end to end) is decided by what its file imports (see lawKinds.ts); the
// `.browser.` and `.e2e.` suffixes are only hints that must agree with the imports. A proposed file is the accepted name with `.proposed` before `.laws`: `a.proposed.laws.ts` proposes
// `a.laws.ts`, `a.browser.proposed.laws.ts` proposes `a.browser.laws.ts` and `a.e2e.proposed.laws.ts` proposes
// `a.e2e.laws.ts`. A proposed file keeps the kind of the file it proposes, so it runs at the same level.

/** Whether the file is a proposed laws file, of any kind. */
export function isProposedLawFile(file: string): boolean {
  return file.endsWith('.proposed.laws.ts');
}

/** The accepted name a proposed file stands for; other names come back unchanged. */
export function acceptedLawName(file: string): string {
  return isProposedLawFile(file) ? `${file.slice(0, -'.proposed.laws.ts'.length)}.laws.ts` : file;
}

/** The level a file name hints at: `.browser.laws.ts` and `.e2e.laws.ts` (proposed or accepted). Only a hint; imports decide. */
export function suffixKind(file: string): 'browser' | 'e2e' | undefined {
  const accepted = acceptedLawName(file);
  if (/\.e2e\.laws\.[cm]?ts$/.test(accepted)) return 'e2e';
  if (/\.browser\.laws\.[cm]?ts$/.test(accepted)) return 'browser';
  return undefined;
}
