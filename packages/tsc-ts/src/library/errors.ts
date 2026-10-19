// Errors of tsc-ts's public API.

/**
 * A failure inside tsc-ts while it answered an API call: an exception the compiler threw, as tsgo panics.
 * `cause` is the exception. The program's checker may be inconsistent after one; dispose of the program.
 */
export class InternalCompilerError extends Error {
  constructor(cause: unknown) {
    super('panic: ' + (cause instanceof Error ? cause.message : String(cause)), { cause });
    this.name = 'InternalCompilerError';
  }
}

/** A call on a program, or on its checker, after `dispose()`. */
export class DisposedProgramError extends Error {
  constructor() {
    super('the program is disposed');
    this.name = 'DisposedProgramError';
  }
}

/** `e` as an InternalCompilerError; errors of using a disposed program are rethrown as they are. */
export function internalError(e: unknown): Error {
  if (e instanceof InternalCompilerError || e instanceof DisposedProgramError) return e;
  return new InternalCompilerError(e);
}
