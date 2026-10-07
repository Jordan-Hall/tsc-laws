import { Greeter, fib, VERSION } from './lib.ts';

const greeter = new Greeter('héllo');
console.log(greeter.greet('wörld'), VERSION);
console.log(Array.from({ length: 10 }, (_, i) => fib(i)).join(' '));
