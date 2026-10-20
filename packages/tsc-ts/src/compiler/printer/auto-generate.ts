// Generated names: what each one is generated from, and the ids that tie the printed text of its copies together.
import type { Node } from '../ast.js';
import type { GeneratedIdentifierFlags } from './emit-flags.js';

export class AutoGenerateInfo {
  readonly flags: GeneratedIdentifierFlags;
  /** Generated names with the same id print the same text; clones keep it. */
  readonly id: number;
  readonly prefix: string;
  readonly suffix: string;
  /** For `GeneratedIdentifierFlags.Node`, the node the name is generated from. */
  readonly node: Node | undefined;

  constructor(flags: GeneratedIdentifierFlags, id: number, prefix: string, suffix: string, node: Node | undefined) {
    this.flags = flags;
    this.id = id;
    this.prefix = prefix;
    this.suffix = suffix;
    this.node = node;
  }
}

let nextAutoGenerateId = 1;

export function newAutoGenerateId(): number {
  return nextAutoGenerateId++;
}
