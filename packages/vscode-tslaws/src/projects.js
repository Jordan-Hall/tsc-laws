// Which tslaws project a file belongs to. A project is a directory with a tslaws.json, and a file belongs to the nearest
// one above it, never past the workspace folder it lies in. Pure: `fs` and `path` are passed in, so the unit tests run on
// a table of files and the extension passes the real ones.
//
// Three kinds of answer:
//   project  the nearest tslaws.json (a package of a monorepo, or the one project of a folder)
//   root     the nearest tslaws.json lists `projects`, so it is the root of a monorepo and the file is in none of them
//   root     also: no tslaws.json up to the workspace folder, but the folder declares package workspaces (package.json
//            `workspaces` or pnpm-workspace.yaml), so tslaws fans a check out across the packages' projects
//   folder   there is no tslaws.json up to the workspace folder; the folder itself stands in, as it always did

/**
 * @typedef {{dir: string, folder: string, kind: 'project' | 'root' | 'folder'}} Project
 * @typedef {{existsSync(p: string): boolean, readFileSync(p: string, enc: 'utf8'): string}} Fs
 * @typedef {{fs: Fs, path?: typeof import('node:path')}} Io
 */

import nodePath from 'node:path';

const norm = (path, p) =>
  path
    .normalize(p)
    .replace(/[\\/]+$/, '')
    .replace(/^[a-z](?=:[\\/]|:$)/, (drive) => drive.toUpperCase());
const fold = (path, p) => norm(path, p).toLowerCase();

/** Whether `file` is `dir` or lies below it. */
function isInside(path, dir, file) {
  const d = fold(path, dir);
  const f = fold(path, file);
  return f === d || f.startsWith(d + path.sep) || f.startsWith(`${d}/`);
}

/** The workspace folder that holds `file` (the deepest, when folders nest), or undefined. */
function owningFolder(path, file, folders) {
  let best;
  for (const folder of folders)
    if (isInside(path, folder, file) && (best === undefined || norm(path, folder).length > norm(path, best).length))
      best = folder;
  return best;
}

/** Whether the tslaws.json in `dir` lists `projects`; undefined when there is no file (or it cannot be read as JSON). */
function configAt(io, dir) {
  const path = io.path ?? nodePath;
  const file = path.join(dir, 'tslaws.json');
  if (!io.fs.existsSync(file)) return undefined;
  try {
    const json = JSON.parse(io.fs.readFileSync(file, 'utf8'));
    return { lists: json !== null && typeof json === 'object' && json.projects !== undefined };
  } catch {
    // A tslaws.json that is mid-edit is still a project boundary; tslaws reports what is wrong with it.
    return { lists: false };
  }
}

/** Whether `dir` declares package workspaces: a pnpm-workspace.yaml, or a package.json with `workspaces`. */
function declaresWorkspaces(io, dir) {
  const path = io.path ?? nodePath;
  if (io.fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return true;
  const manifest = path.join(dir, 'package.json');
  if (!io.fs.existsSync(manifest)) return false;
  try {
    const json = JSON.parse(io.fs.readFileSync(manifest, 'utf8'));
    return json !== null && typeof json === 'object' && json.workspaces !== undefined;
  } catch {
    return false;
  }
}

/**
 * The project that holds the directory `start`, looking at it and every directory above, up to its workspace folder.
 * @param {string} start
 * @param {string[]} folders the workspace folders (absolute)
 * @param {Io} io
 * @returns {Project | undefined} undefined when `start` is in no workspace folder
 */
function locateIn(start, folders, io) {
  const path = io.path ?? nodePath;
  const rawFolder = owningFolder(path, start, folders);
  if (rawFolder === undefined) return undefined;
  const folder = norm(path, rawFolder);
  for (let dir = norm(path, start); ; dir = path.dirname(dir)) {
    const config = configAt(io, dir);
    if (config !== undefined) return { dir, folder, kind: config.lists ? 'root' : 'project' };
    if (fold(path, dir) === fold(path, folder) || path.dirname(dir) === dir) break;
  }
  return { dir: folder, folder, kind: declaresWorkspaces(io, folder) ? 'root' : 'folder' };
}

/** The project that holds the file `file`. */
function locate(file, folders, io) {
  const path = io.path ?? nodePath;
  return locateIn(path.dirname(file), folders, io);
}

/**
 * A short name for the status bar and messages: the project's path from its workspace folder (`packages/a`), the folder's
 * own name when the project is the folder, and with several folders open the folder's name in front.
 * @param {Project} project
 * @param {string[]} folders
 * @param {typeof import('node:path')} [path]
 */
function labelOf(project, folders, path = nodePath) {
  const rel = path.relative(project.folder, project.dir).split(path.sep).join('/');
  const name = path.basename(project.folder);
  const inside = rel === '' ? name : rel;
  return folders.length > 1 && rel !== '' ? `${name}: ${inside}` : inside;
}

/**
 * The lines the "show project" command prints: what the extension will run for the open file, and where.
 * @param {Project} project
 * @param {string[]} folders
 * @param {Io} io
 */
function describeProject(project, folders, io) {
  const path = io.path ?? nodePath;
  const lock = path.join(project.dir, 'tsc-laws.lock');
  const kind = {
    project: 'project',
    root: 'monorepo root (not a project: use "tslaws: Check all projects")',
    folder: 'folder (no tslaws.json found)',
  }[project.kind];
  return [
    `tslaws ${kind}: ${labelOf(project, folders, path)}`,
    `runs in ${project.dir}`,
    io.fs.existsSync(lock) ? `lock ${lock}` : 'no tsc-laws.lock yet (tslaws accept writes it)',
  ];
}

export { locate, locateIn, labelOf, describeProject, isInside, owningFolder };
