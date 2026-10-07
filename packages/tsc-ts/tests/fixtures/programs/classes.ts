interface Point {
  x: number;
  y: number;
}

abstract class Shape {
  constructor(readonly name: string) {}
  abstract area(): number;
  describe(): string {
    return `${this.name} with area ${this.area().toFixed(2)}`;
  }
}

class Circle extends Shape {
  constructor(private radius: number) {
    super('circle');
  }
  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}

class Rect extends Shape {
  constructor(
    private w: number,
    private h: number,
  ) {
    super('rect');
  }
  area(): number {
    return this.w * this.h;
  }
}

class Counter {
  count = 0;
  inc(by: number = 1): number {
    return (this.count += by);
  }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const shapes: Shape[] = [new Circle(1), new Rect(2, 3)];
for (const s of shapes) console.log(s.describe());
const c = new Counter();
c.inc();
c.inc(5);
const pts: Point[] = [
  { x: 0, y: 0 },
  { x: 3, y: 4 },
];
console.log(dist(pts[0], pts[1]), c.count, [1, 2, 3].map((n) => n * 2).join(','));
