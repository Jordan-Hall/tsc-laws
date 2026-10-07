/**
 * XXH3-128 with the default secret and seed 0.
 *
 * Digests are 16 bytes: the low 64 bits then the high 64 bits, each little-endian.
 * 64-bit values are held as pairs of unsigned 32-bit numbers (high word `H`, low word `L`).
 */

const SECRET = new Uint8Array([
  0xb8, 0xfe, 0x6c, 0x39, 0x23, 0xa4, 0x4b, 0xbe, 0x7c, 0x01, 0x81, 0x2c, 0xf7, 0x21, 0xad, 0x1c, 0xde, 0xd4, 0x6d,
  0xe9, 0x83, 0x90, 0x97, 0xdb, 0x72, 0x40, 0xa4, 0xa4, 0xb7, 0xb3, 0x67, 0x1f, 0xcb, 0x79, 0xe6, 0x4e, 0xcc, 0xc0,
  0xe5, 0x78, 0x82, 0x5a, 0xd0, 0x7d, 0xcc, 0xff, 0x72, 0x21, 0xb8, 0x08, 0x46, 0x74, 0xf7, 0x43, 0x24, 0x8e, 0xe0,
  0x35, 0x90, 0xe6, 0x81, 0x3a, 0x26, 0x4c, 0x3c, 0x28, 0x52, 0xbb, 0x91, 0xc3, 0x00, 0xcb, 0x88, 0xd0, 0x65, 0x8b,
  0x1b, 0x53, 0x2e, 0xa3, 0x71, 0x64, 0x48, 0x97, 0xa2, 0x0d, 0xf9, 0x4e, 0x38, 0x19, 0xef, 0x46, 0xa9, 0xde, 0xac,
  0xd8, 0xa8, 0xfa, 0x76, 0x3f, 0xe3, 0x9c, 0x34, 0x3f, 0xf9, 0xdc, 0xbb, 0xc7, 0xc7, 0x0b, 0x4f, 0x1d, 0x8a, 0x51,
  0xe0, 0x4b, 0xcd, 0xb4, 0x59, 0x31, 0xc8, 0x9f, 0x7e, 0xc9, 0xd9, 0x78, 0x73, 0x64, 0xea, 0xc5, 0xac, 0x83, 0x34,
  0xd3, 0xeb, 0xc3, 0xc5, 0x81, 0xa0, 0xff, 0xfa, 0x13, 0x63, 0xeb, 0x17, 0x0d, 0xdd, 0x51, 0xb7, 0xf0, 0xda, 0x49,
  0xd3, 0x16, 0x55, 0x26, 0x29, 0xd4, 0x68, 0x9e, 0x2b, 0x16, 0xbe, 0x58, 0x7d, 0x47, 0xa1, 0xfc, 0x8f, 0xf8, 0xb8,
  0xd1, 0x7a, 0xd0, 0x31, 0xce, 0x45, 0xcb, 0x3a, 0x8f, 0x95, 0x16, 0x04, 0x28, 0xaf, 0xd7, 0xfb, 0xca, 0xbb, 0x4b,
  0x40, 0x7e,
]);

const STRIPE = 64;
const BLOCK = 1024;
const STRIPES_PER_BLOCK = 16;

const P32_1 = 0x9e3779b1;
const P32_2 = 0x85ebca77;
const P32_3 = 0xc2b2ae3d;
const P64_1H = 0x9e3779b1;
const P64_1L = 0x85ebca87;
const P64_2H = 0xc2b2ae3d;
const P64_2L = 0x27d4eb4f;
const P64_3H = 0x165667b1;
const P64_3L = 0x9e3779f9;
const P64_4H = 0x85ebca77;
const P64_4L = 0xc2b2ae63;
const P64_5H = 0x27d4eb2f;
const P64_5L = 0x165667c5;

const INV32 = 1 / 4294967296;

function read32(b: Uint8Array, i: number): number {
  const j = i >>> 0;
  return (b[j] | (b[j + 1] << 8) | (b[j + 2] << 16) | (b[j + 3] << 24)) >>> 0;
}

