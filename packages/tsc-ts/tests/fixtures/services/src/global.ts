declare var globalCounter: number;
globalCounter = 1;
function globalFn(this: unknown) {
  return this;
}
globalFn();
