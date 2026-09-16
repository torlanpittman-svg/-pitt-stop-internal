import { put, del, get } from '@vercel/blob'
import { logger } from '@/platform/logger'
import { sanitizeFilename } from '@/platform/image'

const MODULE = 'blob'

/**
 * Upload a photo for any app.
 * @param folder     - Storage folder, e.g. "vehicle-entry" or "estimator"
 * @param filename   - Original filename (sanitized before storage)
 * @param data       - File content
 * @param contentType - MIME type
 * @returns Permanent public CDN URL
 */
export async function uploadPhoto(
  folder: string,
  filename: string,
  data: Buffer | Blob | ArrayBuffer,
  contentType: string
): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not configured.\n' +
        'Run "vercel env pull .env.local" or add it to .env.local.'
    )
  }

  const key = `${folder}/${Date.now()}-${sanitizeFilename(filename)}`
  const blob = await put(key, data, { access: 'public', contentType })

  logger.info(MODULE, 'upload.success', { folder, url: blob.url })
  return blob.url
}

export async function deletePhoto(url: string): Promise<void> {
  await del(url)
  logger.info(MODULE, 'delete.success', { url })
}

/**
 * Upload a PRIVATE blob (not anonymously accessible via URL). Returns ONLY the store PATHNAME/key —
 * the server-side reference we persist. We never hand a reusable URL or token to the client; retrieval
 * happens through an authenticated server route that streams the bytes via {@link getPrivateBlob}.
 *
 * The key is content-hash-derived (deterministic) so identical bytes map to one object; `allowOverwrite`
 * makes a re-put of the same content idempotent. `addRandomSuffix:false` keeps the pathname stable so the
 * DB reference stays valid. (Guessability is irrelevant — private blobs require authentication regardless.)
 * @returns the blob pathname (store key), e.g. "business-receipts/ab12cd34ef56.jpg"
 */
export async function uploadPrivatePhoto(
  key: string,
  data: Buffer | Blob | ArrayBuffer,
  contentType: string
): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not configured.')
  }
  const blob = await put(key, data, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true })
  // Never log the pathname/URL/token/bytes — just a success marker.
  logger.info(MODULE, 'upload.private.success', { ok: true })
  return blob.pathname
}

export interface PrivateBlobBytes { bytes: Buffer; contentType: string | null; size: number | null }
/**
 * Fetch a PRIVATE blob's bytes by its stored pathname, server-side (uses BLOB_READ_WRITE_TOKEN, never
 * exposed to the client). Returns null when the object does not exist. Buffers the (small, ≤12 MB
 * receipt) stream so the caller can set headers and control Content-Disposition. Never logs contents.
 */
export async function getPrivateBlob(pathname: string): Promise<PrivateBlobBytes | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not configured.')
  }
  const res = await get(pathname, { access: 'private' })
  if (!res || res.statusCode !== 200 || !res.stream) return null
  const chunks: Uint8Array[] = []
  const reader = res.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return { bytes: Buffer.concat(chunks), contentType: res.blob.contentType, size: res.blob.size }
}
