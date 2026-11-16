// CWE tags for the security law pack. A builder's law fails by throwing a CweViolation whose message starts with
// the tag, so every reporter that prints a law's message (text, JUnit, GitHub annotations) shows the CWE.

/** A Common Weakness Enumeration id, as in `CWE-22`. */
export type CweId = `CWE-${number}`;

/** The weaknesses the pack covers, with the short name the reports use. */
export const cweCatalog: Readonly<Record<string, string>> = {
  'CWE-20': 'Improper input validation',
  'CWE-22': 'Path traversal',
  'CWE-79': 'Cross-site scripting',
  'CWE-190': 'Integer overflow or wraparound',
  'CWE-400': 'Uncontrolled resource consumption',
  'CWE-601': 'Open redirect',
  'CWE-681': 'Incorrect conversion between numeric types',
  'CWE-1321': 'Prototype pollution',
  'CWE-1333': 'Inefficient regular expression complexity',
};

/** `CWE-400/CWE-1333` for two ids, `CWE-22` for one. */
export function cweLabel(ids: readonly CweId[]): string {
  return ids.join('/');
}

/** What a failed security law throws: the message is `[CWE-22] what went wrong`. */
export class CweViolation extends Error {
  readonly cwe: readonly CweId[];
  readonly detail: string;
  constructor(cwe: readonly CweId[], detail: string) {
    super(`[${cweLabel(cwe)}] ${detail}`);
    this.name = 'CweViolation';
    this.cwe = cwe;
    this.detail = detail;
  }
}

/** A string for a message: JSON, so control characters, quotes and a null byte are visible. Long text is cut. */
export function show(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
