/**
 * AES-256-GCM encryption for QuickBooks OAuth tokens at rest.
 *
 * Key comes from QUICKBOOKS_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 * Payload format:  v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * Requires the Node.js runtime (node:crypto). Routes that call this must set
 * `export const runtime = 'nodejs'`.
 */
import crypto from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // 96-bit nonce, recommended for GCM
const VERSION = 'v1'

function getKey(): Buffer {
  const hex = process.env.QUICKBOOKS_ENCRYPTION_KEY
  if (!hex) {
    throw new Error('QUICKBOOKS_ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  }
  const key = Buffer.from(hex.trim(), 'hex')
  if (key.length !== 32) {
    throw new Error(`QUICKBOOKS_ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${key.length} bytes`)
  }
  return key
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

export function decrypt(payload: string): string {
  const key = getKey()
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Invalid encrypted payload format')
  }
  const iv = Buffer.from(parts[1], 'base64')
  const authTag = Buffer.from(parts[2], 'base64')
  const ciphertext = Buffer.from(parts[3], 'base64')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** True if the encryption key is present and correctly sized. */
export function encryptionKeyValid(): boolean {
  try {
    getKey()
    return true
  } catch {
    return false
  }
}
