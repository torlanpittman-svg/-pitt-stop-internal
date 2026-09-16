/**
 * Business Receipts — server-side image DECODE validation. Magic bytes prove the header; this proves the
 * file actually DECODES as a real raster image of sane dimensions (catches truncated/corrupt/oversized
 * images that a signature check alone would pass). Uses sharp (already a dependency), dynamically imported
 * so the module stays cheap to load and mockable in tests. The pure validator is unit-testable on its own.
 */
export interface DecodedMeta { format: string | null; width: number | null; height: number | null }

// Sane bounds for a phone photo of a receipt. Reject 0-dim (corrupt) and absurd dimensions (decompression
// abuse). 30000 is well above any real photo yet blocks pathological images.
export const MIN_DIM = 8
export const MAX_DIM = 30000
const DECODABLE_FORMATS = new Set(['jpeg', 'png', 'webp'])

export type DecodeValidation = { ok: true } | { ok: false; error: string }
/** PURE validation of decoded metadata (deterministic; no I/O). */
export function validateDecodedMeta(meta: DecodedMeta | null): DecodeValidation {
  if (!meta || !meta.format || !DECODABLE_FORMATS.has(meta.format)) return { ok: false, error: 'That file is not a readable JPEG, PNG or WEBP image.' }
  const { width, height } = meta
  if (!width || !height || width < MIN_DIM || height < MIN_DIM) return { ok: false, error: 'That image is too small or unreadable.' }
  if (width > MAX_DIM || height > MAX_DIM) return { ok: false, error: 'That image’s dimensions are too large.' }
  return { ok: true }
}

/** Decode just the metadata via sharp. Returns null when the bytes cannot be decoded at all. */
export async function decodeImageMeta(bytes: Buffer): Promise<DecodedMeta | null> {
  try {
    const sharp = (await import('sharp')).default
    const m = await sharp(bytes).metadata()
    return { format: m.format ?? null, width: m.width ?? null, height: m.height ?? null }
  } catch {
    return null
  }
}
