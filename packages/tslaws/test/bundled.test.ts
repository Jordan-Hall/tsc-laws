import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bundledCompiler, executableName, hostPlatform, packageName, platforms } from '../dist/bundled.js';

describe('bundled compiler', () => {
  it('names one package per platform and knows this machine', () => {
    assert.equal(new Set(platforms.map(packageName)).size, platforms.length);
    assert.equal(packageName({ name: 'win32-x64-msvc', os: 'win32', cpu: 'x64' }), 'tslaws-compiler-win32-x64-msvc');
    assert.equal(executableName('win32'), 'tsc-ts.exe');
    assert.equal(executableName('linux'), 'tsc-ts');
    assert.ok(hostPlatform() !== undefined, 'a build exists for the machine running the tests');
  });

  it('finds nothing when the platform package is not installed', () => {
    assert.equal(bundledCompiler(), undefined);
  });
});
