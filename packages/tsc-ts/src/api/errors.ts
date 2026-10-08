// Errors reported to the client with tsc's message prefixes. They don't extend
// Error: scriptc lowers Error subclasses through a large dynamic class table.
// They share a base class: scriptc tests a caught value's class only against
// classes in a hierarchy.

export class ApiError {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

// An error caused by the request rather than the server.
export class ClientError extends ApiError {
  constructor(message: string) {
    super(`api: client error: ${message}`);
  }
}

// A request the server can't parse or doesn't know.
export class InvalidRequestError extends ApiError {
  constructor(message: string) {
    super(`api: invalid request: ${message}`);
  }
}
