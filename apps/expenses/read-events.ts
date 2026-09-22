/** Decode newline-delimited receipt events even when the network splits a line or UTF-8 character. */
export async function* readReceiptEvents<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (line) yield JSON.parse(line) as T
      }
      if (done) {
        if (pending.trim()) yield JSON.parse(pending) as T
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
