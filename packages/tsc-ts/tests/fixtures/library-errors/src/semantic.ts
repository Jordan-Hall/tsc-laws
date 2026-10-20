interface Point {
  x: number;
  nested: { y: string };
}
const point: Point = { x: 1, nested: { y: 2 } };
let shared = 1;
export { point, shared };
