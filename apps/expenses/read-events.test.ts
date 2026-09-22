import { expect, it } from 'vitest'
import { readReceiptEvents } from './read-events'

it('delivers saved before read, decoding fragmented lines and UTF-8 safely', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const events = readReceiptEvents<{ type: string; vendor?: string }>(stream)
  controller.enqueue(new TextEncoder().encode('{"type":"saved"}\n'))
  expect((await events.next()).value).toEqual({ type: 'saved' })
  const bytes = new TextEncoder().encode('{"type":"read","vendor":"Café"}\n')
  for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
  controller.close()
  expect((await events.next()).value).toEqual({ type: 'read', vendor: 'Café' })
  expect((await events.next()).done).toBe(true)
})

it('surfaces a dropped connection after delivering the saved event', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const events = readReceiptEvents(stream)
  controller.enqueue(new TextEncoder().encode('{"type":"saved"}\n'))
  expect((await events.next()).value).toEqual({ type: 'saved' })
  controller.error(new Error('offline'))
  await expect(events.next()).rejects.toThrow('offline')
})
