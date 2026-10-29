/**
 * PartsTech-screenshot import — server-side image decode (FAIL-CLOSED). Magic bytes prove the header and
 * sharp.metadata proves the declared dimensions, but neither forces a full raster decode. Here we actually
 * DECODE every pixel (with a hard pixel ceiling) so a decompression-bomb / truncated / corrupt file is
 * rejected BEFORE it is ever stored, and the derived AI image keeps its ACTUAL format — never mislabeled.
 */
export const MAX_IMPORT_PIXELS = 40_000_000 // 40 MP ceiling (well above any real phone screenshot)

/** True only if the bytes decode fully as a real raster within the pixel ceiling. No fallback — on any
 *  failure it returns false so a corrupt/oversized image is rejected before storage. */
export async function assertDecodable(bytes: Buffer): Promise<boolean> {
  try {
    const sharp = (await import('sharp')).default
    // .stats() reads the whole raster (forces a full decode), so a bomb/corruption throws here.
    await sharp(bytes, { limitInputPixels: MAX_IMPORT_PIXELS }).stats()
    return true
  } catch {
    return false
  }
}

/**
 * Produce a downscaled JPEG for the AI call ONLY (never stored, never hashed). FAIL-CLOSED: returns null if
 * the image cannot be decoded (so the read treats that screenshot as unreadable — recoverable), instead of
 * forwarding mislabeled original bytes. Screenshots stay legible at 2000px for small part-number text.
 */
export async function deriveForAi(bytes: Buffer): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const sharp = (await import('sharp')).default
    const out = await sharp(bytes, { limitInputPixels: MAX_IMPORT_PIXELS })
      .rotate()
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer()
    return { bytes: out, contentType: 'image/jpeg' }
  } catch {
    return null
  }
}
