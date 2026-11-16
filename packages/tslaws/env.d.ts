// The type of `import.meta.env` in code that laws reach. tslaws adds this file to a build when the project declares no
// `ImportMeta.env` of its own (Vite's `vite/client` and rsbuild's types do). Reference it from the project to give an
// editor the same type: `/// <reference types="tslaws/env" />`.
interface ImportMetaEnv {
  // Any, as in Vite's own declaration: a variable is usually a string, but the project knows which, and a narrower index
  // type would turn every `import.meta.env.VITE_X` into a type error in code that compiles under a bundler.
  readonly [key: string]: any;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly SSR: boolean;
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