/** Secret words starting at byte `offset`, little-endian. */
function secretWords(offset: number, count: number): Uint32Array {
  const words = new Uint32Array(count);
  for (let i = 0; i < count; i++) words[i] = read32(SECRET, offset + 4 * i);
  return words;
}

/** Stripe keys: stripe `s` of a block uses words `2s` to `2s + 15`. */
const KEY = secretWords(0, 48);
/** Keys at byte offsets 3 mod 4: word `w` starts at byte `3 + 4w`. */
const KEY3 = secretWords(3, 47);
const SCRAMBLE_KEY = secretWords(128, 16);
/** Key for the final stripe. */
const LAST_KEY = secretWords(121, 16);
const MERGE_LO_KEY = secretWords(11, 16);
const MERGE_HI_KEY = secretWords(117, 16);

const INIT_ACC = new Uint32Array([
  P32_3,
  0,
  P64_1L,
  P64_1H,
  P64_2L,
  P64_2H,
  P64_3L,
  P64_3H,
  P64_4L,
  P64_4H,
  P32_2,
  0,
  P64_5L,
  P64_5H,
  P32_1,
  0,
]);
/** Lanes for one-shot hashing: lane `i` is words `2i` (low) and `2i + 1` (high). */
const scratchAcc = new Uint32Array(16);

// Result of the 64-bit helpers.
let rH = 0;
let rL = 0;
// High 64 bits of the last `mul128`.
let mH = 0;
let mL = 0;
// The 128-bit result being computed.
let loH = 0;
let loL = 0;
let hiH = 0;
let hiL = 0;

/** rH:rL = a * b (32 × 32 → 64). */
function mul32(a: number, b: number): void {
  a >>>= 0;
  b >>>= 0;
  const lo = Math.imul(a, b) >>> 0;
  rL = lo;
  // The float product is within 2^11 of exact, so rounding recovers the high word.
  rH = ((a * b - lo) * INV32 + 0.5) >>> 0;
}

/** rH:rL = low 64 bits of a * b. */
function mul64(aH: number, aL: number, bH: number, bL: number): void {
  mul32(aL, bL);
  rH = (rH + Math.imul(aH, bL) + Math.imul(aL, bH)) >>> 0;
}

/** mH:mL:rH:rL = a * b (64 × 64 → 128). */
function mul128(aH: number, aL: number, bH: number, bL: number): void {
  mul32(aL, bL);
  const w0 = rL;
  const llH = rH;
  mul32(aL, bH);
  const lhH = rH;
  const lhL = rL;
  mul32(aH, bL);
  const hlH = rH;
  const hlL = rL;
  mul32(aH, bH);
  const c1 = llH + lhL + hlL;
  const w1 = c1 >>> 0;
  const c2 = lhH + hlH + rL + (c1 - w1) * INV32;
  const w2 = c2 >>> 0;
  mH = (rH + (c2 - w2) * INV32) >>> 0;
  mL = w2;
  rH = w1;
  rL = w0;
}

/** rH:rL = high xor low half of the 128-bit product a * b. */
function mulFold(aH: number, aL: number, bH: number, bL: number): void {
  mul128(aH, aL, bH, bL);
  rH = (mH ^ rH) >>> 0;
  rL = (mL ^ rL) >>> 0;
}

/** rH:rL = a + b. */
function add64(aH: number, aL: number, bH: number, bL: number): void {
  const s = (aL >>> 0) + (bL >>> 0);
  rL = s >>> 0;
  rH = (aH + bH + (s > 0xffffffff ? 1 : 0)) >>> 0;
}

/** rH:rL = XXH3 avalanche of h:l. */
function avalanche(h: number, l: number): void {
  mul64(h, l ^ (h >>> 5), 0x16566791, 0x9e3779f9);
  rL = (rL ^ rH) >>> 0;
}

/** rH:rL = XXH64 avalanche of a 32-bit value. */
function avalanche32(x: number): void {
  mul64(0, x, P64_2H, P64_2L);
  mul64(rH ^ (rH >>> 29), rL ^ ((rL >>> 29) | (rH << 3)), P64_3H, P64_3L);
  rL = (rL ^ rH) >>> 0;
}

