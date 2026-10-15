import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

// Vectors come from zeebo/xxh3 via xxh3-vectors/main.go (`go run . > vectors.json`).
const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, 'xxh3-vectors/vectors.json'), 'utf8'));

const out = compileSources('tsc-ts-xxh3-', ['compiler/xxh3.ts']);
const { hash128, hash128String, toHex, Hasher128 } = await import(pathToFileURL(join(out, 'compiler/xxh3.js')).href);

/** Matches `input` in main.go. */
function input(n) {
  const b = new Uint8Array(n);
  let s = n >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = s >>> 24;
  }
  return b;
}

function feed(hasher, data, chunks) {
  for (let i = 0, off = 0; off < data.length; i++) {
    const end = Math.min(off + chunks[i % chunks.length], data.length);
    hasher.update(data.subarray(off, end));
    off = end;
  }
}

test('one-shot hashes match zeebo/xxh3', () => {
  vectors.sizes.forEach((n, i) => assert.equal(toHex(hash128(input(n))), vectors.hashes[i], `length ${n}`));
});

test('unaligned views hash like copies', () => {
  for (const n of [5, 13, 100, 200, 1000, 5000]) {
    const data = input(n);
    const padded = new Uint8Array(n + 3);
    padded.set(data, 3);
    assert.equal(toHex(hash128(padded.subarray(3))), toHex(hash128(data)), `length ${n}`);
  }
});

test('streaming hashes match zeebo/xxh3', () => {
  for (const { length, chunks, hash } of vectors.streams) {
    const hasher = new Hasher128();
    feed(hasher, input(length), chunks);
    assert.equal(toHex(hasher.digest()), hash, `length ${length}, chunks ${chunks}`);
  }
});

test('digest does not consume the hasher; reset restarts it', () => {
  const data = input(3000);
  const hasher = new Hasher128();
  hasher.update(data.subarray(0, 2000));
  assert.equal(toHex(hasher.digest()), toHex(hash128(data.subarray(0, 2000))));
  hasher.update(data.subarray(2000));
  assert.equal(toHex(hasher.digest()), toHex(hash128(data)));
  hasher.reset();
  hasher.update(data.subarray(0, 10));
  assert.equal(toHex(hasher.digest()), toHex(hash128(data.subarray(0, 10))));
});

test('strings hash as UTF-8', () => {
  for (const { text, hash } of vectors.strings) {
    assert.equal(toHex(hash128String(text)), hash, text);
    const hasher = new Hasher128();
    hasher.updateString(text);
    assert.equal(toHex(hasher.digest()), hash, text);
  }
});

test('digest bytes are low then high, little-endian', () => {
  const digest = hash128(new Uint8Array(0));
  // Hi 0x99aa06d3014798d8, Lo 0x6001c324468d497f.
  assert.deepEqual(
    [...digest],
    [0x7f, 0x49, 0x8d, 0x46, 0x24, 0xc3, 0x01, 0x60, 0xd8, 0x98, 0x47, 0x01, 0xd3, 0x06, 0xaa, 0x99],
  );
  assert.equal(toHex(digest), '99aa06d3014798d86001c324468d497f');
});
