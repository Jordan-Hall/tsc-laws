'use strict';

// A copy of the project that holds the text of unsaved buffers, so laws can run against what is on screen without
// anything being written to the person's files. It lives in `.tslaws/shadow` (ignored by tslaws and git), shares
// `node_modules` with the project through a link, and is brought up to date by copying only what changed.

const nodeFs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['node_modules', '.git', '.tslaws']);
const MAX_FILES = 6000;
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * @param {{root: string, fs?: typeof nodeFs}} o
 * @returns {{dir: string, sync: (overlays: Map<string, string>) => {ok: true, copied: number} | {ok: false, reason: string}}}
 */
function createShadow(o) {
  const fs = o.fs ?? nodeFs;
  const dir = path.join(o.root, '.tslaws', 'shadow');
  /** @type {Map<string, {size: number, mtimeMs: number, overlay?: string}>} */
  const known = new Map();

  const list = () => {
    const found = [];
    const walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(o.root, rel), { withFileTypes: true })) {
        const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (SKIP.has(entry.name)) continue;
          walk(next);
        } else if (entry.isFile()) found.push(next);
      }
    };
    walk('');
    // The stored counterexamples are replayed first, so they come along.
    const corpus = '.tslaws/regressions';
    if (fs.existsSync(path.join(o.root, corpus))) {
      const walkCorpus = (rel) => {
        for (const entry of fs.readdirSync(path.join(o.root, rel), { withFileTypes: true })) {
          if (entry.isDirectory()) walkCorpus(`${rel}/${entry.name}`);
          else if (entry.isFile()) found.push(`${rel}/${entry.name}`);
        }
      };
      walkCorpus(corpus);
    }
    return found;
  };

  return {
    dir,
    sync(overlays) {
      let files;
      try {
        files = list();
      } catch (e) {
        return { ok: false, reason: `cannot read the project: ${e.message}` };
      }
      if (files.length > MAX_FILES) return { ok: false, reason: `more than ${MAX_FILES} files` };
      fs.mkdirSync(dir, { recursive: true });
      let copied = 0;
      const seen = new Set();
      for (const rel of files) {
        seen.add(rel);
        const from = path.join(o.root, rel);
        const to = path.join(dir, rel);
        const overlay = overlays.get(rel);
        const stat = fs.statSync(from);
        if (stat.size > MAX_BYTES && overlay === undefined) continue;
        const before = known.get(rel);
        if (overlay !== undefined) {
          if (before?.overlay === overlay) continue;
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.writeFileSync(to, overlay);
          known.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, overlay });
          copied++;
        } else if (
          before === undefined ||
          before.overlay !== undefined ||
          before.size !== stat.size ||
          before.mtimeMs !== stat.mtimeMs
        ) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
          known.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
          copied++;
        }
      }
      for (const rel of known.keys()) {
        if (seen.has(rel)) continue;
        known.delete(rel);
        fs.rmSync(path.join(dir, rel), { force: true });
      }
      const modules = path.join(o.root, 'node_modules');
      const link = path.join(dir, 'node_modules');
      if (fs.existsSync(modules) && !fs.existsSync(link)) {
        try {
          fs.symlinkSync(modules, link, 'junction');
        } catch (e) {
          return { ok: false, reason: `cannot link node_modules: ${e.message}` };
        }
      }
      return { ok: true, copied };
    },
  };
}

module.exports = { createShadow };
