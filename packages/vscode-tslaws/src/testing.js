'use strict';

// Test Explorer: every law is a test, in the Testing view, with run profiles that map onto `tslaws check`. Results go
// back to the same locations the diagnostics use: the law, and the function it exercises. `vscode` is passed in.

const path = require('node:path');
const { findLaws } = require('./find-laws.js');
const { buildDiagnostics } = require('./diagnostics.js');
const { PASSING } = require('./summary.js');
const { oneLine } = require('./format.js');

const idOf = (file, name) => `${file}::${name}`;

/**
 * @param {typeof import('vscode')} vscode
 * @param {{
 *   root: () => string | undefined,
 *   lawFiles: () => Promise<string[]>,
 *   readText: (rel: string) => string | undefined,
 *   record: (file: string, name: string) => object | undefined,
 *   launch: (request: object, listener: (event: object) => void) => {cancel: () => void, done: Promise<object>},
 * }} host
 */
function createTesting(vscode, host) {
  const controller = vscode.tests.createTestController('tslaws', 'tslaws');
  const uriOf = (rel) => vscode.Uri.file(path.join(host.root(), rel));
  const rangeOf = (r) => new vscode.Range(r.line, r.start, r.line, r.end);

  /** Fill the children of a laws file from its text. */
  const parseFile = (rel, text) => {
    let fileItem = controller.items.get(rel);
    if (fileItem === undefined) {
      fileItem = controller.createTestItem(rel, path.posix.basename(rel), uriOf(rel));
      fileItem.canResolveChildren = true;
      controller.items.add(fileItem);
    }
    const laws = findLaws(text ?? '');
    const names = new Set(laws.map((l) => l.name));
    fileItem.children.forEach((child) => {
      if (!names.has(child.label)) fileItem.children.delete(child.id);
    });
    for (const law of laws) {
      const id = idOf(rel, law.name);
      const item = fileItem.children.get(id) ?? controller.createTestItem(id, law.name, uriOf(rel));
      item.range = rangeOf({ line: law.line, start: law.nameColumn, end: law.nameColumn + law.name.length });
      fileItem.children.add(item);
    }
    return fileItem;
  };

  const discover = async () => {
    const files = new Set(await host.lawFiles());
    controller.items.forEach((item) => {
      if (!files.has(item.id)) controller.items.delete(item.id);
    });
    for (const rel of files) parseFile(rel, host.readText(rel));
  };

  controller.resolveHandler = async (item) => {
    if (item === undefined) await discover();
    else parseFile(item.id, host.readText(item.id));
  };
  controller.refreshHandler = () => discover();

  /** The messages of a failed law: one at the law and one at each function it exercises. */
  const messagesFor = (record) => {
    const out = [];
    for (const [file, descs] of buildDiagnostics([record], host.readText)) {
      for (const d of descs) {
        const message = new vscode.TestMessage(d.message);
        message.location = new vscode.Location(uriOf(file), rangeOf(d.range));
        out.push(message);
      }
    }
    if (out.length === 0) out.push(new vscode.TestMessage(oneLine(record.message ?? record.status)));
    return out;
  };

  const handler = (mode) => async (request, token) => {
    await discover();
    const run = controller.createTestRun(request);
    const excluded = new Set((request.exclude ?? []).map((i) => i.id));
    /** @type {Map<string, {file: object, laws: Map<string, object> | null}>} */
    const wanted = new Map();
    const roots = [];
    controller.items.forEach((item) => roots.push(item));
    const include = request.include ?? roots;
    for (const item of include) {
      if (excluded.has(item.id)) continue;
      const isFile = item.parent === undefined;
      const file = isFile ? item : item.parent;
      const entry = wanted.get(file.id) ?? { file, laws: new Map() };
      if (isFile) entry.laws = null;
      else if (entry.laws !== null) entry.laws.set(item.label, item);
      wanted.set(file.id, entry);
    }
    const leaves = (entry) => (entry.laws === null ? [...flat(entry.file.children)] : [...entry.laws.values()]);
    let jobs = [...wanted.values()].map((entry) => ({
      entry,
      items: leaves(entry).filter((i) => !excluded.has(i.id)),
    }));
    if (mode.failedOnly) {
      jobs = jobs
        .map((j) => ({
          ...j,
          items: j.items.filter((i) => {
            const [file, name] = i.id.split('::');
            const r = host.record(file, name);
            return r !== undefined && !PASSING.has(r.status);
          }),
        }))
        .filter((j) => j.items.length > 0);
    }
    for (const job of jobs) for (const item of job.items) run.enqueued(item);

    // Everything under one file is one run; a few chosen laws are named so the others are not run.
    const wholeProject =
      jobs.length === (await host.lawFiles()).length && jobs.every((j) => j.entry.laws === null) && !mode.failedOnly;
    const requests = wholeProject
      ? [{ job: null, request: { files: null, args: mode.args } }]
      : jobs.map((job) => ({
          job,
          request: {
            files: [job.entry.file.id],
            ...(job.entry.laws === null && !mode.failedOnly ? {} : { laws: job.items.map((i) => i.label) }),
            args: mode.args,
          },
        }));

    for (const { job, request: req } of requests) {
      if (token.isCancellationRequested) break;
      const items = job === null ? jobs.flatMap((j) => j.items) : job.items;
      const byId = new Map(items.map((i) => [i.id, i]));
      const finished = new Set();
      const started = Date.now();
      const running = host.launch(req, (event) => {
        if (event.type === 'start') {
          const item = byId.get(idOf(event.file, event.name));
          if (item !== undefined) run.started(item);
        } else if (event.type === 'result') {
          const record = event.record;
          const item = byId.get(idOf(record.file, record.name));
          if (item === undefined) return;
          finished.add(item.id);
          if (PASSING.has(record.status)) run.passed(item, Date.now() - started);
          else if (record.status === 'error') run.errored(item, messagesFor(record));
          else run.failed(item, messagesFor(record));
        } else if (event.type === 'report' && !event.report.compileOk && event.report.compileDiagnostics !== '') {
          run.appendOutput(event.report.compileDiagnostics.replace(/\r?\n/g, '\r\n') + '\r\n');
        }
      });
      const cancel = token.onCancellationRequested(() => running.cancel());
      const outcome = await running.done;
      cancel.dispose();
      for (const item of items) {
        if (finished.has(item.id)) continue;
        if (outcome.error !== undefined) run.errored(item, new vscode.TestMessage(outcome.error));
        else run.skipped(item);
      }
    }
    run.end();
  };

  const profile = (label, mode, isDefault) =>
    controller.createRunProfile(label, vscode.TestRunProfileKind.Run, handler(mode), isDefault);
  const profiles = [
    profile('Run', { args: [] }, true),
    profile('Rerun failed', { args: [], failedOnly: true }, false),
    profile('Run without the prover', { args: ['--no-prove'] }, false),
  ];

  return { controller, discover, parseFile, profiles, disposables: [controller] };
}

function* flat(collection) {
  const items = [];
  collection.forEach((item) => items.push(item));
  for (const item of items) {
    if (item.children.size === 0) yield item;
    else yield* flat(item.children);
  }
}

module.exports = { createTesting, idOf };
