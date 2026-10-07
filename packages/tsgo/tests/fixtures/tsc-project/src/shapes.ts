export interface Circle {
  kind: 'circle';
  radius: number;
}
export interface Square {
  kind: 'square';
  size: number;
}
export type Shape = Circle | Square;

export function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.radius ** 2;
    case 'square':
      return shape.size ** 2;
  }
}
