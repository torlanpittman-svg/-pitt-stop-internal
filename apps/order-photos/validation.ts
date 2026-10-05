import sharp from 'sharp'
import { detectImageMime, sanitizeFilename } from '@/platform/image'
import { MAX_PHOTO_BYTES } from './types'

export async function validatePhoto(file: File) {
  if (!file.size) return { ok: false as const, status: 400, error: 'Choose a photo first.' }
  if (file.size > MAX_PHOTO_BYTES) return { ok: false as const, status: 413, error: 'This photo is too large. Choose a smaller copy (under 4 MB).' }
  const bytes = Buffer.from(await file.arrayBuffer())
  const contentType = detectImageMime(bytes)
  const declared = file.type.toLowerCase().split(';')[0].replace('image/jpg', 'image/jpeg')
  if (!contentType || (declared && declared !== 'application/octet-stream' && declared !== contentType)) return { ok: false as const, status: 415, error: 'Choose a JPEG, PNG or WebP photo. Export HEIC photos as JPEG first.' }
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' })
    const meta = await image.metadata()
    if (!meta.width || !meta.height || (meta.pages ?? 1) > 1) throw new Error('Invalid image')
    await image.stats() // Full decode catches corrupt/truncated images; stored bytes stay untouched.
  } catch {
    return { ok: false as const, status: 415, error: 'This photo could not be read. Choose a different or smaller photo.' }
  }
  const extension = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/png' ? 'png' : 'webp'
  const stem = sanitizeFilename(file.name.replace(/\.[^.]*$/, '')).slice(0, 120) || 'vehicle-photo'
  return { ok: true as const, bytes, contentType, extension, filename: `${stem}.${extension}` }
}
