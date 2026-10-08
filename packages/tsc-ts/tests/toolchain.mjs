// The installed scriptc platform package, which bundles TypeScript 7.0.2's tsc,
// and the tsc-ts under test.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const scope = resolve('../../node_modules/@scriptc');
const platform = existsSync(scope) ? readdirSync(scope).find((name) => name.startsWith('cli-')) : undefined;

export const scriptcDist = platform === undefined ? undefined : join(scope, platform, 'dist');
export const typescriptLib = scriptcDist === undefined ? undefined : join(scriptcDist, 'lib/typescript/lib');

// TSC_TS_BIN names a native tsc-ts executable, relative to the repository
// root; otherwise tests run the Node build.
const main = resolve('dist/tsc-ts/src/main.js');
const bin = process.env.TSC_TS_BIN ? resolve('../..', process.env.TSC_TS_BIN) : undefined;

export const tscTs = bin === undefined ? [process.execPath, '--stack-size=16000', main] : [bin];
export const tscTsMissing =
  bin === undefined
    ? !existsSync(main) && 'run npm run build'
    : !existsSync(bin) && `${process.env.TSC_TS_BIN} does not exist`;
