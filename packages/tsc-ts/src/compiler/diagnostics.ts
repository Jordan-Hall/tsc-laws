export const enum DiagnosticCategory {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

/** A localizable diagnostic message template, e.g. `'{0}' expected.`. */
export class DiagnosticMessage {
  readonly code: number;
  readonly category: DiagnosticCategory;
  readonly key: string;
  readonly text: string;
  readonly reportsUnnecessary: boolean;
  readonly elidedInCompatibilityPyramid: boolean;
  readonly reportsDeprecated: boolean;

  constructor(
    code: number,
    category: DiagnosticCategory,
    key: string,
    text: string,
    reportsUnnecessary = false,
    elidedInCompatibilityPyramid = false,
    reportsDeprecated = false,
  ) {
    this.code = code;
    this.category = category;
    this.key = key;
    this.text = text;
    this.reportsUnnecessary = reportsUnnecessary;
    this.elidedInCompatibilityPyramid = elidedInCompatibilityPyramid;
    this.reportsDeprecated = reportsDeprecated;
  }
}

/** Replaces `{0}`, `{1}`, … in `text` with `args`. */
export function formatMessage(text: string, args: readonly string[]): string {
  if (args.length === 0) return text;
  let result = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 0x7b) continue;
    let j = i + 1;
    let index = 0;
    while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x39) {
      index = index * 10 + text.charCodeAt(j) - 0x30;
      j++;
    }
    if (j === i + 1 || j >= text.length || text.charCodeAt(j) !== 0x7d) continue;
    if (index >= args.length) throw new Error('Invalid formatting placeholder');
    result += text.substring(start, i) + args[index];
    start = j + 1;
    i = j;
  }
  return result + text.substring(start);
}
