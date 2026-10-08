export class Shape {
  area(): number {
    return 0;
  }
  get size(): number {
    return 1;
  }
}

export interface Options {
  size: number;
  color?: string;
  mode: Mode;
}

export enum Mode {
  A,
  B = 'b',
}

export const 'quoted name' = 1;
export default function main() {}