function bswap32(x: number): number {
  return ((x >>> 24) | ((x >>> 8) & 0xff00) | ((x & 0xff00) << 8) | (x << 24)) >>> 0;
}

function hash0(): void {
  loH = 0x6001c324;
  loL = 0x468d497f;
  hiH = 0x99aa06d3;
  hiL = 0x014798d8;
}

function hash1to3(b: Uint8Array, p: number, n: number): void {
  const combinedL = ((b[p] << 16) | (b[p + (n >> 1)] << 24) | b[p + n - 1] | (n << 8)) >>> 0;
  const swapped = bswap32(combinedL);
  const combinedH = (swapped << 13) | (swapped >>> 19);
  avalanche32(combinedL ^ KEY[0] ^ KEY[1]);
  loH = rH;
  loL = rL;
  avalanche32(combinedH ^ KEY[2] ^ KEY[3]);
  hiH = rH;
  hiL = rL;
}

function hash4to8(b: Uint8Array, p: number, n: number): void {
  const inL = read32(b, p) ^ KEY[4] ^ KEY[6];
  const inH = read32(b, p + n - 4) ^ KEY[5] ^ KEY[7];
  mul128(inH, inL, P64_1H, P64_1L + n * 4);
  const pH = rH;
  const pL = rL;
  // hi = product.hi + (product.lo << 1)
  add64(mH, mL, (pH << 1) | (pL >>> 31), pL << 1);
  const h = rH;
  const l = rL;
  // lo = product.lo ^ (hi >> 3); lo ^= lo >> 35; lo *= C; lo ^= lo >> 28
  const xH = pH ^ (h >>> 3);
  const xL = pL ^ ((l >>> 3) | (h << 29)) ^ (xH >>> 3);
  mul64(xH, xL, 0x9fb21c65, 0x1e98df25);
  loL = (rL ^ ((rL >>> 28) | (rH << 4))) >>> 0;
  loH = (rH ^ (rH >>> 28)) >>> 0;
  avalanche(h, l);
  hiH = rH;
  hiL = rL;
}

function hash9to16(b: Uint8Array, p: number, n: number): void {
  const inHiL = read32(b, p + n - 8);
  const inHiH = read32(b, p + n - 4);
  mul128(read32(b, p + 4) ^ inHiH ^ KEY[9] ^ KEY[11], read32(b, p) ^ inHiL ^ KEY[8] ^ KEY[10], P64_1H, P64_1L);
  let lH = (rH + ((n - 1) << 22)) >>> 0;
  let lL = rL;
  const mhH = mH;
  const mhL = mL;
  // m.hi += inHi + low32(inHi) * (P32_2 - 1), with inHi flipped by the secret
  const fH = (inHiH ^ KEY[13] ^ KEY[15]) >>> 0;
  const fL = (inHiL ^ KEY[12] ^ KEY[14]) >>> 0;
  mul32(fL, P32_2 - 1);
  add64(rH, rL, fH, fL);
  add64(rH, rL, mhH, mhL);
  const hH = rH;
  const hL = rL;
  lH ^= bswap32(hL);
  lL ^= bswap32(hH);
  mul128(lH, lL, P64_2H, P64_2L);
  const aLoH = rH;
  const aLoL = rL;
  const aHiH = mH;
  const aHiL = mL;
  mul64(hH, hL, P64_2H, P64_2L);
  add64(aHiH, aHiL, rH, rL);
  avalanche(rH, rL);
  hiH = rH;
  hiL = rL;
  avalanche(aLoH, aLoL);
  loH = rH;
  loL = rL;
}

