export const VERSION = '1.0';

export class Greeter {
  constructor(private greeting: string) {}
  greet(name: string): string {
    return `${this.greeting}, ${name}!`;
  }
}

export function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
