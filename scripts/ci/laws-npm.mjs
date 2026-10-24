// Prepares the npm packages of a tsc-laws release.
//
//   node scripts/ci/laws-npm.mjs compilers <dir-with-tgz> <out-dir>
//       Repacks each tsc-ts platform tarball (built by `pack:npm -w tsc-ts -- platform`) as
//       `tslaws-compiler-<platform>`, at the version of tslaws, ready to publish.
//   node scripts/ci/laws-npm.mjs main <out-dir/with/compilers>
//       Adds the platform packages that exist as optionalDependencies of packages/tslaws, so `npm i tslaws` brings the
//       compiler for the machine. Run in the release workspace, just before `npm pack`/`npm publish`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const mainPath = join(repo, 'packages/tslaws/package.json');
const main = JSON.parse(readFileSync(mainPath, 'utf8'));
const prefix = 'tsc-ts-';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`);
  return result.stdout;
}

/** `tsc-ts-linux-x64-gnu-0.0.9.tgz` -> `linux-x64-gnu` */
function platformOf(file) {
  return file.slice(prefix.length).replace(/-\d+\.\d+\.\d+.*\.tgz$/, '');
}

const [command, a, b] = process.argv.slice(2);

if (command === 'compilers') {
  const input = resolve(a);
  const output = resolve(b);
  mkdirSync(output, { recursive: true });
  const names = [];
  for (const file of readdirSync(input).filter((f) => f.startsWith(prefix) && f.endsWith('.tgz'))) {
    const platform = platformOf(file);
    const work = mkdtempSync(join(tmpdir(), 'laws-npm-'));
    try {
      // Plain relative names: GNU tar reads a drive letter as a host name.
      copyFileSync(join(input, file), join(work, file));
      run('tar', ['-xzf', file], { cwd: work });
      const manifestPath = join(work, 'package/package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.name = `tslaws-compiler-${platform}`;
      manifest.version = main.version;
      manifest.description = `The tsc-laws compiler (tsc-ts with \`law\` support) for ${platform}, used by tslaws.`;
      manifest.repository = main.repository ?? { type: 'git', url: 'git+https://github.com/Jordan-Hall/tsc-laws.git' };
      manifest.publishConfig = { access: 'public' };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      run('npm', ['pack', '--pack-destination', output], { cwd: join(work, 'package') });
      names.push(manifest.name);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  if (names.length === 0) throw new Error(`no ${prefix}*.tgz in ${input}`);
  console.log(names.join('\n'));
} else if (command === 'main') {
  const built = readdirSync(resolve(a))
    .filter((f) => f.startsWith('tslaws-compiler-') && f.endsWith('.tgz'))
    .map((f) => f.replace(/^tslaws-compiler-/, 'tslaws-compiler-').replace(/-\d+\.\d+\.\d+.*\.tgz$/, ''));
  if (built.length === 0) throw new Error('no compiler packages to depend on');
  main.optionalDependencies = Object.fromEntries(built.sort().map((name) => [name, main.version]));
  main.publishConfig = { access: 'public' };
  main.license ??= 'Apache-2.0';
  main.repository ??= {
    type: 'git',
    url: 'git+https://github.com/Jordan-Hall/tsc-laws.git',
    directory: 'packages/tslaws',
  };
  writeFileSync(mainPath, `${JSON.stringify(main, null, 2)}\n`);
  console.log(Object.keys(main.optionalDependencies).join('\n'));
} else {
  console.error('usage: laws-npm.mjs compilers <dir> <out> | main <dir-with-compilers>');
  process.exit(2);
}
