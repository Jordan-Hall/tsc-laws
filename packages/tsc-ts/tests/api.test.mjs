import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Differential, explore } from './differential.mjs';
import { typescriptLib as bundledLib } from './toolchain.mjs';
import { tempDir } from './temp.mjs';

// The reference: TypeScript 7.0.2's tsc, shipped with scriptc. It reads lib
// files from its real directory.
const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const realTsc = join(typescriptLib, 'tsc');
const main = resolve('dist/tsc-ts/src/main.js');
const tscTs = [process.execPath, '--stack-size=16000', main];
const env = { TSC_TS_LIB_DIR: typescriptLib };
const skip = !existsSync(realTsc) ? 'needs the scriptc toolchain' : !existsSync(main) ? 'run npm run build' : false;

function copyProject() {
  const dir = tempDir('tsc-ts-api-');
  cpSync(resolve('tests/fixtures/project'), dir, { recursive: true });
  return dir;
}

function report(d) {
  assert.deepEqual(
    d.failures.slice(0, Number(process.env.SHOW_FAILURES ?? 20)),
    [],
    `${d.failures.length} of ${d.count} responses differ`,
  );
}

test('tsc-ts --api answers like tsc --api', { skip, timeout: 600_000 }, async () => {
  const dir = copyProject();
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    await d.call('ping');
    await d.call('getServerTiming');
    const config = join(dir, 'tsconfig.json');
    await d.call('parseConfigFile', { file: config });
    const update = await d.call('updateSnapshot', { openProjects: [config] });
    const snapshot = update.snapshot;
    const project = update.projects[0].id;
    const base = { snapshot, project };

    const fileNames = await d.call('getSourceFileNames', base);
    const userFiles = [];
    for (const file of fileNames) {
      const encoded = await d.call('getSourceFile', { ...base, file });
      await d.call('getSourceFileMetadata', { ...base, file });
      if (file.startsWith(dir)) userFiles.push({ file, length: readFileSync(file, 'utf8').length, encoded });
    }
    await d.call('getSourceFile', { ...base, file: join(dir, 'missing.ts') });
    await d.call('getDefaultProjectForFile', { snapshot, file: join(dir, 'src/main.ts') });

    for (const method of ['getConfigFileParsingDiagnostics', 'getProgramDiagnostics', 'getGlobalDiagnostics']) {
      await d.call(method, base);
    }
    for (const method of [
      'getSyntacticDiagnostics',
      'getBindDiagnostics',
      'getSemanticDiagnostics',
      'getSuggestionDiagnostics',
    ]) {
      await d.call(method, base);
      for (const { file } of userFiles) await d.call(method, { ...base, file });
    }

    for (const name of [
      'Any',
      'String',
      'Number',
      'Boolean',
      'Void',
      'Undefined',
      'Null',
      'Never',
      'Unknown',
      'BigInt',
      'ESSymbol',
    ]) {
      await d.call(`get${name}Type`, base);
    }
    await d.call('getWellKnownSymbols', base);
    await d.call('resolveName', { ...base, name: 'Circle', meaning: 0xffffffff, file: userFiles[0].file, position: 0 });
    await d.call('resolveName', { ...base, name: 'Array', meaning: 0xffffffff });

    const explored = await explore(d, snapshot, project, userFiles, 4000);
    assert.ok(explored > 500, `explored ${explored} objects`);

    // Type nodes round-trip through printNode.
    const positions = Array.from({ length: 60 }, (_, i) => i * 37);
    const types = await d.call('getTypesAtPositions', { ...base, file: userFiles[0].file, positions });
    for (const type of types.filter((t) => t !== null)) {
      const node = await d.call('typeToTypeNode', { ...base, type: type.id });
      if (node instanceof Uint8Array) await d.call('printNode', { data: Buffer.from(node).toString('base64') });
    }
    await d.call('printNode', { data: '!!' });
    await d.call('echo', { hello: 'wörld' });

    // Errors the API reports for bad requests.
    await d.call('getTypeOfSymbol', { ...base, symbol: 999999 });
    await d.call('getPropertiesOfType', { ...base, type: 999999 });
    await d.call('getTypeAtLocation', { ...base, location: '1.2' });
    await d.call('getTypeAtLocation', { ...base, location: `99999.79.${userFiles[0].file}` });
    await d.call('getSourceFileNames', { snapshot: 99, project });
    await d.call('getSourceFileNames', { snapshot, project: '/nope/tsconfig.json' });
    await d.call('noSuchMethod', base);

    // Snapshots: an unchanged update reuses the snapshot; edits report changes.
    const again = await d.call('updateSnapshot', {});
    assert.equal(again.snapshot, snapshot + 1);
    await d.call('release', { snapshot });
    const shapes = join(dir, 'src/shapes.ts');
    writeFileSync(shapes, readFileSync(shapes, 'utf8') + '\nexport const added = 1;\n');
    const changed = await d.call('updateSnapshot', { fileChanges: { changed: [shapes] } });
    await d.call('getSourceFile', { snapshot: changed.snapshot, project, file: shapes });
    await d.call('getSemanticDiagnostics', { snapshot: changed.snapshot, project, file: shapes });
    await d.call('updateSnapshot', { closeProjects: [config] });
    await d.call('release', { snapshot });
    await d.call('release', { snapshot: changed.snapshot });
    await d.call('release', { snapshot: changed.snapshot });
  } finally {
    await d.close();
  }
  console.log(`compared ${d.count} responses`);
  report(d);
});

