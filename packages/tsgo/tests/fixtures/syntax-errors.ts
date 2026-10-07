// Parser fixture: recoverable syntax errors.
const a = ;
function f(x: number { return x }
class C { method() { if (true) { } else } }
let b = [1, 2,, 3;
interface I { a: string b: number }
type T = { [key: string] };
enum E { A = , B }
for (let i = 0; i < 10 i++) {}
