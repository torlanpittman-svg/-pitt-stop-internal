import { createHash } from 'node:crypto'
import { get, put } from '@vercel/blob'
import { MAX_PHOTO_BYTES } from './types'

const PATH = /^order-photos\/[a-f0-9-]{36}\/[a-f0-9]{64}\.(jpg|png|webp)$/
function token() {
  // Private only. The existing private store can be reused under a separate namespace.
  const value = process.env.ORDER_PHOTOS_BLOB_READ_WRITE_TOKEN || process.env.RECEIPTS_BLOB_READ_WRITE_TOKEN
  if (!value) throw new Error('Private photo storage is not configured.')
  return value
}

export async function readPhotoBytes(path: string): Promise<Buffer | null> {
  if (!PATH.test(path)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const result = await get(path, { access: 'private', token: token(), abortSignal: controller.signal })
    if (!result || result.statusCode !== 200 || !result.stream) return null
    const reader = result.stream.getReader()
    try {
      if (result.blob.size > MAX_PHOTO_BYTES) return null
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return Buffer.concat(chunks)
        size += value.length
        if (size > MAX_PHOTO_BYTES) return null
        chunks.push(value)
      }
    } finally { await reader.cancel() }
  } finally { clearTimeout(timer) }
}

export async function storePhotoBytes(path: string, bytes: Buffer, contentType: string) {
  if (!PATH.test(path) || bytes.length > MAX_PHOTO_BYTES) throw new Error('Invalid photo storage request.')
  try {
    const result = await put(path, bytes, {
      access: 'private', token: token(), contentType, addRandomSuffix: false, allowOverwrite: false,
    })
    return result.pathname
  } catch (error) {
    // Recover duplicate/retried writes only after checking the actual stored bytes.
    const existing = await readPhotoBytes(path).catch(() => null)
    if (existing && existing.equals(bytes) && createHash('sha256').update(existing).digest('hex') === path.split('/').pop()?.split('.')[0]) return path
    throw error
  }
}
