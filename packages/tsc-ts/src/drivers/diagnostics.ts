// Usage: diagnostics <request.json>
// Prints the message table, translations, locale matches, formatted messages and diagnostic
// output for a request, as JSON in the format of packages/tsgo/oracles/diag-oracle.
import { readFileSync } from 'node:fs';
import { messageCount, messageFlags } from '../compiler/diagnostic-messages.js';
import {
  Diagnostic,
  DiagnosticFile,
  Diagnostics,
  categoryName,
  flattenDiagnosticMessage,
  formatDiagnostics,
  formatDiagnosticStatus,
  formatDiagnosticStatusWithColor,
  formatDiagnosticsWithColorAndContext,
  formatErrorSummary,
  localizeMessage,
  messageCategory,
  messageCode,
  messageForKey,
  messageKey,
  messageText,
  parseLocale,
  type DiagnosticFormatOptions,
  type DiagnosticMessage,
} from '../compiler/diagnostics.js';
import { parseJson, type JsonObject, type JsonValue } from '../compiler/package-json.js';

const empty: JsonObject = { type: 'object', entries: new Map(), kind: 0 };

function object(value: JsonValue | undefined): JsonObject {
  return value !== undefined && value.type === 'object' ? value : empty;
}

function items(o: JsonObject, key: string): readonly JsonValue[] {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'array' ? v.items : [];
}

function str(o: JsonObject, key: string): string {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'string' ? v.value : '';
}

function num(o: JsonObject, key: string): number {
  const v = o.entries.get(key);
  return v !== undefined && v.type === 'number' ? v.value : 0;
}

function strings(o: JsonObject, key: string): string[] {
  const result: string[] = [];
  for (const item of items(o, key)) if (item.type === 'string') result.push(item.value);
  return result;
}

function q(s: string): string {
  return JSON.stringify(s);
}

function list(values: readonly string[]): string {
  return '[' + values.map(q).join(',') + ']';
}

function lookup(key: string): DiagnosticMessage {
  const message = messageForKey(key);
  if (message === undefined) throw new Error('unknown key ' + key);
  return message;
}

function build(o: JsonObject, files: readonly DiagnosticFile[]): Diagnostic {
  const index = num(o, 'file');
  const file = index >= 0 ? files[index] : undefined;
  const diagnostic = new Diagnostic(file, num(o, 'pos'), num(o, 'end'), lookup(str(o, 'key')), strings(o, 'args'));
  for (const chain of items(o, 'chain')) diagnostic.addMessageChain(build(object(chain), files));
  for (const related of items(o, 'related')) diagnostic.addRelatedInfo(build(object(related), files));
  return diagnostic;
}

function safely(locale: string, key: string, args: readonly string[]): string {
  try {
    return localizeMessage(parseLocale(locale), lookup(key), args);
  } catch (e) {
    return 'panic: ' + (e instanceof Error ? e.message : '');
  }
}

function render(o: JsonObject): string {
  const files: DiagnosticFile[] = [];
  for (const f of items(o, 'files')) files.push(new DiagnosticFile(str(object(f), 'name'), str(object(f), 'text')));
  const diagnostics: Diagnostic[] = [];
  for (const d of items(o, 'diagnostics')) diagnostics.push(build(object(d), files));
  const newLine = str(o, 'newLine');
  const useCaseSensitiveFileNames = o.entries.get('useCaseSensitiveFileNames');
  const options: DiagnosticFormatOptions = {
    locale: parseLocale(str(o, 'locale')),
    currentDirectory: str(o, 'currentDirectory'),
    useCaseSensitiveFileNames:
      useCaseSensitiveFileNames !== undefined &&
      useCaseSensitiveFileNames.type === 'boolean' &&
      useCaseSensitiveFileNames.value,
    newLine,
  };
  const flattened: string[] = [];
  const status: string[] = [];
  for (const d of diagnostics) {
    flattened.push(flattenDiagnosticMessage(d, newLine, options.locale));
    status.push(formatDiagnosticStatus('12:34:56 PM', d, options));
    status.push(formatDiagnosticStatusWithColor('12:34:56 PM', d, options));
  }
  return (
    `{"plain":${q(formatDiagnostics(diagnostics, options))},` +
    `"pretty":${q(formatDiagnosticsWithColorAndContext(diagnostics, options))},` +
    `"summary":${q(formatErrorSummary(diagnostics, options))},` +
    `"flattened":${list(flattened)},"status":${list(status)}}`
  );
}

const request = object(parseJson(readFileSync(process.argv[2], 'utf8')));
const out: string[] = [];

const messages: string[] = [];
for (let i = 0; i < messageCount; i++) {
  const m = i as DiagnosticMessage;
  messages.push(
    `{"code":${messageCode(m)},"category":${q(categoryName(messageCategory(m)))},"key":${q(messageKey(m))},` +
      `"text":${q(messageText(m))},"flags":${messageFlags[m]}}`,
  );
}
out.push(`"messages":[${messages.join(',')}]`);

const localized: string[] = [];
for (const tag of strings(request, 'locales')) {
  const locale = parseLocale(tag);
  const texts: string[] = [];
  for (let i = 0; i < messageCount; i++) texts.push(localizeMessage(locale, i as DiagnosticMessage, []));
  localized.push(`${q(tag)}:${list(texts)}`);
}
out.push(`"localized":{${localized.join(',')}}`);

const matches: string[] = [];
for (const tag of strings(request, 'matches')) {
  matches.push(localizeMessage(parseLocale(tag), Diagnostics.Identifier_expected, []));
}
out.push(`"matches":${list(matches)}`);

const formats: string[] = [];
for (const f of items(request, 'formats')) {
  const o = object(f);
  formats.push(safely(str(o, 'locale'), str(o, 'key'), strings(o, 'args')));
}
out.push(`"formats":${list(formats)}`);

const renders: string[] = [];
for (const r of items(request, 'renders')) renders.push(render(object(r)));
out.push(`"renders":[${renders.join(',')}]`);

process.stdout.write(`{${out.join(',')}}\n`);
