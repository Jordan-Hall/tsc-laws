// Glob matching for the path settings of tslaws.json (`cover`, `laws`): `*` stays in one directory, `**` crosses them.

export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** A predicate for a list of globs: a path matches when an include glob matches and no `!` glob does. */
export function globMatcher(globs: string[]): (file: string) => boolean {
  const include = globs.filter((g) => !g.startsWith('!')).map(globToRegExp);
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));
  return (file) => include.some((r) => r.test(file)) && !exclude.some((r) => r.test(file));
}
