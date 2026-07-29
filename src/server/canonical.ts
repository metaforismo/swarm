/**
 * Canonical field framing.
 *
 * Byte-identical port of Reveal Engine's `encodeFields` (`src/internal/canonical.ts`):
 * a uint32 field count, then a uint32 byte length and the bytes of every field.
 * Numbers and BigInts are their base-10 ASCII text, strings are UTF-8, byte
 * arrays are themselves. The framing is unambiguous across field boundaries,
 * which is what makes a commitment over a field vector a commitment to the
 * vector and not merely to its concatenation.
 *
 * It is a port and not an import because the engine does not export the function
 * from any subpath of its `exports` map (see `./engine.ts`). Byte-identity is
 * pinned by `tests/server-derivation.test.mjs`, against the encoder in
 * `tools/simulate.mjs` that produced every frozen digest in this repository.
 */
import { createHmac } from 'node:crypto';

export type CanonicalField = string | Uint8Array | bigint | number;

function lengthPrefix(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff)
    throw new Error('Canonical field is too large');
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(length);
  return result;
}

export function encodeFields(fields: readonly CanonicalField[]): Buffer {
  const encoded = fields.map((field) => {
    if (typeof field === 'bigint') return Buffer.from(field.toString(10), 'ascii');
    if (typeof field === 'number') {
      if (!Number.isSafeInteger(field)) throw new Error('Canonical number is not safe');
      return Buffer.from(String(field), 'ascii');
    }
    return typeof field === 'string' ? Buffer.from(field, 'utf8') : Buffer.from(field);
  });
  return Buffer.concat([
    lengthPrefix(encoded.length),
    ...encoded.flatMap((part) => [lengthPrefix(part.length), part]),
  ]);
}

/** HMAC-SHA256 keyed by the sealed seed. The seed is the only secret in the scheme. */
export function hmacSha256Hex(seedHex: string, payload: Buffer): string {
  return createHmac('sha256', Buffer.from(seedHex, 'hex')).update(payload).digest('hex');
}

/** 32 bytes of hex, any case in, lowercase out. Anything else is a caller error. */
export function normalizeHex32(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/iu.test(value))
    throw new Error(`${what} must be exactly 32 bytes of hexadecimal`);
  return value.toLowerCase();
}
