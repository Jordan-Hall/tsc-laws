// A synchronous API connection: requests are handled one at a time, and the
// server can call back into the client (for file system access) while
// handling one.
import { decodeText, encodeText, MessageType, Reader, Writer } from './protocol.js';
import type { Session } from './session.js';

// A response: JSON text, or raw bytes sent as is.
export type Reply = string | Uint8Array;

// The outcome of a request.
export type Response = { ok: true; reply: Reply } | { ok: false; error: string };

export class Connection {
  private readonly reader: Reader;
  private readonly writer: Writer;

  constructor(input: number, output: number) {
    this.reader = new Reader(input);
    this.writer = new Writer(output);
  }

  // Handles requests until the client closes its end.
  run(session: Session): void {
    for (;;) {
      const message = this.reader.read();
      if (message === undefined) return;
      if (message.type !== MessageType.Request) {
        throw new Error(`unexpected message type ${message.type} outside a call`);
      }
      const response = session.handle(message.method, message.payload);
      if (!response.ok) {
        this.writer.write(MessageType.Error, message.method, encodeText(response.error));
        continue;
      }
      const reply = response.reply;
      this.writer.write(MessageType.Response, message.method, typeof reply === 'string' ? encodeText(reply) : reply);
    }
  }

  // Calls a client method with JSON params and returns its JSON reply.
  call(method: string, params: string): string {
    this.writer.write(MessageType.Call, method, encodeText(params));
    const reply = this.reader.read();
    if (reply === undefined) throw new Error(`connection closed during ${method} call`);
    if (reply.method !== method) throw new Error(`api: unexpected message while waiting for "${method}" response`);
    if (reply.type === MessageType.CallError) {
      throw new Error(`api: remote error [-32603]: ${decodeText(reply.payload)}`);
    }
    if (reply.type !== MessageType.CallResponse) {
      throw new Error(`api: unexpected message while waiting for "${method}" response`);
    }
    return decodeText(reply.payload);
  }
}
