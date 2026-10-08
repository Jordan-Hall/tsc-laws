export = Lib;
export as namespace Lib;
declare namespace Lib {
  const version: string;
  function create(): Lib.Instance;
  interface Instance {
    run(): void;
  }
}
