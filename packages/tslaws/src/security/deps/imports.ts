// The npm packages the covered source files import, as a name and the number of files that import it.
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { moduleSpecifiers } from '../../lawKinds.ts';

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '').split('/')[0]));

/** The package a specifier names (`@scope/name` or `name`), or undefined for a relative path, a built-in or a URL. */
export function packageOf(specifier: string): string | undefined {
  if (specifier === '' || /^[./#]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  if (name === '' || name === '@' || name.endsWith('/') || builtins.has(name)) return undefined;
  return name;
}

/** For each package imported (value imports only; `import type` loads nothing) by the files: how many files import it. */
export function collectImports(cwd: string, files: readonly string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of files) {
    const names = new Set<string>();
    for (const specifier of moduleSpecifiers(readFileSync(join(cwd, file), 'utf8'), file)) {
      if (specifier.typeOnly) continue;
      const name = packageOf(specifier.value);
      if (name !== undefined) names.add(name);
    }
    for (const name of names) found.set(name, (found.get(name) ?? 0) + 1);
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}
