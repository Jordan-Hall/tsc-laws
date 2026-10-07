// Path helpers matching TypeScript's tspath normalization.

// Makes fileName absolute against cwd and resolves `.` and `..` segments.
export function normalizeAbsolutePath(fileName: string, cwd: string): string {
  let path = fileName.replaceAll('\\', '/');
  if (!isRooted(path)) path = cwd.replaceAll('\\', '/') + '/' + path;
  const root = rootLength(path);
  const parts: string[] = [];
  for (const part of path.slice(root).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      continue;
    }
    parts.push(part);
  }
  const prefix = path.slice(0, root);
  return parts.length === 0 ? prefix || '/' : prefix + parts.join('/');
}

// The key of a file name in path-keyed tables.
export function toPath(fileName: string, cwd: string, useCaseSensitiveFileNames: boolean): string {
  const path = normalizeAbsolutePath(fileName, cwd);
  return useCaseSensitiveFileNames ? path : path.toLowerCase();
}

// Converts a file:// URI to a file name.
export function uriToFileName(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  let path = decodeURIComponent(uri.slice('file://'.length));
  // file:///c%3A/x → c:/x
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

function isRooted(path: string): boolean {
  return rootLength(path) > 0;
}

function rootLength(path: string): number {
  if (path.startsWith('/')) return 1;
  if (/^[A-Za-z]:\//.test(path)) return 3;
  return 0;
}
