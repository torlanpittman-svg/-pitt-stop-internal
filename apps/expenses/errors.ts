/**
 * Business Receipts — error sanitization. Raw SDK/DB/network errors can carry SQL text, bound
 * parameters (receipt amounts/vendors), storage pathnames, or credentials. NEVER log or return the raw
 * error. `errorCode()` maps any thrown value to a small, stable, non-sensitive code for logs; client
 * responses use fixed friendly messages elsewhere. Pure + deterministic.
 */
export type ReceiptErrorCode =
  | 'blob_config' | 'blob_io' | 'db_unique' | 'db_io' | 'ai_io' | 'decode' | 'network' | 'unknown'

export function errorCode(err: unknown): ReceiptErrorCode {
  const code = (err as { code?: unknown })?.code
  const name = (err as { name?: unknown })?.name
  const msg = String((err as { message?: unknown })?.message ?? err ?? '')
  if (code === '23505' || /duplicate key value|unique constraint/i.test(msg)) return 'db_unique'
  if (/BLOB_READ_WRITE_TOKEN|RECEIPTS_BLOB|not configured/i.test(msg)) return 'blob_config'
  if (name === 'BlobError' || /vercel-storage|blob/i.test(msg)) return 'blob_io'
  if (/openai|gpt-4o|rate limit|insufficient_quota/i.test(msg)) return 'ai_io'
  if (/sharp|decode|unsupported image|Input buffer/i.test(msg)) return 'decode'
  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) return 'network'
  if (/(neon|postgres|database|relation|column|syntax)/i.test(msg)) return 'db_io'
  return 'unknown'
}
