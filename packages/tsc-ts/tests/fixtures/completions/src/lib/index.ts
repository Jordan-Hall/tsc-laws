/// <reference path="../shapes.ts" />
/// <reference types="" />
import type { Options } from '../';
import type { Shape } from '../lib/';
export type Pair = [Options, Shape];
export const loaded = import('./');
declare module 'virtual:config' {
  export const value: number;
}
import 'v';
