// The compiler that npm installs with tslaws: one optional dependency per platform, `tslaws-compiler-<platform>`, holding
// the native executable and the TypeScript lib files beside it.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface Platform {
  name: string;
  os: string;
  cpu: string;
  libc?: 'glibc' | 'musl';
}

export const platforms: Platform[] = [
  { name: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { name: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { name: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { name: 'linux-arm64-musl', os: 'linux', cpu: 'arm64', libc: 'musl' },
  { name: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { name: 'linux-x64-musl', os: 'linux', cpu: 'x64', libc: 'musl' },
  { name: 'win32-x64-msvc', os: 'win32', cpu: 'x64' },
];

export const packageName = (platform: Platform): string => `tslaws-compiler-${platform.name}`;

export const executableName = (os: string = process.platform): string => (os === 'win32' ? 'tsc-ts.exe' : 'tsc-ts');

function hostLibc(): 'glibc' | 'musl' | undefined {
  if (process.platform !== 'linux') return undefined;
  const report = process.report.getReport() as unknown as {
    header: { glibcVersionRuntime?: string };
    sharedObjects: string[];
  };
  if (report.header.glibcVersionRuntime) return 'glibc';
  if (report.sharedObjects.some((path) => /(?:^|\/)ld-musl-|libc\.musl-/.test(path))) return 'musl';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return existsSync(`/lib/ld-musl-${arch}.so.1`) ? 'musl' : undefined;
}

/** The platform of this process, or undefined when there is no compiler build for it. */
export function hostPlatform(): Platform | undefined {
  const libc = hostLibc();
  return platforms.find(
    (p) => p.os === process.platform && p.cpu === process.arch && (p.libc === undefined || p.libc === libc),
  );
}

/** The compiler installed as an optional dependency of tslaws, when there is one for this machine. */
export function bundledCompiler(): string | undefined {
  const platform = hostPlatform();
  if (platform === undefined) return undefined;
  try {
    const manifest = createRequire(import.meta.url).resolve(`${packageName(platform)}/package.json`);
    const executable = join(dirname(manifest), 'lib', executableName());
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

/** The compiler built in a checkout of the tsc-laws repository (packages/tsc-ts/dist), found by walking up from `from`. */
export function checkoutCompiler(from: string): string | undefined {
  const name = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'packages', 'tsc-ts', 'dist', name);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The version of this package, for messages. */
export function ownVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
      .version;
  } catch {
    return 'unknown';
  }
}
