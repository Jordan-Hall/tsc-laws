// Import this before `../dist/*`: the Z3 pool reads TSLAWS_JOBS when `smt.js` loads.
// Each Z3 instance reserves a large WebAssembly heap. With the default four at once, a loaded machine sometimes ran
// one out of memory ("Worker terminated due to reaching memory limit"), and a law that should have been proved came
// back `open`. One solver at a time gives the same answers in a fixed amount of memory.
process.env.TSLAWS_JOBS ??= '1';
