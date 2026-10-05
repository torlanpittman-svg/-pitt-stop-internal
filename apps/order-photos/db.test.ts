import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { getOrderPhoto, listOrderPhotos, photoOrderExists, saveOrderPhoto, updateOrderPhoto } from './db'

const pg = new PGlite()
const orderId = randomUUID()
const otherId = randomUUID()
beforeAll(async () => {
  await pg.exec('CREATE TABLE service_orders (id uuid PRIMARY KEY, status text);')
  const migration = readFileSync('drizzle/migrations/manual/0045_order_photos.sql', 'utf8')
  await pg.exec(migration)
  await pg.exec(migration) // Re-running the deployment migration is safe.
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec('DELETE FROM order_photos; DELETE FROM service_orders;')
  await pg.query('INSERT INTO service_orders VALUES ($1, $3), ($2, $3)', [orderId, otherId, 'estimate'])
})
const input = () => ({ serviceOrderId: orderId, storagePath: 'order-photos/private.jpg', imageHash: 'abc',
  filename: 'door.jpg', contentType: 'image/jpeg', byteSize: 100, uploadedBy: 'Manager', resized: false })

describe('vehicle photo persistence', () => {
  it('keeps photos, notes, and selection through estimate → job → invoice lifecycle', async () => {
    const photo = await saveOrderPhoto(input())
    await updateOrderPhoto(orderId, photo.id, { caption: 'Driver door before repair', included: false })
    for (const status of ['arrived', 'ready', 'delivered']) {
      await pg.query('UPDATE service_orders SET status=$1 WHERE id=$2', [status, orderId])
      expect(await listOrderPhotos(orderId)).toEqual([expect.objectContaining({ id: photo.id, caption: 'Driver door before repair', included: false })])
    }
  })
  it('deduplicates retries without overwriting notes or selection', async () => {
    const photo = await saveOrderPhoto(input())
    await updateOrderPhoto(orderId, photo.id, { caption: 'Existing note', included: false })
    const retry = await saveOrderPhoto(input())
    expect(retry).toMatchObject({ id: photo.id, caption: 'Existing note', included: false })
    expect(await listOrderPhotos(orderId)).toHaveLength(1)
  })
  it('does not disclose storage references, hashes, or uploader identity in the UI response', async () => {
    const photo = await saveOrderPhoto(input())
    expect(photo.imageUrl).toBe(`/api/workflow/orders/${orderId}/photos/${photo.id}`)
    expect(photo).not.toHaveProperty('storagePath')
    expect(photo).not.toHaveProperty('imageHash')
    expect(photo).not.toHaveProperty('uploadedBy')
  })
  it('scopes reads, edits and removal to the parent order', async () => {
    const photo = await saveOrderPhoto(input())
    expect(await getOrderPhoto(otherId, photo.id)).toBeNull()
    expect(await updateOrderPhoto(otherId, photo.id, { caption: 'Wrong vehicle' })).toBeNull()
    expect(await updateOrderPhoto(otherId, photo.id, { removedAt: new Date() })).toBeNull()
    expect(await listOrderPhotos(otherId)).toEqual([])
    expect(await getOrderPhoto(orderId, photo.id)).not.toBeNull()
  })
  it('hides removed photos and restores the same record on an explicit re-upload', async () => {
    const photo = await saveOrderPhoto(input())
    await updateOrderPhoto(orderId, photo.id, { caption: 'Before', included: false })
    await updateOrderPhoto(orderId, photo.id, { removedAt: new Date() })
    expect(await listOrderPhotos(orderId)).toEqual([])
    expect(await getOrderPhoto(orderId, photo.id)).toBeNull()
    expect(await saveOrderPhoto(input())).toMatchObject({ id: photo.id, caption: 'Before', included: true })
  })
  it('allows the same image on separate orders without linking their notes', async () => {
    await saveOrderPhoto(input())
    const other = await saveOrderPhoto({ ...input(), serviceOrderId: otherId })
    await updateOrderPhoto(otherId, other.id, { caption: 'Separate record' })
    expect((await listOrderPhotos(orderId))[0].caption).toBe('')
    expect((await listOrderPhotos(otherId))[0].caption).toBe('Separate record')
  })
  it('rejects orphan photos and detects missing orders', async () => {
    const missing = randomUUID()
    expect(await photoOrderExists(missing)).toBe(false)
    expect(await photoOrderExists(orderId)).toBe(true)
    await expect(saveOrderPhoto({ ...input(), serviceOrderId: missing })).rejects.toThrow()
  })
})
