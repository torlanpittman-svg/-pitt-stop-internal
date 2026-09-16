/**
 * Shared image utilities for all modules.
 * Client-side compression lives in each module's capture component
 * (browser-image-compression runs in the browser, not here).
 * This file handles server-side image pipeline helpers.
 */

export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024 // 1.5 MB

export const ACCEPTED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number]

export function isAcceptedMimeType(mimeType: string): mimeType is AcceptedMimeType {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(mimeType)
}

/** Convert a Buffer to a base64 string (no data: prefix). */
export function bufferToBase64(buffer: Buffer): string {
  return buffer.toString('base64')
}

/** Strip the `data:<mime>;base64,` prefix from a data URL. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const commaIdx = dataUrl.indexOf(',')
  return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl
}

/** Extract the MIME type from a data URL. Returns 'image/jpeg' as fallback. */
export function mimeTypeFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:([^;,]+)/)
  return match?.[1] ?? 'image/jpeg'
}

/** Generate a safe filename for storage. */
export function sanitizeFilename(original: string): string {
  return original.replace(/[^a-z0-9.\-_]/gi, '_').toLowerCase()
}

/**
 * Detect a raster image type from the file's MAGIC BYTES (not its extension or client-declared MIME).
 * Returns the canonical MIME for the formats our vision-extraction path can safely process
 * (JPEG / PNG / WEBP), or null for anything else — including SVG, HTML, scripts and PDFs, which must
 * never be trusted from a declared content-type alone. Pure + deterministic (unit-testable).
 */
export function detectImageMime(buf: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png'
  // WEBP: "RIFF" .... "WEBP"
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return null
}