/** Mixes 16 bytes at `p1` and 16 at `p2` into the result, keyed by `key[w]` to `key[w + 7]`. */
function mix32(b: Uint8Array, p1: number, p2: number, key: Uint32Array, w: number): void {
  const a0L = read32(b, p1);
  const a0H = read32(b, p1 + 4);
  const a1L = read32(b, p1 + 8);
  const a1H = read32(b, p1 + 12);
  const b0L = read32(b, p2);
  const b0H = read32(b, p2 + 4);
  const b1L = read32(b, p2 + 8);
  const b1H = read32(b, p2 + 12);
  mulFold(a0H ^ key[w + 1], a0L ^ key[w], a1H ^ key[w + 3], a1L ^ key[w + 2]);
  add64(loH, loL, rH, rL);
  const xH = rH;
  const xL = rL;
  add64(b0H, b0L, b1H, b1L);
  loH = (xH ^ rH) >>> 0;
  loL = (xL ^ rL) >>> 0;
  mulFold(b0H ^ key[w + 5], b0L ^ key[w + 4], b1H ^ key[w + 7], b1L ^ key[w + 6]);
  add64(hiH, hiL, rH, rL);
  const yH = rH;
  const yL = rL;
  add64(a0H, a0L, a1H, a1L);
  hiH = (yH ^ rH) >>> 0;
  hiL = (yL ^ rL) >>> 0;
}

function startMidSize(n: number): void {
  mul64(0, n, P64_1H, P64_1L);
  loH = rH;
  loL = rL;
  hiH = 0;
  hiL = 0;
}

/** Final mix for 17 to 240 bytes. */
function finishMidSize(n: number): void {
  mul64(loH, loL, P64_1H, P64_1L);
  const aH = rH;
  const aL = rL;
  mul64(hiH, hiL, P64_4H, P64_4L);
  add64(aH, aL, rH, rL);
  const bH = rH;
  const bL = rL;
  mul64(0, n, P64_2H, P64_2L);
  add64(bH, bL, rH, rL);
  const h = rH;
  const l = rL;
  add64(hiH, hiL, loH, loL);
  avalanche(rH, rL);
  loH = rH;
  loL = rL;
  avalanche(h, l);
  // hi = -avalanche(h:l)
  hiL = -rL >>> 0;
  hiH = (~rH + (rL === 0 ? 1 : 0)) >>> 0;
}

function hash17to128(b: Uint8Array, p: number, n: number): void {
  startMidSize(n);
  for (let i = (n - 1) >> 5; i >= 0; i--) mix32(b, p + 16 * i, p + n - 16 * (i + 1), KEY, 8 * i);
  finishMidSize(n);
}

function hash129to240(b: Uint8Array, p: number, n: number): void {
  startMidSize(n);
  for (let i = 0; i < 4; i++) mix32(b, p + 32 * i, p + 32 * i + 16, KEY, 8 * i);
  avalanche(loH, loL);
  loH = rH;
  loL = rL;
  avalanche(hiH, hiL);
  hiH = rH;
  hiL = rL;
  const rounds = n >> 5;
  for (let i = 4; i < rounds; i++) mix32(b, p + 32 * i, p + 32 * i + 16, KEY3, 8 * (i - 4));
  // Secret byte 103.
  mix32(b, p + n - 16, p + n - 32, KEY3, 25);
  finishMidSize(n);
}

/**
 * Accumulates `count <= 16` stripes starting at word `i` of `d`; stripe `s` is keyed by `key[w + 2s]` onward.
 * Lanes are summed as `h * 2^32 + m * 2^16 + l`, exact in doubles for up to 16 stripes, and wrapped once at the end.
 */
