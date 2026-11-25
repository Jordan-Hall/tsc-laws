// The extension's behaviour: when to run laws, what a run updates, and the commands. `vscode` and the process and file
// APIs are passed in (extension.js is the only file that requires `vscode`), so the whole of it runs under a fake host in
// tests. The pure modules decide; this file only wires them to the editor.

import nodePath from 'node:path';
import { parseUiUrl, relativeTo } from './parse-report.js';
import { summaryText, allPass } from './summary.js';
import { resolveCommand, acceptCommandText } from './command.js';
import { merge, functionIndex, coverageMap, blamedFunctions } from './model.js';
import { buildDiagnostics } from './diagnostics.js';
import { lawRange, declarationRange } from './ranges.js';
import { reproduceCommand } from './format.js';
import { planRun, isRunnable } from './plan.js';
import { createScheduler } from './scheduler.js';
import { startCheck, liveSupport, checkArguments } from './runner.js';
import { createShadow } from './shadow.js';
import { resolveRunMode, explicitValue, clampInt, liveEnabled } from './settings.js';
import { createEditor } from './editor.js';
import { createTesting } from './testing.js';
import { createStatusDecorations } from './status-decor.js';
import { createLawsTree } from './laws-tree.js';
import { createLiveGuard, createCpuSampler } from './live-guard.js';
import { saveCache, loadCache } from './live-cache.js';
import { proposedPath, lawSkeleton, addToProposed } from './law-skeleton.js';
import { createNavigation } from './navigation.js';
import { ensurePlugin } from './plugin.js';
import { compileDiagnostics } from './compile-diagnostics.js';
import { parseList, fromName, badgeFor } from './list.js';
import { findLaws } from './find-laws.js';
import { locate, locateIn, labelOf, describeProject } from './projects.js';

const key = (file, name) => `${file}::${name}`;

/**
 * @param {typeof import('vscode')} vscode
 * @param {{subscriptions: {dispose(): unknown}[]}} context
 * @param {{spawn: typeof import('node:child_process').spawn, fs: typeof import('node:fs'), now?: () => number}} io
 */
