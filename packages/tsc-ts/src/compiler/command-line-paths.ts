/**
 * The few path operations option parsing needs, with tsgo's semantics for `/`, UNC and DOS roots.
 *
 * URL roots (`file:///`) are not handled.
 */

function isSeparator(ch: number): boolean {
  return ch === 47 /* / */ || ch === 92; /* \ */
}

function isVolumeCharacter(ch: number): boolean {
  return (ch >= 97 && ch <= 122) || (ch >= 65 && ch <= 90);
}

export function normalizeSlashes(path: string): string {
  return path.includes('\\') ? path.replaceAll('\\', '/') : path;
}

export function getRootLength(path: string): number {
  const length = path.length;
  if (length === 0) return 0;
  const ch0 = path.charCodeAt(0);
  if (isSeparator(ch0)) {
    if (length === 1 || path.charCodeAt(1) !== ch0) return 1;
    const next = path.indexOf(path[0], 2);
    return next < 0 ? length : next + 1;
  }
  if (isVolumeCharacter(ch0) && length > 1 && path.charCodeAt(1) === 58 /* : */) {
    if (length === 2) return 2;
    if (isSeparator(path.charCodeAt(2))) return 3;
  }
  if (ch0 === 94 /* ^ */ && length > 1 && path.charCodeAt(1) === 47) return 2;
  return 0;
}

export function hasTrailingDirectorySeparator(path: string): boolean {
  return path.length > 0 && isSeparator(path.charCodeAt(path.length - 1));
}

export function ensureTrailingDirectorySeparator(path: string): string {
  return hasTrailingDirectorySeparator(path) ? path : path + '/';
}

function removeTrailingDirectorySeparator(path: string): string {
  return hasTrailingDirectorySeparator(path) ? path.slice(0, -1) : path;
}

export function combinePaths(first: string, second: string): string {
  const base = normalizeSlashes(first);
  if (second === '') return base;
  const rest = normalizeSlashes(second);
  if (base === '' || getRootLength(rest) !== 0) return rest;
  return hasTrailingDirectorySeparator(base) ? base + rest : base + '/' + rest;
}

/** Root followed by the path's segments with `.` and `..` resolved. */
function normalizedComponents(path: string): string[] {
  const rootLength = getRootLength(path);
  const components = [path.slice(0, rootLength)];
  for (const segment of path.slice(rootLength).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (components.length > 1) {
        if (components[components.length - 1] !== '..') {
          components.pop();
          continue;
        }
      } else if (components[0] !== '') {
        continue;
      }
    }
    components.push(segment);
  }
  return components;
}

function pathFromComponents(components: readonly string[]): string {
  if (components.length === 0) return '';
  const root = components[0] === '' ? '' : ensureTrailingDirectorySeparator(components[0]);
  return root + components.slice(1).join('/');
}

export function getNormalizedAbsolutePath(fileName: string, currentDirectory: string): string {
  const path =
    getRootLength(fileName) === 0 && currentDirectory !== ''
      ? combinePaths(currentDirectory, fileName)
      : normalizeSlashes(fileName);
  return pathFromComponents(normalizedComponents(path));
}

export function normalizePath(path: string): string {
  const slashes = normalizeSlashes(path);
  const normalized = getNormalizedAbsolutePath(slashes, '');
  return normalized !== '' && hasTrailingDirectorySeparator(slashes)
    ? ensureTrailingDirectorySeparator(normalized)
    : normalized;
}

export function getDirectoryPath(path: string): string {
  const slashes = normalizeSlashes(path);
  const rootLength = getRootLength(slashes);
  if (rootLength === slashes.length) return slashes;
  const trimmed = removeTrailingDirectorySeparator(slashes);
  return trimmed.slice(0, Math.max(rootLength, trimmed.lastIndexOf('/')));
}

function isRelativePath(path: string): boolean {
  return path === '.' || path === '..' || /^\.\.?[\\/]/.test(path);
}

/** Relative path from the directory of file `from` to `to`, prefixed with `./` or `../`. */
export function getRelativePathFromFile(from: string, to: string, useCaseSensitiveFileNames: boolean): string {
  const fromComponents = normalizedComponents(getDirectoryPath(from));
  const toComponents = normalizedComponents(to);
  const common = Math.min(fromComponents.length, toComponents.length);
  let start = 0;
  for (; start < common; start++) {
    const a = fromComponents[start];
    const b = toComponents[start];
    const same = start === 0 || !useCaseSensitiveFileNames ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!same) break;
  }
  let relative: string;
  if (start === 0) {
    relative = pathFromComponents(toComponents);
  } else {
    const parts = [''];
    for (let i = start; i < fromComponents.length; i++) parts.push('..');
    for (let i = start; i < toComponents.length; i++) parts.push(toComponents[i]);
    relative = pathFromComponents(parts);
  }
  return getRootLength(relative) !== 0 || isRelativePath(relative) ? relative : './' + relative;
}