function accumulateStripes(
  acc: Uint32Array,
  d: Uint32Array,
  i: number,
  count: number,
  key: Uint32Array,
  w: number,
): void {
  let l0 = acc[0];
  let m0 = 0;
  let h0 = acc[1];
  let l1 = acc[2];
  let m1 = 0;
  let h1 = acc[3];
  let l2 = acc[4];
  let m2 = 0;
  let h2 = acc[5];
  let l3 = acc[6];
  let m3 = 0;
  let h3 = acc[7];
  let l4 = acc[8];
  let m4 = 0;
  let h4 = acc[9];
  let l5 = acc[10];
  let m5 = 0;
  let h5 = acc[11];
  let l6 = acc[12];
  let m6 = 0;
  let h6 = acc[13];
  let l7 = acc[14];
  let m7 = 0;
  let h7 = acc[15];
  for (let s = 0; s < count; s++) {
    // `| 0` keeps the indexes integers.
    const o = (i + 16 * s) | 0;
    const q = (w + 2 * s) | 0;
    // Neighbor lane += data; lane += low32(keyed) * high32(keyed), split at bit 16.
    const d0 = d[o];
    const d1 = d[o + 1];
    const k0 = (d0 ^ key[q]) >>> 0;
    const k1 = (d1 ^ key[q + 1]) >>> 0;
    l1 += d0;
    h1 += d1;
    l0 += k0 * (k1 & 0xffff);
    m0 += k0 * (k1 >>> 16);
    const d2 = d[o + 2];
    const d3 = d[o + 3];
    const k2 = (d2 ^ key[q + 2]) >>> 0;
    const k3 = (d3 ^ key[q + 3]) >>> 0;
    l0 += d2;
    h0 += d3;
    l1 += k2 * (k3 & 0xffff);
    m1 += k2 * (k3 >>> 16);
    const d4 = d[o + 4];
    const d5 = d[o + 5];
    const k4 = (d4 ^ key[q + 4]) >>> 0;
    const k5 = (d5 ^ key[q + 5]) >>> 0;
    l3 += d4;
    h3 += d5;
    l2 += k4 * (k5 & 0xffff);
    m2 += k4 * (k5 >>> 16);
    const d6 = d[o + 6];
    const d7 = d[o + 7];
    const k6 = (d6 ^ key[q + 6]) >>> 0;
    const k7 = (d7 ^ key[q + 7]) >>> 0;
    l2 += d6;
    h2 += d7;
    l3 += k6 * (k7 & 0xffff);
    m3 += k6 * (k7 >>> 16);
    const d8 = d[o + 8];
    const d9 = d[o + 9];
    const k8 = (d8 ^ key[q + 8]) >>> 0;
    const k9 = (d9 ^ key[q + 9]) >>> 0;
    l5 += d8;
    h5 += d9;
    l4 += k8 * (k9 & 0xffff);
    m4 += k8 * (k9 >>> 16);
    const d10 = d[o + 10];
    const d11 = d[o + 11];
    const k10 = (d10 ^ key[q + 10]) >>> 0;
    const k11 = (d11 ^ key[q + 11]) >>> 0;
    l4 += d10;
    h4 += d11;
    l5 += k10 * (k11 & 0xffff);
    m5 += k10 * (k11 >>> 16);
    const d12 = d[o + 12];
    const d13 = d[o + 13];
    const k12 = (d12 ^ key[q + 12]) >>> 0;
    const k13 = (d13 ^ key[q + 13]) >>> 0;
    l7 += d12;
    h7 += d13;
    l6 += k12 * (k13 & 0xffff);
    m6 += k12 * (k13 >>> 16);
    const d14 = d[o + 14];
    const d15 = d[o + 15];
    const k14 = (d14 ^ key[q + 14]) >>> 0;
    const k15 = (d15 ^ key[q + 15]) >>> 0;
    l6 += d14;
    h6 += d15;
    l7 += k14 * (k15 & 0xffff);
    m7 += k14 * (k15 >>> 16);
  }
  storeLane(acc, 0, l0, m0, h0);
  storeLane(acc, 2, l1, m1, h1);
  storeLane(acc, 4, l2, m2, h2);
  storeLane(acc, 6, l3, m3, h3);
  storeLane(acc, 8, l4, m4, h4);
  storeLane(acc, 10, l5, m5, h5);
  storeLane(acc, 12, l6, m6, h6);
  storeLane(acc, 14, l7, m7, h7);
}

/** Wraps lane `h * 2^32 + m * 2^16 + l` to 64 bits and stores it at `acc[i]`. */
function storeLane(acc: Uint32Array, i: number, l: number, m: number, h: number): void {
  const mHigh = Math.floor(m / 65536);
  const lCarry = Math.floor(l * INV32);
  const low = l - lCarry * 4294967296 + (m - mHigh * 65536) * 65536;
  const carry = low > 0xffffffff ? 1 : 0;
  acc[i] = low;
  acc[i + 1] = h + lCarry + mHigh + carry;
}

