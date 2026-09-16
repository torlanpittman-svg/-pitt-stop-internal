import { put, del, get, head } from '@vercel/blob'
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

// Private receipt storage uses a SEPARATE, explicitly-configured store credential — never the public
// BLOB_READ_WRITE_TOKEN (which backs the public Auto-Sales receipt store). This isolates private receipts
// to a private store and guarantees we never silently fall back to public storage.
function receiptsBlobToken(): string {
  const t = process.env.RECEIPTS_BLOB_READ_WRITE_TOKEN
  if (!t) throw new Error('RECEIPTS_BLOB_READ_WRITE_TOKEN is not configured (private receipt store).')
  return t
}

/**
 * Upload a PRIVATE receipt blob (not anonymously accessible). Returns ONLY the store PATHNAME/key — the
 * server-side reference we persist. No reusable URL or token ever reaches the client; retrieval is via an
 * authenticated server route that streams bytes with {@link getPrivateBlob}.
 *
 * IMMUTABLE creation: `allowOverwrite:false` + `addRandomSuffix:false` means the ORIGINAL bytes are never
 * overwritten. The key is content-hash-derived, so an object already at this exact pathname IS the same
 * bytes (a sha-256 collision is infeasible). On a write CONFLICT (a concurrent create, or a re-upload of
 * previously-stored bytes), we DETERMINISTICALLY confirm the object exists via head() (status-based, from
 * the SDK — not a brittle error-message match) and reuse its pathname; otherwise the original error was a
 * real failure and is rethrown. Uses the dedicated private-store token.
 * @returns the blob pathname (store key), e.g. "business-receipts/<sha256>.jpg"
 */
export async function uploadPrivatePhoto(
  key: string,
  data: Buffer | Blob | ArrayBuffer,
  contentType: string
): Promise<string> {
  const token = receiptsBlobToken()
  try {
    const blob = await put(key, data, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: false, token })
    logger.info(MODULE, 'upload.private.success', { ok: true }) // never log pathname/URL/token/bytes
    return blob.pathname
  } catch (err) {
    // Deterministic conflict handling: confirm the EXPECTED object already exists at this exact key.
    // head() throws BlobNotFoundError when absent, so a confirmed hit means the immutable content-addressed
    // object is present → safe to reuse. Any other head outcome → the original write error was real.
    try {
      const existing = await head(key, { token })
      if (existing && existing.pathname === key) {
        logger.info(MODULE, 'upload.private.reused', { ok: true })
        return key
      }
    } catch { /* not found / head error → fall through to rethrow the original write error */ }
    throw err
  }
}

export interface PrivateBlobBytes { bytes: Buffer; contentType: string | null; size: number | null }
/**
 * Fetch a PRIVATE receipt blob's bytes by its stored pathname, server-side (dedicated private-store
 * token; never exposed to the client). The pathname is RESTRICTED to the receipt namespace as a
 * defense-in-depth guard against a stray/foreign reference. Returns null when missing. Never logs contents.
 */
export async function getPrivateBlob(pathname: string): Promise<PrivateBlobBytes | null> {
  const token = receiptsBlobToken()
  if (!pathname || !pathname.startsWith('business-receipts/')) return null // namespace-restricted
  const res = await get(pathname, { access: 'private', token })
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