test('tsc-ts --api tracks projects and open files like tsc --api', { skip, timeout: 300_000 }, async () => {
  const dir = tempDir('tsc-ts-api-');
  cpSync(resolve('tests/fixtures/project'), join(dir, 'a'), { recursive: true });
  mkdirSync(join(dir, 'b'));
  writeFileSync(join(dir, 'b/tsconfig.json'), '{"compilerOptions":{"strict":false,"types":[]},"files":["x.ts"]}');
  writeFileSync(join(dir, 'b/x.ts'), 'export const x: number = 1;\n');
  mkdirSync(join(dir, 'loose'));
  writeFileSync(join(dir, 'loose/y.ts'), 'export const y = 2;\n');
  const d = new Differential([realTsc], tscTs, dir, env);
  try {
    await d.call('initialize');
    const first = await d.call('updateSnapshot', { openProjects: [join(dir, 'b/tsconfig.json'), 'a/tsconfig.json'] });
    await d.call('getDefaultProjectForFile', { snapshot: first.snapshot, file: join(dir, 'b/x.ts') });
    await d.call('getDefaultProjectForFile', { snapshot: first.snapshot, file: join(dir, 'loose/y.ts') });
    await d.call('updateSnapshot', { closeProjects: ['a/tsconfig.json'] });
    await d.call('updateSnapshot', { openFiles: [join(dir, 'a/src/main.ts')] });
    await d.call('updateSnapshot', { openFiles: [{ uri: `file://${join(dir, 'b/x.ts')}` }] });
    const loose = await d.call('updateSnapshot', { openFiles: [join(dir, 'loose/y.ts')] });
    await d.call('getSourceFileNames', { snapshot: loose.snapshot, project: '/dev/null/inferred' });
    writeFileSync(join(dir, 'b/x.ts'), 'export const x: number = 2;\n');
    await d.call('updateSnapshot', { fileChanges: { changed: [join(dir, 'b/x.ts')] } });
    await d.call('updateSnapshot', { fileChanges: { invalidateAll: true } });
    await d.call('updateSnapshot', { closeFiles: [join(dir, 'loose/y.ts'), join(dir, 'a/src/main.ts')] });
  } finally {
    await d.close();
  }
  report(d);
});

test('tsc-ts runs tsc without --api', { skip, timeout: 300_000 }, () => {
  const dir = copyProject();
  const run = (command) => {
    try {
      return {
        status: 0,
        stdout: execFileSync(command[0], [...command.slice(1), '-p', '.'], {
          cwd: dir,
          env: { ...process.env, ...env },
        }).toString(),
      };
    } catch (e) {
      return { status: e.status, stdout: e.stdout.toString() };
    }
  };
  assert.deepEqual(run(tscTs), run([realTsc]));
});