function scramble(acc: Uint32Array): void {
  for (let i = 0; i < 16; i += 2) {
    const h = acc[i + 1];
    const l = (acc[i] ^ (h >>> 15) ^ SCRAMBLE_KEY[i]) >>> 0;
    const pL = Math.imul(l, P32_1) >>> 0;
    const pH = ((l * P32_1 - pL) * INV32 + 0.5) >>> 0;
    acc[i] = pL;
    acc[i + 1] = pH + Math.imul(h ^ SCRAMBLE_KEY[i + 1], P32_1);
  }
}

const BLOCK_WORDS = BLOCK / 4;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const scratchBytes = new Uint8Array(BLOCK);
const scratchWords = new Uint32Array(scratchBytes.buffer);

/** Loads `n` bytes (a multiple of 4) at `p` into `scratchWords`. */
function loadScratch(b: Uint8Array, p: number, n: number): void {
  if (LITTLE_ENDIAN) scratchBytes.set(b.subarray(p, p + n));
  else for (let i = 0; i < n; i += 4) scratchWords[i >> 2] = read32(b, p + i);
}

/** Accumulates `count` whole blocks at `p`. */
function accumulateBlocks(acc: Uint32Array, b: Uint8Array, p: number, count: number): void {
  const offset = b.byteOffset + p;
  if (LITTLE_ENDIAN && (offset & 3) === 0) {
    // Read words in place.
    const d = new Uint32Array(b.buffer, offset, count * BLOCK_WORDS);
    for (let k = 0; k < count; k++) {
      accumulateStripes(acc, d, k * BLOCK_WORDS, STRIPES_PER_BLOCK, KEY, 0);
      scramble(acc);
    }
    return;
  }
  for (let k = 0; k < count; k++) {
    loadScratch(b, p + k * BLOCK, BLOCK);
    accumulateStripes(acc, scratchWords, 0, STRIPES_PER_BLOCK, KEY, 0);
    scramble(acc);
  }
}

/** Accumulates `n > 0` bytes; the final stripe ends at `p + n` and may reread bytes before `p`. */
function accumulate(acc: Uint32Array, b: Uint8Array, p: number, n: number): void {
  const blocks = Math.floor((n - 1) / BLOCK);
  accumulateBlocks(acc, b, p, blocks);
  p += blocks * BLOCK;
  n -= blocks * BLOCK;
  const stripes = (n - 1) >> 6;
  loadScratch(b, p, stripes * STRIPE);
  accumulateStripes(acc, scratchWords, 0, stripes, KEY, 0);
  loadScratch(b, p + n - STRIPE, STRIPE);
  accumulateStripes(acc, scratchWords, 0, 1, LAST_KEY, 0);
}

/** Merges the lanes into the result for a total length of `n` bytes. */
function merge(acc: Uint32Array, n: number): void {
  const nH = Math.floor(n * INV32);
  const nL = n >>> 0;
  mul64(nH, nL, P64_1H, P64_1L);
  loH = rH;
  loL = rL;
  mul64(nH, nL, P64_2H, P64_2L);
  hiH = ~rH >>> 0;
  hiL = ~rL >>> 0;
  const kl = MERGE_LO_KEY;
  const kh = MERGE_HI_KEY;
  for (let i = 0; i < 16; i += 4) {
    mulFold(acc[i + 1] ^ kl[i + 1], acc[i] ^ kl[i], acc[i + 3] ^ kl[i + 3], acc[i + 2] ^ kl[i + 2]);
    add64(loH, loL, rH, rL);
    loH = rH;
    loL = rL;
    mulFold(acc[i + 1] ^ kh[i + 1], acc[i] ^ kh[i], acc[i + 3] ^ kh[i + 3], acc[i + 2] ^ kh[i + 2]);
    add64(hiH, hiL, rH, rL);
    hiH = rH;
    hiL = rL;
  }
  avalanche(loH, loL);
  loH = rH;
  loL = rL;
  avalanche(hiH, hiL);
  hiH = rH;
  hiL = rL;
}

