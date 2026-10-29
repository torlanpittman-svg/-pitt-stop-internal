/**
 * PartsTech-screenshot import — PRIVATE screenshot storage. Modeled on apps/order-photos/storage.ts: a
 * dedicated namespace (`part-imports/<orderId>/<sha256>.<ext>`), PRIVATE access only, immutable creation,
 * and a byte-verified reuse path for a retried/concurrent write. No public URL or token ever reaches the
 * client — retrieval is via an authenticated, manager-gated server route that streams the bytes. Never logs
 * bytes/tokens/URLs.
 */
import { createHash } from 'node:crypto'
import { get, put } from '@vercel/blob'

// Namespace-restricted: <orderId uuid>/<sha256>.<jpg|png|webp>.
const PATH = /^part-imports\/[a-f0-9-]{36}\/[a-f0-9]{64}\.(jpg|png|webp)$/
const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // bounded retrieval budget (well above a compressed screenshot)

function token(): string {
  // Reuse the existing PRIVATE store credential (never the public BLOB_READ_WRITE_TOKEN). A dedicated
  // PART_IMPORTS_* token may be set later; today it shares the private receipts store.
  const value = process.env.PART_IMPORTS_BLOB_READ_WRITE_TOKEN || process.env.RECEIPTS_BLOB_READ_WRITE_TOKEN
  if (!value) throw new Error('Private parts-import storage is not configured.')
  return value
}

export function importStorageKey(orderId: string, imageHash: string, ext: 'jpg' | 'png' | 'webp'): string {
  return `part-imports/${orderId}/${imageHash}.${ext}`
}

export async function readImportImageBytes(path: string): Promise<Buffer | null> {
  if (!PATH.test(path)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const result = await get(path, { access: 'private', token: token(), abortSignal: controller.signal })
    if (!result || result.statusCode !== 200 || !result.stream) return null
    if (typeof result.blob.size === 'number' && result.blob.size > MAX_IMAGE_BYTES) return null
    const reader = result.stream.getReader()
    try {
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return Buffer.concat(chunks)
        size += value.length
        if (size > MAX_IMAGE_BYTES) return null
        chunks.push(value)
      }
    } finally { await reader.cancel() }
  } finally { clearTimeout(timer) }
}

export async function storeImportImageBytes(path: string, bytes: Buffer, contentType: string): Promise<string> {
  if (!PATH.test(path) || bytes.length > MAX_IMAGE_BYTES) throw new Error('Invalid parts-import storage request.')
  try {
    const result = await put(path, bytes, {
      access: 'private', token: token(), contentType, addRandomSuffix: false, allowOverwrite: false,
    })
    return result.pathname
  } catch (error) {
    // Byte-verified reuse of a retried/concurrent identical write — existence alone is not trusted.
    const existing = await readImportImageBytes(path).catch(() => null)
    if (existing && existing.equals(bytes) && createHash('sha256').update(existing).digest('hex') === path.split('/').pop()?.split('.')[0]) return path
    throw error
  }
}
