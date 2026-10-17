import { greet } from 'greet';
import { area, type Shape } from './shapes.js';

const shapes: Shape[] = [
  { kind: 'circle', radius: 1 },
  { kind: 'square', size: '2' },
];
console.log(greet(42), shapes.map(area));