function copyAcc(to: Uint32Array, from: Uint32Array): void {
  for (let i = 0; i < 16; i++) to[i] = from[i];
}

/** Hashes the `n` bytes at `p` into the result. */
function hashRange(b: Uint8Array, p: number, n: number): void {
  if (n <= 16) {
    if (n > 8) hash9to16(b, p, n);
    else if (n > 3) hash4to8(b, p, n);
    else if (n > 0) hash1to3(b, p, n);
    else hash0();
  } else if (n <= 128) {
    hash17to128(b, p, n);
  } else if (n <= 240) {
    hash129to240(b, p, n);
  } else {
    copyAcc(scratchAcc, INIT_ACC);
    accumulate(scratchAcc, b, p, n);
    merge(scratchAcc, n);
  }
}

function write32(out: Uint8Array, i: number, v: number): void {
  const j = i >>> 0;
  out[j] = v;
  out[j + 1] = v >>> 8;
  out[j + 2] = v >>> 16;
  out[j + 3] = v >>> 24;
}

function digestBytes(): Uint8Array {
  const out = new Uint8Array(16);
  write32(out, 0, loL);
  write32(out, 4, loH);
  write32(out, 8, hiL);
  write32(out, 12, hiH);
  return out;
}

const encoder = new TextEncoder();

/** XXH3-128 digest of `data`: low 64 bits then high 64 bits, little-endian. */
export function hash128(data: Uint8Array): Uint8Array {
  hashRange(data, 0, data.length);
  return digestBytes();
}

/** XXH3-128 digest of the UTF-8 encoding of `text`. */
export function hash128String(text: string): Uint8Array {
  return hash128(encoder.encode(text));
}

const HEX = '0123456789abcdef';

/** Hex form of a digest: high 64 bits then low 64 bits, 32 lowercase digits. */
export function toHex(digest: Uint8Array): string {
  let s = '';
  for (let i = 15; i >= 0; i--) {
    const b = digest[i];
    s += HEX[b >> 4] + HEX[b & 15];
  }
  return s;
}

/** Incremental XXH3-128. `digest()` equals `hash128` of all bytes passed to `update`. */
export class Hasher128 {
  private readonly acc = new Uint32Array(16);
  // A block plus the stripe before it, which the final stripe may reread.
  private readonly buffer = new Uint8Array(BLOCK + STRIPE);
  private buffered = 0;
  private blocks = 0;

  constructor() {
    copyAcc(this.acc, INIT_ACC);
  }

  reset(): void {
    copyAcc(this.acc, INIT_ACC);
    this.buffered = 0;
    this.blocks = 0;
  }

  update(data: Uint8Array): void {
    const acc = this.acc;
    const buffer = this.buffer;
    const n = data.length;
    let p = 0;
    // With nothing buffered, hash whole blocks in place, leaving more than a block to buffer.
    if (this.buffered === 0) {
      const blocks = n > buffer.length ? Math.floor((n - buffer.length - 1) / BLOCK) + 1 : 0;
      accumulateBlocks(acc, data, 0, blocks);
      this.blocks += blocks;
      p = blocks * BLOCK;
    }
    while (p < n) {
      if (this.buffered === buffer.length) {
        accumulateBlocks(acc, buffer, 0, 1);
        this.blocks++;
        for (let i = 0; i < STRIPE; i++) buffer[i] = buffer[BLOCK + i];
        this.buffered = STRIPE;
      }
      const end = Math.min(n, p + buffer.length - this.buffered);
      let o = this.buffered;
      for (; p < end; p++, o++) buffer[o] = data[p];
      this.buffered = o;
    }
  }

  updateString(text: string): void {
    this.update(encoder.encode(text));
  }

  digest(): Uint8Array {
    if (this.blocks === 0) {
      hashRange(this.buffer, 0, this.buffered);
    } else {
      copyAcc(scratchAcc, this.acc);
      accumulate(scratchAcc, this.buffer, 0, this.buffered);
      merge(scratchAcc, this.blocks * BLOCK + this.buffered);
    }
    return digestBytes();
  }
}
