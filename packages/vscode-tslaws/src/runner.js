'use strict';

// Starts one `tslaws check` and turns its output into events. `spawn` is injected so tests can run it without a process.
// With a tslaws that streams (`--reporter ndjson`) results arrive law by law; with an older one, the `--json` report
// arrives at the end and is replayed as the same events.

const { createStreamParser, parseReport } = require('./parse-report.js');

/**
 * @param {{
 *   spawn: typeof import('node:child_process').spawn,
 *   command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv,
 *   streaming: boolean,
 *   onEvent: (event: object) => void,
 *   onLog?: (text: string) => void,
 * }} o
 * @returns {{cancel: () => void, done: Promise<{code: number | null, cancelled: boolean, report: object | null, error?: string}>}}
 */
function startCheck(o) {
  const log = o.onLog ?? (() => {});
  let cancelled = false;
  let report = null;
  let stdout = '';
  let stderr = '';
  const parser = createStreamParser((event) => {
    if (event.type === 'report') report = event.report;
    o.onEvent(event);
  }, log);
  const child = o.spawn(o.command, o.args, { cwd: o.cwd, env: o.env, shell: false });
  const done = new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on('data', (d) => {
      if (o.streaming) parser.write(String(d));
      else stdout += d;
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => settle({ code: null, cancelled, report: null, error: `failed to start: ${e.message}` }));
    child.on('close', (code) => {
      if (cancelled) return settle({ code, cancelled: true, report: null });
      if (o.streaming) parser.end();
      else if (stdout.trim() !== '') {
        try {
          report = parseReport(stdout);
          for (const record of report.records) o.onEvent({ type: 'result', record });
          o.onEvent({ type: 'report', report });
        } catch (e) {
          return settle({
            code,
            cancelled,
            report: null,
            error: `could not read the report: ${e.message}\n${stdout}\n${stderr}`.trim(),
          });
        }
      }
      if (stderr.trim() !== '') log(stderr.trim());
      if (report === null)
        return settle({
          code,
          cancelled,
          report: null,
          error: stderr.trim() === '' ? 'tslaws printed no report' : stderr.trim(),
        });
      settle({ code, cancelled, report });
    });
  });
  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      child.kill();
    },
    done,
  };
}

/** Whether a tslaws prints events and filters laws, read from its `--help`. Older ones are run the old way. */
function liveSupport(helpText) {
  const text = String(helpText);
  return { streaming: /ndjson/.test(text), lawFilter: /--law\b/.test(text) };
}

/**
 * The tslaws arguments for a request.
 * @param {{files: string[] | null, laws?: string[], args?: string[]}} request files null means every laws file
 * @param {{streaming: boolean, lawFilter: boolean}} support
 */
function checkArguments(request, support) {
  const args = ['check', ...(support.streaming ? ['--reporter', 'ndjson'] : ['--json'])];
  if (request.laws !== undefined && request.laws.length > 0 && support.lawFilter)
    args.push('--law', request.laws.join(','));
  args.push(...(request.args ?? []));
  if (request.files !== null) args.push(...request.files);
  return args;
}

module.exports = { startCheck, liveSupport, checkArguments };
