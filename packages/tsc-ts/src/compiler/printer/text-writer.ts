// Builds printer output with indentation and line/column tracking for source maps.
import { CharacterCodes, isWhiteSpaceLike } from '../character-codes.js';

const defaultIndentSize = 4;

export class TextWriter {
  readonly newLine: string;
  readonly indentSize: number;
  /** Current indentation level. */
  indent: number;
  /** Track output length for `getColumn`; off unless source maps are written. */
  trackColumns: boolean;
  private parts: string[];
  /** Output length in UTF-16 code units, when `trackColumns` is on. */
  private length: number;
  /** Number of non-empty writes, to tell whether anything was written. */
  private writes: number;
  private lastWritten: string;
  private lineStart: boolean;
  private lineCount: number;
  /** Offset of the current line's start in the output, when `trackColumns` is on. */
  private linePos: number;
  private trailingComment: boolean;
  private readonly indentStrings: string[];

  constructor(newLine: string, indentSize: number) {
    this.newLine = newLine;
    this.indentSize = indentSize > 0 ? indentSize : defaultIndentSize;
    this.indent = 0;
    this.trackColumns = false;
    this.parts = [];
    this.length = 0;
    this.writes = 0;
    this.lastWritten = '';
    this.lineStart = true;
    this.lineCount = 0;
    this.linePos = 0;
    this.trailingComment = false;
    this.indentStrings = [''];
  }

  clear(): string {
    this.indent = 0;
    this.parts = [];
    this.length = 0;
    this.writes = 0;
    this.lastWritten = '';
    this.lineStart = true;
    this.lineCount = 0;
    this.linePos = 0;
    this.trailingComment = false;
    return '';
  }

  getText(): string {
    const text = this.parts.join('');
    if (this.parts.length > 1) this.parts = [text];
    return text;
  }

  /** Changes whenever something is written. */
  getWriteCount(): number {
    return this.writes;
  }

  getLine(): number {
    return this.lineCount;
  }

  /** Column in UTF-16 code units; needs `trackColumns`. */
  getColumn(): number {
    return this.lineStart ? this.indent * this.indentSize : this.length - this.linePos;
  }

  isAtStartOfLine(): boolean {
    return this.lineStart;
  }

  hasTrailingComment(): boolean {
    return this.trailingComment;
  }

  hasTrailingWhitespace(): boolean {
    const last = this.lastWritten;
    return this.writes > 0 && last !== '' && isWhiteSpaceLike(last.charCodeAt(last.length - 1));
  }

  private indentString(level: number): string {
    const strings = this.indentStrings;
    while (strings.length <= level) strings.push(strings[strings.length - 1] + ' '.repeat(this.indentSize));
    return strings[level]!;
  }

  private append(s: string): boolean {
    this.parts.push(s);
    this.writes++;
    if (this.trackColumns) this.length += s.length;
    this.lastWritten = s;
    return true;
  }

  /** Moves the line state past the line terminators in `s`, which ends the output. */
  private updateLines(s: string): boolean {
    let count = 0;
    let lastLineStart = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === CharacterCodes.carriageReturn) {
        if (i + 1 < s.length && s.charCodeAt(i + 1) === CharacterCodes.lineFeed) i++;
      } else if (
        ch !== CharacterCodes.lineFeed &&
        ch !== CharacterCodes.lineSeparator &&
        ch !== CharacterCodes.paragraphSeparator
      )
        continue;
      count++;
      lastLineStart = i + 1;
    }
    if (count > 0) {
      this.lineCount += count;
      this.linePos = this.length - s.length + lastLineStart;
      this.lineStart = this.trackColumns ? this.linePos === this.length : lastLineStart === s.length;
      return true;
    }
    this.lineStart = false;
    return false;
  }

  private writeIndent(): boolean {
    if (!this.lineStart) return false;
    const indent = this.indentString(this.indent);
    if (indent !== '') this.append(indent);
    this.lineStart = false;
    return true;
  }

  /** Writes text without indentation; it may contain line breaks. */
  rawWrite(s: string): boolean {
    if (s !== '') {
      this.append(s);
      this.trailingComment = false;
    }
    return this.updateLines(s);
  }

  /** Writes text that contains no line breaks, such as a token or identifier. */
  write(s: string): boolean {
    if (s === '') return false;
    this.trailingComment = false;
    this.writeIndent();
    this.lineStart = false;
    return this.append(s);
  }

  /** Writes text that may contain line breaks, such as a string or template literal. */
  writeText(s: string): boolean {
    if (s === '') return false;
    this.trailingComment = false;
    this.writeIndent();
    this.append(s);
    return this.updateLines(s);
  }

  /** Writes comment text without line breaks. */
  writeComment(s: string): boolean {
    if (s === '') return false;
    this.trailingComment = true;
    this.writeIndent();
    this.lineStart = false;
    return this.append(s);
  }

  /** Ends the line, unless already at the start of one and not `force`d. */
  writeLine(force: boolean): boolean {
    if (this.lineStart && !force) return false;
    this.append(this.newLine);
    this.lineCount++;
    this.linePos = this.length;
    this.lineStart = true;
    this.trailingComment = false;
    return true;
  }
}
