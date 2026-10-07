// The installed scriptc platform package, which bundles TypeScript 7.0.2's tsc.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const scope = resolve('../../node_modules/@scriptc');
const platform = existsSync(scope) ? readdirSync(scope).find((name) => name.startsWith('cli-')) : undefined;

export const scriptcDist = platform === undefined ? undefined : join(scope, platform, 'dist');
export const typescriptLib = scriptcDist === undefined ? undefined : join(scriptcDist, 'lib/typescript/lib');
