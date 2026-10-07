// Usage: xxh3-bench [bytes]
// Hashes deterministic input (as in tests/xxh3-vectors/main.go) and prints the digest and throughput.
import { Hasher128, hash128, toHex } from '../compiler/xxh3.js';

const size = process.argv.length > 2 ? Number(process.argv[2]) : 10 * 1024 * 1024;
const data = new Uint8Array(size);
let s = size >>> 0;
for (let i = 0; i < size; i++) {
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
  data[i] = s >>> 24;
}

const runs = Math.max(20, Math.ceil(2e8 / Math.max(size, 1)));
let digest = hash128(data);
const start = performance.now();
for (let i = 0; i < runs; i++) digest = hash128(data);
const ms = (performance.now() - start) / runs;

const hasher = new Hasher128();
for (let p = 0; p < size; p += 4096) hasher.update(data.subarray(p, Math.min(size, p + 4096)));
const streamed = toHex(hasher.digest());

console.log(
  `${toHex(digest)} ${Math.round(size / 1e3 / ms)} MB/s${streamed === toHex(digest) ? '' : ' stream mismatch'}`,
);