function activateExtension(vscode, context, io) {
  const { spawn, fs } = io;
  const cpus = io.cpus ?? (() => []);
  const now = io.now ?? Date.now;
  const output = vscode.window.createOutputChannel('tslaws');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'tslawsLaws.focus';
  const projectStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  projectStatus.command = 'tslaws.showProject';

  let progress = null;
  let cacheTimer = null;
  let nav = null;
  const dashboards = new Map();
  let active = null;
  let complained = false;
  let ready = Promise.resolve();
  let rebuildTimer = null;
  const supportCache = new Map();
  const shadows = new Map();

  const canonicalPath = (p) => {
    const normalised = nodePath.normalize(p).replace(/[\\/]+$/, '');
    if (/^[a-zA-Z]:/.test(normalised)) {
      try {
        const real = fs.realpathSync?.native?.(normalised);
        if (typeof real === 'string' && real.toLowerCase() === normalised.toLowerCase()) return real;
      } catch {
        // Fall back to uppercasing the drive letter when the path cannot be resolved.
      }
      return normalised.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());
    }
    return normalised;
  };
  const stateKey = (dir) => (dir === '' ? '' : canonicalPath(dir));

  // Everything the editor shows belongs to one project (the nearest tslaws.json above a file). Each project has its own
  // state; `project` is the one the open file is in, and the views, the status bar and the commands follow it. A run
  // keeps the state it started with, so switching files while it goes cannot mix two projects' results.
  const folders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => canonicalPath(f.uri.fsPath));
  const projectIo = { fs, path: nodePath };
  const states = new Map();
  const stateOf = (dir) => {
    const k = stateKey(dir);
    let st = states.get(k);
    if (st === undefined) {
      const ranAt = new Map();
      st = {
        /** @type {object[] | null} */
        records: null,
        /** What the compiler printed in the last run: its law rules (TS9101 to TS9106) are shown as diagnostics. */
        compilerText: '',
        /** @type {Map<string, number>} */
        ranAt,
        /** Laws of the run that is going and have not reported yet: `file::name`. */
        runningLaws: new Set(),
        /** When each project file was last edited in the editor (ms), for the `stale` status. */
        touched: new Map(),
        view: { records: null, ranAt, descs: new Map(), index: new Map(), coverage: new Map() },
        lawFiles: [],
        /** What `tslaws list` said about each laws file (or the file names, for an older tslaws), by project-relative path. */
        listed: new Map(),
        cacheLoaded: false,
        listLoaded: false,
      };
      states.set(k, st);
    }
    return st;
  };
  const forFile = (file) => locate(canonicalPath(file), folders(), projectIo);
  /** The project of the file in the editor, else of the first workspace folder. */
  let project = (() => {
    const open = vscode.window.activeTextEditor?.document.uri;
    const first = folders()[0];
    return (
      (open?.scheme === 'file' ? forFile(open.fsPath) : undefined) ?? (first && locateIn(first, folders(), projectIo))
    );
  })();
  let cur = stateOf(project?.dir ?? '');

  const root = () => project?.dir;
  const config = () => vscode.workspace.getConfiguration('tslaws');
  const runMode = () =>
    resolveRunMode({
      explicitRun: explicitValue(config().inspect?.('run')),
      runOnSave: config().get('runOnSave', true),
    });
  const delayMs = () => clampInt(config().get('debounceMs', 600), 100, 10000, 600);
  const hasConfig = () => {
    const base = root();
    return base !== undefined && fs.existsSync(nodePath.join(base, 'tslaws.json'));
  };
  const guard = createLiveGuard({
    busy: (() => {
      const sampler = createCpuSampler(cpus);
      return () => sampler.read();
    })(),
    limit: () => clampInt(config().get('liveCpuLimit', 85), 10, 100, 85) / 100,
    maxSeconds: () => clampInt(config().get('liveMaxSeconds', 30), 1, 3600, 30),
  });
  /** Live results: a run after you stop typing, on the text of the open buffers, held back by the guard. */
  const liveOn = () =>
    liveEnabled({
      setting: config().get('liveBackground', 'auto'),
      hasConfig: hasConfig(),
      runExplicit: explicitValue(config().inspect?.('run')) !== undefined,
      paused: guard.paused || guard.stoppedBySpeed !== null,
    });
  const effectiveMode = () => (liveOn() ? 'onType' : runMode());
  const userCommand = (sub, at = { root: root(), ceiling: project?.folder }) =>
    resolveCommand(
      { root: at.root, ceiling: at.ceiling, executable: config().get('executable'), args: config().get('args') },
      sub,
    );
  const samePath = (a, b) => nodePath.normalize(a).toLowerCase() === nodePath.normalize(b).toLowerCase();

  /** The text of a project file as the editor has it: the open buffer, else the file on disk. */
  const readText = (rel) => {
    const base = root();
    if (base === undefined) return undefined;
    const full = nodePath.join(base, rel);
    const open = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, full));
    if (open !== undefined) return open.getText();
    try {
      return fs.readFileSync(full, 'utf8');
    } catch {
      return undefined;
    }
  };

  const knownLawFiles = () => [
    ...new Set([...cur.lawFiles, ...(cur.records ?? []).map((r) => r.file).filter((f) => f.endsWith('.laws.ts'))]),
  ];
  const isLawsFile = (rel) =>
    knownLawFiles().includes(rel) || (rel.endsWith('.laws.ts') && !rel.endsWith('.proposed.laws.ts'));

  // ---- views ----
  const editor = createEditor(vscode, {
    root,
    view: () => cur.view,
    readText,
    isLawsFile,
    inlineEnabled: () => config().get('inlineCounterexample', true),
  });

  const paramsOf = (file, name) => {
    const text = readText(file);
    return text === undefined ? [] : (findLaws(text).find((l) => l.name === name)?.params ?? []);
  };
  const statusContext = () => ({
    recordOf: (file, name) => cur.records?.find((r) => r.file === file && r.name === name),
    paramsOf,
    isRunning: (file, name) => cur.runningLaws.has(key(file, name)),
    ranAt: (file, name) => cur.ranAt.get(key(file, name)),
    touched: (file) => cur.touched.get(file) ?? 0,
    now: now(),
  });
  const statusDecor = createStatusDecorations(vscode, {
    root,
    view: () => cur.view,
    readText,
    statusContext,
    inlineEnabled: () => config().get('inlineCounterexample', true),
    commandUri: (command, args) => `command:${command}?${encodeURIComponent(JSON.stringify(args))}`,
  });
  const lawsTree = createLawsTree(vscode, { records: () => cur.records, ranAt: () => cur.ranAt, now, paramsOf });

  const updateStatus = () => {
    const running = progress !== null;
    const { records } = cur;
    const text = summaryText(
      records,
      running ? { running, done: progress.done, total: progress.total, fresh: progress.fresh } : {},
    );
    const paused = guard.paused || guard.stoppedBySpeed !== null;
    const live = liveOn();
    status.text = `${running ? '$(sync~spin) ' : paused ? '$(debug-pause) ' : ''}${text}`;
    status.tooltip = running
      ? 'tslaws: a check is running. Click to open the Laws view.'
      : guard.stoppedBySpeed !== null
        ? `tslaws: live results stopped, the last run took ${guard.stoppedBySpeed}s. Run "tslaws: pause/resume live results" to resume.`
        : paused
          ? 'tslaws: live results are paused. Click to open the Laws view.'
          : live
            ? 'tslaws: live results are on. Click to open the Laws view.'
            : 'tslaws: open the Laws view';
    status.accessibilityInformation = { label: text, role: 'button' };
    status.backgroundColor =
      records !== null && !running && !allPass(records)
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    status.show();
    if (project === undefined) projectStatus.hide?.();
    else {
      const label = labelOf(project, folders());
      projectStatus.text = `$(folder) tslaws: ${label}`;
      projectStatus.tooltip = describeProject(project, folders(), projectIo).join('\n');
      projectStatus.accessibilityInformation = { label: `tslaws project ${label}`, role: 'button' };
      projectStatus.show();
    }
  };

  const withCompiler = (descs, read) => {
    if (cur.compilerText === '' || root() === undefined) return descs;
    for (const [file, list] of compileDiagnostics(cur.compilerText, read, (f) => relativeTo(f, root())))
      descs.set(file, [...(descs.get(file) ?? []), ...list]);
    return descs;
  };

  const failingSummary = () => {
    const failed = (cur.records ?? []).filter((r) => r.status === 'failed').length;
    return failed > 0 ? `${failed} failing` : cur.records === null ? '' : 'all passing';
  };

  /** Rebuild everything shown from the records and the text as it is now. */
  const setHasLaws = () =>
    vscode.commands.executeCommand(
      'setContext',
      'tslaws.hasLaws',
      cur.lawFiles.length > 0 || (cur.records?.length ?? 0) > 0,
    );
  const rebuild = () => {
    const memo = new Map();
    const read = (rel) => (memo.has(rel) ? memo.get(rel) : (memo.set(rel, readText(rel)), memo.get(rel)));
    const { records, ranAt } = cur;
    cur.view = {
      records,
      ranAt,
      descs: withCompiler(records === null ? new Map() : buildDiagnostics(records, read), read),
      index: records === null ? new Map() : functionIndex(records),
      coverage: records === null ? new Map() : coverageMap(records),
    };
    nav?.invalidate();
    editor.refresh();
    for (const e of vscode.window.visibleTextEditors) statusDecor.decorate(e);
    lawsTree.refresh();
    lawsTree.setSummary(failingSummary());
    void setHasLaws();
    updateStatus();
  };
  const rebuildSoon = () => {
    if (rebuildTimer !== null) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      rebuild();
    }, 120);
  };

  // ---- running ----
  const warn = (message, always) => {
    output.appendLine(`tslaws: ${message}`);
    if (always || !complained) void vscode.window.showWarningMessage(`tslaws: ${message}`);
    if (!always) complained = true;
  };

  const probe = (cmd, cwd) => {
    const id = [cwd, cmd.command, ...cmd.args].join('\0');
    if (!supportCache.has(id)) {
      supportCache.set(
        id,
        new Promise((resolve) => {
          let text = '';
          const child = spawn(cmd.command, cmd.args, { cwd, shell: false });
          child.stdout.on('data', (d) => (text += d));
          child.on('error', () => resolve(liveSupport('')));
          child.on('close', () => resolve(liveSupport(text)));
        }),
      );
    }
    return supportCache.get(id);
  };

  /** Keep the last report of each project that has a new one on disk, so it survives a reload. */
  const cacheDirty = new Set();
  const cacheSoon = (dir) => {
    cacheDirty.add(dir);
    if (cacheTimer !== null) clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      for (const at of cacheDirty) {
        const { records, ranAt, compilerText } = stateOf(at);
        if (records !== null) saveCache({ fs, path: nodePath, root: at }, { records, ranAt, compilerText });
      }
      cacheDirty.clear();
    }, 400);
  };

  /** Unsaved TypeScript buffers of the project in `base`, keyed by project-relative path. */
  const overlays = (base) => {
    const out = new Map();
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty || doc.uri.scheme !== 'file') continue;
      const rel = relativeTo(doc.uri.fsPath, base);
      if (rel !== doc.uri.fsPath.replaceAll('\\', '/') && isRunnable(rel)) out.set(rel, doc.getText());
    }
    return out;
  };

  /**
   * Run `tslaws check` for a request and fold its results into what the editor shows. Only one run goes at a time: a
   * newer one stops the one before it. `listener` sees every event (the Test Explorer uses it). The run is in the project
   * the request names (`project`, a directory), else the current one; with `all` it is a run from the workspace folder
   * `folder`, which a monorepo root fans out over its projects, each result carrying the project it belongs to.
   */
  const launch = (request, listener = () => {}) => {
    let child = null;
    let cancelled = false;
    const handle = {
      cancel() {
        cancelled = true;
        child?.cancel();
      },
      done: null,
    };
    const before = active;
    active = handle;
    handle.done = (async () => {
      if (before !== null) {
        before.cancel();
        await before.done.catch(() => {});
      }
      const base = request.all ? request.folder : (request.project ?? root());
      if (cancelled) return { cancelled: true };
      if (base === undefined) {
        if (!request.auto) warn('open a folder first.', true);
        return { error: 'no folder is open' };
      }
      if (!vscode.workspace.isTrusted) {
        if (!request.auto) warn('trust this workspace to run its checks.', true);
        return { error: 'the workspace is not trusted' };
      }
      const ceiling = request.all ? base : (locateIn(base, folders(), projectIo)?.folder ?? base);
      const at = { root: base, ceiling };
      const probing = userCommand(['check', '--help'], at);
      if ('error' in probing) {
        warn(probing.error, !request.auto);
        return { error: probing.error };
      }
      const support = await probe(probing, base);
      if (cancelled) return { cancelled: true };
      if (request.all && !support.streaming) {
        warn('checking every project needs a newer tslaws (one that streams with --reporter ndjson).', true);
        return { error: 'tslaws is too old for a run from the monorepo root' };
      }
      const st = stateOf(base);
      /** The project directory a streamed event belongs to: the one it is tagged with, for a run from the root. */
      const dirFor = (event) =>
        request.all && typeof event.project === 'string'
          ? event.project === '.'
            ? base
            : nodePath.join(base, event.project)
          : base;
      const stateFor = (event) => stateOf(dirFor(event));
      let cwd = base;
      const buffers = !request.all && request.auto && effectiveMode() === 'onType' ? overlays(base) : new Map();
      if (buffers.size > 0) {
        if (!shadows.has(base)) shadows.set(base, createShadow({ root: base, fs }));
        const shadow = shadows.get(base);
        const synced = shadow.sync(buffers);
        if (synced.ok) cwd = shadow.dir;
        else output.appendLine(`tslaws: running on the saved files, not the open buffers (${synced.reason})`);
      }
      const cmd = userCommand(checkArguments(request, support), at);
      if ('error' in cmd) {
        warn(cmd.error, !request.auto);
        return { error: cmd.error };
      }
      const snapshot = st.records;
      progress = { done: 0, total: 0, fresh: [] };
      updateStatus();
      output.appendLine(`> ${cmd.command} ${cmd.args.join(' ')}${cwd === base ? '' : '   (on the open buffers)'}`);
      const run = startCheck({
        spawn,
        command: cmd.command,
        args: cmd.args,
        cwd,
        streaming: support.streaming,
        onLog: (text) => output.appendLine(text),
        onEvent: (event) => {
          if (progress === null) {
            // The run was stopped; what it still says is of no interest.
          } else if (event.type === 'plan') {
            const target = stateFor(event);
            if (request.all) progress.total += event.laws.length;
            else progress.total = request.laws !== undefined ? request.laws.length : event.laws.length;
            target.runningLaws.clear();
            for (const l of event.laws) target.runningLaws.add(key(l.file, l.name));
            rebuildSoon();
          } else if (event.type === 'result') {
            const target = stateFor(event);
            target.runningLaws.delete(key(event.record.file, event.record.name));
            progress.done++;
            progress.fresh.push(event.record);
            target.records = [
              ...(target.records ?? []).filter(
                (r) => key(r.file, r.name) !== key(event.record.file, event.record.name),
              ),
              event.record,
            ];
            target.ranAt.set(key(event.record.file, event.record.name), now());
            rebuildSoon();
          } else if (event.type === 'report') {
            if (event.report.compileDiagnostics !== '') output.appendLine(event.report.compileDiagnostics);
            if (request.all) {
              // Each project of a root run ends with its own report, which covers all of that project.
              const target = stateFor(event);
              target.runningLaws.clear();
              target.compilerText = event.report.compileDiagnostics;
              target.records = event.report.records;
              for (const r of event.report.records)
                target.ranAt.set(key(r.file, r.name), target.ranAt.get(key(r.file, r.name)) ?? now());
              cacheSoon(dirFor(event));
            }
          }
          listener(event);
        },
      });
      child = run;
      if (cancelled) run.cancel();
      const outcome = await run.done;
      progress = null;
      st.runningLaws.clear();
      if (request.all) {
        for (const other of states.values()) other.runningLaws.clear();
        if (outcome.error !== undefined) output.appendLine(`tslaws: ${outcome.error}`);
      } else if (outcome.report !== null && !outcome.cancelled) {
        st.compilerText = outcome.report.compileDiagnostics;
        cacheSoon(base);
        st.records = merge(snapshot ?? [], outcome.report.records, {
          files: request.files,
          laws: request.laws ?? null,
        });
        for (const r of outcome.report.records)
          st.ranAt.set(key(r.file, r.name), st.ranAt.get(key(r.file, r.name)) ?? now());
      } else if (outcome.error !== undefined) {
        output.appendLine(`tslaws: ${outcome.error}`);
        if (!request.auto) void vscode.window.showErrorMessage(`tslaws: ${outcome.error.split('\n')[0]}`);
      }
      if (rebuildTimer !== null) clearTimeout(rebuildTimer);
      rebuildTimer = null;
      rebuild();
      return outcome;
    })();
    void handle.done.then(
      () => {
        if (active === handle) active = null;
      },
      (e) => {
        output.appendLine(`tslaws: ${e.message}`);
        progress = null;
        if (active === handle) active = null;
        rebuild();
      },
    );
    return handle;
  };

  // One scheduler per project: its requests name files relative to that project, so they never mix with another's.
  const schedulers = new Map();
  const schedulerFor = (dir) => {
    let scheduler = schedulers.get(dir);
    if (scheduler === undefined) {
      scheduler = createScheduler({
        delayMs,
        start: (request) => {
          const began = now();
          const handle = launch({ ...request, auto: true, project: dir });
          guard.started();
          void handle.done.then(
            (outcome) => {
              guard.finished(outcome?.cancelled ? 0 : now() - began);
              if (guard.stoppedBySpeed !== null) {
                output.appendLine(
                  `tslaws: live results stopped: the last run took ${guard.stoppedBySpeed}s. Resume them with "tslaws: pause/resume live results".`,
                );
                updateStatus();
              }
            },
            () => guard.finished(0),
          );
          return handle;
        },
      });
      schedulers.set(dir, scheduler);
    }
    return scheduler;
  };
  const scheduler = {
    for: schedulerFor,
    cancel: () => schedulers.forEach((s) => s.cancel()),
  };

  /** A file changed: choose the laws that cover it and ask for a run. */
  let busyTimer = null;
  const busyDocs = new Map();
  const changed = (doc, live = false) => {
    if (doc.uri.scheme !== 'file' || root() === undefined) return;
    if (live) {
      const verdict = guard.check();
      if (!verdict.ok && verdict.reason === 'busy') {
        // The machine is busy: look again in a few seconds, once.
        busyDocs.set(doc.uri.fsPath, doc);
        if (busyTimer === null)
          busyTimer = setTimeout(() => {
            busyTimer = null;
            const waiting = [...busyDocs.values()];
            busyDocs.clear();
            for (const d of waiting) changed(d, true);
          }, 4000);
        return;
      }
      if (!verdict.ok && verdict.reason !== 'running') return;
    }
    const owner = forFile(doc.uri.fsPath);
    // A file in no workspace folder, or in a monorepo root but in none of its projects, has no laws to run.
    if (owner === undefined || owner.kind === 'root') return;
    adopt(owner);
    const rel = relativeTo(doc.uri.fsPath, owner.dir);
    // The first search for laws files may still be going when the first edit arrives.
    void ready.then(() => {
      const st = stateOf(owner.dir);
      const known = [
        ...new Set([...st.lawFiles, ...(st.records ?? []).map((r) => r.file).filter((f) => f.endsWith('.laws.ts'))]),
      ];
      const plan = planRun({ file: rel, lawFiles: known, coverage: st.view.coverage });
      if (plan.files !== null && plan.files.length === 0) return;
      schedulerFor(owner.dir).request({ files: plan.files, reason: plan.reason, args: [] });
    });
  };

  // A file that declares laws (whatever its name) or touches the browser or end-to-end API may have changed which files
  // are laws files or the level one runs at; ask the tool again.
  const levelMayHaveChanged = (doc) => {
    if (doc.uri.scheme !== 'file' || root() === undefined) return;
    const owner = forFile(doc.uri.fsPath);
    if (owner === undefined || owner.kind === 'root') return;
    adopt(owner);
    const rel = relativeTo(doc.uri.fsPath, owner.dir);
    const text = doc.getText();
    if (isLawsFile(rel) || findLaws(text).length > 0 || /tslaws\/(?:browser|e2e|adapters)/.test(text))
      ready = refreshLawFiles();
  };

  const runNow = (request) => {
    scheduler.cancel();
    return launch(request).done;
  };

  /** Every project: one run from each workspace folder, which a monorepo root fans out over its projects. */
  const checkAll = async () => {
    scheduler.cancel();
    for (const folder of folders()) await launch({ all: true, folder, files: null }).done;
  };

  // ---- Test Explorer ----
  const testing = createTesting(vscode, {
    root,
    lawFiles: async () => {
      await loading;
      return knownLawFiles();
    },
    readText,
    record: (file, name) => cur.records?.find((r) => r.file === file && r.name === name),
    launch: (request, listener) => {
      scheduler.cancel();
      return launch(request, listener);
    },
  });

  // ---- commands ----
  const recordOf = (file, name) => cur.records?.find((r) => r.file === file && r.name === name);
  const open = async (file, range) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(nodePath.join(root(), file)));
    const shown = await vscode.window.showTextDocument(doc);
    if (range !== null && range !== undefined) {
      const r = new vscode.Range(range.line, range.start, range.line, range.end);
      shown.selection = new vscode.Selection(r.start, r.end);
      shown.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  };
  const openLaw = (file, name) => open(file, lawRange(readText(file) ?? '', name));
  const openSource = (file, name) => {
    const record = recordOf(file, name);
    const target = record === undefined ? undefined : blamedFunctions(record)[0]?.exercise;
    if (target === undefined) return openLaw(file, name);
    const text = readText(target.declaration.file);
    return open(
      target.declaration.file,
      text === undefined ? null : declarationRange(text, target.declaration, target.name),
    );
  };
  const copyReproduce = async (file, name) => {
    const record = recordOf(file, name);
    if (record === undefined) return;
    const text = reproduceCommand(record);
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(`tslaws: copied \`${text}\``);
  };
  nav = createNavigation(vscode, {
    root,
    records: () => cur.records,
    lawFiles: knownLawFiles,
    readText,
    exists: (rel) => {
      const base = root();
      return base !== undefined && fs.existsSync(nodePath.join(base, rel));
    },
    open,
    paramsOf,
  });
  const openFunction = (file, name, line) => {
    const text = readText(file) ?? '';
    return open(file, declarationRange(text, { line: line ?? 1, column: 0 }, name));
  };
  /** Write a first, proposed law for a function: only in a `*.proposed.laws.ts` file, never in an accepted laws file or the lock. */
  const writeLaw = async (file, name) => {
    const target = proposedPath(file);
    const base = root();
    if (target === null || base === undefined) {
      void vscode.window.showWarningMessage(
        'tslaws: a law can be proposed for a function in a TypeScript source file.',
      );
      return;
    }
    const sourceText = readText(file);
    if (sourceText === undefined) return;
    const full = nodePath.join(base, target);
    let existing = '';
    try {
      existing = fs.readFileSync(full, 'utf8');
    } catch {
      // a new file
    }
    const { text, added } = addToProposed(existing, name, lawSkeleton({ name, sourceRel: file, sourceText }));
    if (added) fs.writeFileSync(full, text);
    await open(target, lawRange(text, `${name}Holds`));
    void vscode.window.showInformationMessage(
      added
        ? `tslaws: proposed a law for ${name} in ${target}. It is not accepted: check it with npx tslaws check --proposed.`
        : `tslaws: ${target} already has a law for ${name}.`,
    );
  };
  const toggleLive = () => {
    const paused = guard.toggle();
    if (!paused && guard.stoppedBySpeed === null) scheduler.cancel();
    void vscode.window.showInformationMessage(
      paused ? 'tslaws: live results are paused.' : 'tslaws: live results are on.',
    );
    rebuild();
  };
  const runFile = (uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (target === undefined || root() === undefined) return runNow({ files: null });
    const owner = forFile(target.fsPath);
    if (owner === undefined || owner.kind === 'root') return runNow({ files: null });
    adopt(owner);
    return runNow({ files: [relativeTo(target.fsPath, owner.dir)], project: owner.dir });
  };

  const showProject = () => {
    if (project === undefined) {
      void vscode.window.showInformationMessage('tslaws: open a folder first.');
      return;
    }
    void vscode.window.showInformationMessage(describeProject(project, folders(), projectIo).join('\n'));
  };

  const openDashboard = () => {
    const cwd = root();
    if (cwd === undefined) return;
    const dashboard = dashboards.get(cwd) ?? null;
    if (dashboard !== null && dashboard.url !== null) return vscode.env.openExternal(vscode.Uri.parse(dashboard.url));
    if (dashboard !== null) return;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('tslaws: trust this workspace to open the dashboard.');
      return;
    }
    const cmd = userCommand(['ui', '--no-open', '--port', '0']);
    if ('error' in cmd) {
      void vscode.window.showWarningMessage(`tslaws: ${cmd.error}`);
      return;
    }
    const child = spawn(cmd.command, cmd.args, { cwd, shell: false });
    const mine = { child, url: null };
    dashboards.set(cwd, mine);
    const onData = (d) => {
      output.append(String(d));
      if (mine.url !== null) return;
      const url = parseUiUrl(String(d));
      if (url !== null) {
        mine.url = url;
        void vscode.env.openExternal(vscode.Uri.parse(url));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      void vscode.window.showErrorMessage(`tslaws ui failed to start: ${e.message}`);
      dashboards.delete(cwd);
    });
    child.on('close', () => dashboards.delete(cwd));
  };

  // Never runs accept: a person presses Enter in the terminal.
  const accept = () => {
    const terminal = vscode.window.createTerminal({ name: 'tslaws accept', cwd: root() });
    terminal.show();
    terminal.sendText(acceptCommandText(), false);
  };

  /** Asks the project's tslaws which files are laws files; null when it cannot say (not trusted, not installed, too old). */
  const askList = (at) =>
    new Promise((resolve) => {
      const cmd = userCommand(['list', '--json'], at);
      if ('error' in cmd || !vscode.workspace.isTrusted) return resolve(null);
      let text = '';
      const child = spawn(cmd.command, cmd.args, { cwd: at.root, shell: false });
      child.stdout.on('data', (d) => (text += d));
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(parseList(text)));
    });

  let loading = Promise.resolve();
  const loadLawFiles = async () => {
    const owner = project;
    if (owner === undefined) return;
    const st = stateOf(owner.dir);
    const answer = await askList({ root: owner.dir, ceiling: owner.folder });
    if (answer !== null) {
      // The tool's answer: laws files of the tree at the level the project's `levels` setting gives them (names by default), plus proposals (badged, never run as laws).
      st.listed = new Map(answer.map((f) => [f.file, f]));
      st.lawFiles = answer.filter((f) => f.status !== 'proposed').map((f) => f.file);
    } else {
      // An older tslaws, or none yet: look for the conventional names, in this project and not in those nested in it.
      const found = await vscode.workspace.findFiles('**/*.laws.ts', '**/{node_modules,.tslaws}/**');
      st.lawFiles = found
        .map((u) => canonicalPath(u.fsPath))
        .filter((file) => {
          const fileOwner = forFile(file);
          return fileOwner !== undefined && samePath(fileOwner.dir, owner.dir);
        })
        .map((file) => relativeTo(file, owner.dir));
      st.listed = new Map(st.lawFiles.map((f) => [f, fromName(f)]));
    }
    st.listLoaded = true;
  };

  const refreshLawFiles = async () => {
    loading = loadLawFiles();
    await loading;
    void setHasLaws(); // the Laws view is gated on tslaws.hasLaws, which depends on this list
    decorations.fire(undefined);
    await testing.discover();
  };

  /** The report a project had when the folder was last open; a file edited since is `stale` until a run covers it. */
  const loadReport = (dir) => {
    const st = stateOf(dir);
    if (st.cacheLoaded) return;
    st.cacheLoaded = true;
    const cached = loadCache({ fs, path: nodePath, root: dir });
    if (cached === null) return;
    st.records = cached.records;
    for (const [k, at] of cached.ranAt) st.ranAt.set(k, at);
    st.compilerText = cached.compilerText;
    const files = new Set(st.records.flatMap((r) => [r.file, ...(r.exercises ?? []).map((e) => e.declaration.file)]));
    for (const f of files) {
      try {
        const m = fs.statSync(nodePath.join(dir, f)).mtimeMs;
        if (m > cached.savedAt) st.touched.set(f, m);
      } catch {
        // a file that is gone has nothing to mark
      }
    }
  };

  /** Make `next` the project the views and commands follow (the open file moved into it). */
  const adopt = (next) => {
    if (next === undefined || (project !== undefined && samePath(next.dir, project.dir))) return;
    project = next;
    cur = stateOf(next.dir);
    loadReport(next.dir);
    rebuild();
    if (cur.listLoaded) {
      void setHasLaws();
      void testing.discover();
    } else ready = refreshLawFiles();
  };

  // ---- Explorer badges: the level of each laws file ----
  const decorations = new vscode.EventEmitter();
  const decorationProvider = {
    onDidChangeFileDecorations: decorations.event,
    provideFileDecoration(uri) {
      if (uri.scheme !== 'file') return undefined;
      const owner = forFile(uri.fsPath);
      const entry = owner === undefined ? undefined : stateOf(owner.dir).listed.get(relativeTo(uri.fsPath, owner.dir));
      if (entry === undefined) return undefined;
      const { badge, tooltip, color } = badgeFor(entry);
      return new vscode.FileDecoration(badge, tooltip, new vscode.ThemeColor(color));
    },
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.laws.ts');
  // The "laws" globs of tslaws.json decide which other files are laws files, and proposals show a badge too.
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/tslaws.json');
  const proposalWatcher = vscode.workspace.createFileSystemWatcher('**/.tslaws/proposals/*.ts');
  const lockWatcher = vscode.workspace.createFileSystemWatcher('**/tsc-laws.lock');

  context.subscriptions.push(
    output,
    status,
    projectStatus,
    ...editor.disposables,
    ...testing.disposables,
    ...statusDecor.disposables,
    ...lawsTree.disposables,
    ...nav.disposables,
    watcher,
    configWatcher,
    proposalWatcher,
    lockWatcher,
    decorations,
    vscode.window.registerFileDecorationProvider(decorationProvider),
    configWatcher.onDidChange(() => void refreshLawFiles()),
    configWatcher.onDidCreate(() => void refreshLawFiles()),
    configWatcher.onDidDelete(() => void refreshLawFiles()),
    proposalWatcher.onDidCreate(() => void refreshLawFiles()),
    proposalWatcher.onDidDelete(() => void refreshLawFiles()),
    lockWatcher.onDidChange(() => void refreshLawFiles()),
    lockWatcher.onDidCreate(() => void refreshLawFiles()),
    lockWatcher.onDidDelete(() => void refreshLawFiles()),
    watcher.onDidCreate(() => void refreshLawFiles()),
    watcher.onDidDelete(() => void refreshLawFiles()),
    vscode.commands.registerCommand('tslaws.check', () =>
      project?.kind === 'root' ? checkAll() : runNow({ files: null }),
    ),
    vscode.commands.registerCommand('tslaws.checkAll', checkAll),
    vscode.commands.registerCommand('tslaws.showProject', showProject),
    vscode.commands.registerCommand('tslaws.runFile', runFile),
    vscode.commands.registerCommand('tslaws.runLaw', (file, name) => runNow({ files: [file], laws: [name] })),
    vscode.commands.registerCommand('tslaws.cancel', () => {
      scheduler.cancel();
      active?.cancel();
    }),
    vscode.commands.registerCommand('tslaws.showLaws', (file, name) => nav.goToLaws(file, name)),
    vscode.commands.registerCommand('tslaws.goToLaws', (file, name) => nav.goToLaws(file, name)),
    vscode.commands.registerCommand('tslaws.peekLaws', (file, name) => nav.peekLaws(file, name)),
    vscode.commands.registerCommand('tslaws.goToFunction', (file, name) => nav.goToFunction(file, name)),
    vscode.commands.registerCommand('tslaws.goToLaw', () => nav.goToLaw()),
    vscode.commands.registerCommand('tslaws.openLaw', openLaw),
    vscode.commands.registerCommand('tslaws.openSource', openSource),
    vscode.commands.registerCommand('tslaws.copyReproduce', copyReproduce),
    vscode.commands.registerCommand('tslaws.openDashboard', openDashboard),
    vscode.commands.registerCommand('tslaws.accept', accept),
    vscode.commands.registerCommand('tslaws.writeLaw', writeLaw),
    vscode.commands.registerCommand('tslaws.openFunction', openFunction),
    vscode.commands.registerCommand('tslaws.pauseLive', toggleLive),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file' || !/\.[cm]?tsx?$/.test(e.document.uri.fsPath)) return;
      if (e.contentChanges.length > 0) {
        const owner = forFile(e.document.uri.fsPath);
        if (owner !== undefined) stateOf(owner.dir).touched.set(relativeTo(e.document.uri.fsPath, owner.dir), now());
      }
      rebuildSoon(); // the marks follow the edit
      if (effectiveMode() === 'onType' && e.contentChanges.length > 0) changed(e.document, liveOn());
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/\.[cm]?tsx?$/.test(doc.uri.fsPath)) levelMayHaveChanged(doc);
      if (effectiveMode() !== 'manual' && /\.[cm]?tsx?$/.test(doc.uri.fsPath)) changed(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor?.((e) => {
      if (e?.document.uri.scheme === 'file') adopt(forFile(e.document.uri.fsPath));
    }) ?? { dispose() {} },
    vscode.window.onDidChangeVisibleTextEditors((editors) =>
      editors.forEach((e) => {
        editor.decorate(e);
        statusDecor.decorate(e);
      }),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tslaws')) rebuild();
    }),
    {
      dispose() {
        scheduler.cancel();
        active?.cancel();
        if (rebuildTimer !== null) clearTimeout(rebuildTimer);
        if (busyTimer !== null) clearTimeout(busyTimer);
        if (cacheTimer !== null) clearTimeout(cacheTimer);
        for (const dashboard of dashboards.values()) dashboard.child.kill();
      },
    },
  );

  // tsserver loads the law-syntax plugin from the extension's node_modules; put it there, and restart the server once so
  // it picks the plugin up.
  if (typeof context.extensionPath === 'string') {
    const plugin = ensurePlugin({ fs, path: nodePath, extensionPath: context.extensionPath });
    if (plugin.state === 'error') output.appendLine(`tslaws: could not install the TypeScript plugin: ${plugin.error}`);
    else if (plugin.changed) void vscode.commands.executeCommand('typescript.restartTsServer');
  }

  // The last report survives a reload; a file edited since it was saved is `stale` until a run covers it.
  if (root() !== undefined) {
    loadReport(root());
    if (cur.records !== null) rebuild();
  }

  updateStatus();
  ready = refreshLawFiles();
  void ready.then(() => {
    if (config().get('runOnOpen', false) && effectiveMode() !== 'manual' && cur.lawFiles.length > 0)
      void runNow({ files: null, auto: true });
  });

  return {
    launch,
    scheduler,
    rebuild,
    checkAll,
    state: () => ({ records: cur.records, view: cur.view, active, project, states }),
  };
}

export { activateExtension };
