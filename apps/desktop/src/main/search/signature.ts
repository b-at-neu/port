// The per-transcript trigram Bloom signature (#87) -- what lets `query.ts`
// answer "can this transcript possibly contain this term" for a few hundred
// bytes of comparison instead of a multi-megabyte read. Main-only: a
// `Signature` never crosses IPC, so `encodeSignature`/`decodeSignature`'s
// base64 round trip is the persisted form `main/search/store.ts` writes,
// never a renderer-facing shape.
import { SIGNATURE_HASHES, TRIGRAM_SIZE } from '../../shared/search/types'
import { foldCase } from './terms'

const MIN_BITS = 1024
const MAX_BITS = 1 << 20

/** `SIGNATURE_HASHES` independent FNV-1a offset bases -- distinct seeds are
 *  what makes the two hashes of the same trigram land in (usually)
 *  different bits rather than always setting the same one twice. */
const SEEDS = [0x811c9dc5, 0x9e3779b9] as const

// Guarded rather than asserted at the type level -- `SEEDS.length` is the
// real source of truth for how many hashes actually run; this keeps the
// shared cap honest if either changes without the other.
if (SEEDS.length !== SIGNATURE_HASHES) {
  throw new Error(`signature.ts's SEEDS has ${String(SEEDS.length)} entries, but SIGNATURE_HASHES is ${String(SIGNATURE_HASHES)}`)
}

export interface Signature {
  readonly bits: number
  readonly data: Uint8Array
}

function nextPowerOfTwo(n: number): number {
  let power = 1
  while (power < n) power *= 2
  return power
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function trigramsOf(folded: string): ReadonlySet<string> {
  const out = new Set<string>()
  for (let i = 0; i + TRIGRAM_SIZE <= folded.length; i++) out.add(folded.slice(i, i + TRIGRAM_SIZE))
  return out
}

/** FNV-1a over UTF-16 code units -- a trigram is always exactly
 *  `TRIGRAM_SIZE` characters, so this never has to worry about surrogate
 *  pairs splitting mid-hash. */
function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function setBit(data: Uint8Array, bits: number, hash: number): void {
  const index = hash % bits
  const byte = index >> 3
  const existing = data[byte]
  if (existing !== undefined) data[byte] = existing | (1 << (index & 7))
}

function testBit(data: Uint8Array, bits: number, hash: number): boolean {
  const index = hash % bits
  const byte = data[index >> 3]
  return byte !== undefined && (byte & (1 << (index & 7))) !== 0
}

/** Sizes the bit array to the trigram count rather than a fixed budget --
 *  `nextPowerOfTwo(distinctTrigrams * 8)`, clamped to `[MIN_BITS, MAX_BITS]`
 *  -- so a short transcript's signature stays small and a huge one is capped
 *  rather than growing unbounded. */
export function buildSignature(text: string): Signature {
  const folded = foldCase(text)
  const trigrams = trigramsOf(folded)
  const bits = clamp(nextPowerOfTwo(trigrams.size * 8), MIN_BITS, MAX_BITS)
  const data = new Uint8Array(bits / 8)
  for (const trigram of trigrams) {
    for (const seed of SEEDS) setBit(data, bits, fnv1a(trigram, seed))
  }
  return { bits, data }
}

/** No false negatives: every `TRIGRAM_SIZE`-window of `foldedTerm` must have
 *  every one of its `SIGNATURE_HASHES` bits set, or this returns `false` --
 *  which only ever means "definitely absent", never "probably present". A
 *  `foldedTerm` shorter than `TRIGRAM_SIZE` has no windows at all and always
 *  reads as present (`query.ts`'s `MIN_TERM_CHARS === TRIGRAM_SIZE` rail is
 *  what keeps that case from mattering in practice). */
export function mightContain(signature: Signature, foldedTerm: string): boolean {
  for (let i = 0; i + TRIGRAM_SIZE <= foldedTerm.length; i++) {
    const trigram = foldedTerm.slice(i, i + TRIGRAM_SIZE)
    for (const seed of SEEDS) {
      if (!testBit(signature.data, signature.bits, fnv1a(trigram, seed))) return false
    }
  }
  return true
}

/** Base64 of the raw bit array only -- `bits` is persisted as its own sibling
 *  field (`store.ts`'s manifest shape), never folded into this string. */
export function encodeSignature(signature: Signature): string {
  return Buffer.from(signature.data).toString('base64')
}

export function decodeSignature(bits: number, encoded: string): Signature {
  return { bits, data: new Uint8Array(Buffer.from(encoded, 'base64')) }
}
