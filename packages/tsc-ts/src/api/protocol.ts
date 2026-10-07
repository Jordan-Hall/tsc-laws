// The API's MessagePack framing: each message is a fixed 3-element array of
// [type, method, payload], with method and payload as bin values.
import { readSync, writeSync } from 'node:fs';

export const enum MessageType {
  Request = 1,
  CallResponse = 2,
  CallError = 3,
  Response = 4,
  Error = 5,
  Call = 6,
}

export interface Message {
  type: MessageType;
  method: string;
  payload: Uint8Array;
}

const fixArray3 = 0x93;
const bin8 = 0xc4;
const bin16 = 0xc5;
const bin32 = 0xc6;
const uint8 = 0xcc;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

// Reads messages from a file descriptor, blocking until each is complete.
export class Reader {
  private buffer = new Uint8Array(1 << 16);
  private start = 0;
  private end = 0;

  constructor(private readonly fd: number) {}

  // Returns the next message, or undefined at end of input.
  read(): Message | undefined {
    if (!this.fill(1)) return undefined;
    const head = this.byte();
    if (head !== fixArray3) throw new Error(`expected a 3-element array (0x93), received 0x${hex(head)}`);
    let type = this.byteOrEnd();
    if (type === uint8) type = this.byteOrEnd();
    else if (type > 0x7f) throw new Error(`expected a message type, received 0x${hex(type)}`);
    if (type < MessageType.Request || type > MessageType.Call) throw new Error(`unknown message type: ${type}`);
    const method = decodeText(this.bin());
    const payload = this.bin().slice();
    return { type, method, payload };
  }

  private bin(): Uint8Array {
    const marker = this.byteOrEnd();
    let size: number;
    if (marker === bin8) {
      size = this.byteOrEnd();
    } else if (marker === bin16) {
      size = (this.byteOrEnd() << 8) | this.byteOrEnd();
    } else if (marker === bin32) {
      size = ((this.byteOrEnd() << 24) | (this.byteOrEnd() << 16) | (this.byteOrEnd() << 8) | this.byteOrEnd()) >>> 0;
    } else {
      throw new Error(`expected binary data (0xc4-0xc6), received 0x${hex(marker)}`);
    }
    if (!this.fill(size)) throw new Error('unexpected end of input');
    const out = this.buffer.subarray(this.start, this.start + size);
    this.start += size;
    return out;
  }

  private byte(): number {
    return this.buffer[this.start++];
  }

  private byteOrEnd(): number {
    if (!this.fill(1)) throw new Error('unexpected end of input');
    return this.buffer[this.start++];
  }

  // Ensures n unread bytes are buffered; false at end of input.
  private fill(n: number): boolean {
    if (this.end - this.start >= n) return true;
    if (this.start > 0) {
      this.buffer.copyWithin(0, this.start, this.end);
      this.end -= this.start;
      this.start = 0;
    }
    if (n > this.buffer.length) {
      const grown = new Uint8Array(Math.max(n, this.buffer.length * 2));
      grown.set(this.buffer.subarray(0, this.end));
      this.buffer = grown;
    }
    while (this.end < n) {
      const count = readChunk(this.fd, this.buffer, this.end);
      if (count === 0) return false;
      this.end += count;
    }
    return true;
  }
}

function readChunk(fd: number, buffer: Uint8Array, offset: number): number {
  for (;;) {
    try {
      return readSync(fd, buffer, offset, buffer.length - offset, null);
    } catch (e) {
      // A non-blocking stdin reports EAGAIN until data arrives.
      if (!(e instanceof Error) || !e.message.includes('EAGAIN')) throw e;
    }
  }
}

// Writes messages to a file descriptor.
export class Writer {
  constructor(private readonly fd: number) {}

  write(type: MessageType, method: string, payload: Uint8Array): void {
    const name = encodeText(method);
    const out = new Uint8Array(
      2 + binHeaderSize(name.length) + name.length + binHeaderSize(payload.length) + payload.length,
    );
    out[0] = fixArray3;
    out[1] = type;
    let at = writeBin(out, 2, name);
    at = writeBin(out, at, payload);
    let written = 0;
    while (written < at) written += writeSync(this.fd, out, written, at - written);
  }
}

function binHeaderSize(length: number): number {
  return length < 0x100 ? 2 : length < 0x10000 ? 3 : 5;
}

function writeBin(out: Uint8Array, at: number, data: Uint8Array): number {
  const n = data.length;
  if (n < 0x100) {
    out[at++] = bin8;
    out[at++] = n;
  } else if (n < 0x10000) {
    out[at++] = bin16;
    out[at++] = n >>> 8;
    out[at++] = n & 0xff;
  } else {
    out[at++] = bin32;
    out[at++] = n >>> 24;
    out[at++] = (n >>> 16) & 0xff;
    out[at++] = (n >>> 8) & 0xff;
    out[at++] = n & 0xff;
  }
  out.set(data, at);
  return at + n;
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}
