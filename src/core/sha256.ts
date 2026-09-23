/**
 * Pure, synchronous SHA-256 (spec §8.6).
 *
 * The engine's state hash must be identical on every machine AND usable in the
 * browser UI (Stage 5), which cannot import `node:crypto`. A standards-correct
 * SHA-256 produces byte-identical digests to Node's `createHash("sha256")`, so
 * swapping the implementation keeps every recorded content hash and trace hash
 * valid (the hash-stability tests assert this). Pure: no I/O, no globals beyond
 * TextEncoder (present in Node 18+ and all browsers).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_H = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

// Module-level singletons to eliminate garbage collection pressure and allocation overhead.
const SHARED_TEXT_ENCODER = new TextEncoder();
const WORK_W = new Uint32Array(64);

/**
 * The largest message buffer this module keeps between calls. Per-step state
 * hashes are a few KB, so they all reuse one buffer; an input whose worst-case
 * encoding needs more gets a transient buffer sized for it alone. Without the cap
 * the reused buffer only ever grew — hashing the ~2.7 MB overworld once (the
 * buffer reserves 4 bytes per UTF-16 unit) pinned ~11 MB for the life of every
 * process and worker (bug_0641).
 */
export const SHA256_RETAINED_BUFFER_MAX_BYTES = 1024 * 1024;

let msgBuffer = new Uint8Array(4096);

function getMsgBuffer(requiredSize: number): Uint8Array {
  if (requiredSize > SHA256_RETAINED_BUFFER_MAX_BYTES) return new Uint8Array(requiredSize);
  if (requiredSize > msgBuffer.length) {
    msgBuffer = new Uint8Array(
      Math.min(SHA256_RETAINED_BUFFER_MAX_BYTES, Math.max(requiredSize, msgBuffer.length * 2)),
    );
  }
  return msgBuffer;
}

/** Verification seam: bytes of message buffer currently retained between calls. */
export function sha256RetainedBufferBytes(): number {
  return msgBuffer.length;
}

function hex32(num: number): string {
  return (num >>> 0).toString(16).padStart(8, "0");
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
export function sha256Hex(input: string): string {
  // Optimization: Use encodeInto into a pre-allocated Uint8Array message buffer and reuse
  // Uint32Array work buffers to avoid object creation during state hashing (~1.5x speedup).
  const str = input ?? "";
  const maxBytes = str.length * 4;
  const maxWithPadding = maxBytes + 1 + 64 + 8;
  const msg = getMsgBuffer(maxWithPadding);

  const { written: byteLen } = SHARED_TEXT_ENCODER.encodeInto(str, msg);
  const bitLen = byteLen * 8;

  // Pad: append 0x80, then zeros, then the 64-bit big-endian length.
  const withOne = byteLen + 1;
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;

  msg.fill(0, byteLen, total);
  msg[byteLen] = 0x80;

  // 64-bit length; bit length fits in the low 32 bits for our inputs, but write both halves.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  for (let i = 0; i < 4; i++) msg[total - 8 + i] = (hi >>> (24 - i * 8)) & 0xff;
  for (let i = 0; i < 4; i++) msg[total - 4 + i] = (lo >>> (24 - i * 8)) & 0xff;

  let h0 = INITIAL_H[0]!;
  let h1 = INITIAL_H[1]!;
  let h2 = INITIAL_H[2]!;
  let h3 = INITIAL_H[3]!;
  let h4 = INITIAL_H[4]!;
  let h5 = INITIAL_H[5]!;
  let h6 = INITIAL_H[6]!;
  let h7 = INITIAL_H[7]!;

  const w = WORK_W;

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        ((msg[off + i * 4]! << 24) |
          (msg[off + i * 4 + 1]! << 16) |
          (msg[off + i * 4 + 2]! << 8) |
          msg[off + i * 4 + 3]!) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + hh) >>> 0;
  }

  return (
    hex32(h0) + hex32(h1) + hex32(h2) + hex32(h3) + hex32(h4) + hex32(h5) + hex32(h6) + hex32(h7)
  );
}
