// Errors reported to the client with tsc's message prefixes. They don't extend
// Error: scriptc lowers Error subclasses through a large dynamic class table.

// An error caused by the request rather than the server.
export class ClientError {
  readonly message: string;
  constructor(message: string) {
    this.message = `api: client error: ${message}`;
  }
}

// A request the server can't parse or doesn't know.
export class InvalidRequestError {
  readonly message: string;
  constructor(message: string) {
    this.message = `api: invalid request: ${message}`;
  }
}
