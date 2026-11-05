// Law file names. A proposed file is the accepted name with `.proposed` before `.laws`: `a.proposed.laws.ts` proposes
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
