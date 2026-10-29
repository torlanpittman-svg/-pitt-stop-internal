/**
 * Shared bounded request-body reader for the parts-import routes. Reads the body stream with a HARD byte cap
 * (independent of any absent/forged Content-Length), cancelling the stream the moment the cap is exceeded, so
 * neither the multipart upload nor the JSON mutation body can be buffered unbounded. Not a route handler
 * (underscore prefix) and intentionally kept OUT of `_gate` so route tests that mock `_gate` still exercise
 * the real reader.
 */

/** Read the whole body into a Buffer, or throw RangeError once `cap` bytes are exceeded. Returns null when
 *  the runtime exposes no body stream (callers fall back to the framework parser). */
export async function readBoundedBody(req: Request, cap: number): Promise<Buffer | null> {
  const reader = req.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > cap) { await reader.cancel().catch(() => {}); throw new RangeError('body too large') }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks)
}
