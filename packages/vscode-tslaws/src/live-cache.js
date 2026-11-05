'use strict';

// The last report survives a reload: it is kept in `.tslaws/last-report.json` (the folder tslaws already uses for scratch
// files, ignored by git), and read back when the folder opens. Apart from the `fs` and `path` it is given, pure.

const VERSION = 1;
const FILE = ['.tslaws', 'last-report.json'];

/** @param {{fs: typeof import('node:fs'), path: typeof import('node:path'), root: string}} io */
function cachePath({ path, root }) {
  return path.join(root, ...FILE);
}

/**
 * @param {{fs: typeof import('node:fs'), path: typeof import('node:path'), root: string}} io
 * @param {{records: object[], ranAt: Map<string, number>, compilerText: string}} state
 */
function saveCache(io, state) {
  const { fs, path } = io;
  const file = cachePath(io);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify({
      version: VERSION,
      savedAt: Date.now(),
      records: state.records,
      ranAt: [...state.ranAt],
      compilerText: state.compilerText,
    });
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

/** @returns {{records: object[], ranAt: Map<string, number>, compilerText: string, savedAt: number} | null} */
function loadCache(io) {
  try {
    const data = JSON.parse(io.fs.readFileSync(cachePath(io), 'utf8'));
    if (data.version !== VERSION || !Array.isArray(data.records)) return null;
    return {
      records: data.records,
      ranAt: new Map(Array.isArray(data.ranAt) ? data.ranAt : []),
      compilerText: typeof data.compilerText === 'string' ? data.compilerText : '',
      savedAt: Number.isFinite(data.savedAt) ? data.savedAt : 0,
    };
  } catch {
    return null;
  }
}

module.exports = { saveCache, loadCache, cachePath };
