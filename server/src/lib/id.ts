import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish: no i, l, o, u

/**
 * Prefixed, URL-safe ids. `mch_`, `prd_`, `qte_`, `ord_`.
 *
 * Rejection sampling, not modulo. With the alphabet at 32 characters `b % 32`
 * happens to be perfectly uniform, because 256 divides evenly by 32 -- so the
 * old version was not actually biased. It was one edit away from being biased:
 * drop a character to 31, or add one to 33, and some ids silently become more
 * likely than others, with nothing to notice it.
 *
 * That matters more here than in most places. A quote id and a consent id are
 * CAPABILITIES -- the open MCP endpoint spends that pair -- so their
 * unguessability is a security property, not a nicety. This version is uniform
 * for any alphabet length, so the guarantee survives someone editing the line
 * above without thinking about entropy.
 */
export function id(prefix: string, len = 16): string {
  const n = ALPHABET.length;
  // Largest multiple of n that fits in a byte; values at or above it are
  // discarded rather than folded, which is what would skew the distribution.
  const limit = Math.floor(256 / n) * n;
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len)) {
      if (b >= limit) continue;
      out += ALPHABET[b % n];
      if (out.length === len) break;
    }
  }
  return `${prefix}_${out}`;
}

export function slugify(input: string): string {
  return input.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'merchant';
}
