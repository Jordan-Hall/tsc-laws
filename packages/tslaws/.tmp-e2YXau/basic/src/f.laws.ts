import { add, rev } from './f';
export law commutes(a: number, b: number) => add(a, b) === add(b, a);
export law revTwice(xs: number[]) { const ys = rev(rev(xs)); return ys.length === xs.length && ys.every((y, i) => y === xs[i]); }
