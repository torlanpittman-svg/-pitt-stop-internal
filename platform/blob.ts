import { put, del } from '@vercel/blob'
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
