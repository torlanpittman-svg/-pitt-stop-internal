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
