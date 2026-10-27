import { and, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { serviceOrders } from '@/apps/workflow/schema'
import { orderPhotos } from './schema'
import type { OrderPhoto } from './types'

type Row = typeof orderPhotos.$inferSelect
export function photoView(row: Row): OrderPhoto {
  const imageUrl = `/api/workflow/orders/${row.serviceOrderId}/photos/${row.id}`
  return {
    id: row.id, filename: row.filename, caption: row.caption, included: row.included,
    resized: row.resized, createdAt: row.createdAt.toISOString(), imageUrl,
    downloadUrl: `${imageUrl}?download=1`,
  }
}

export async function photoOrderExists(id: string) {
  const [order] = await getDb().select({ id: serviceOrders.id }).from(serviceOrders).where(eq(serviceOrders.id, id)).limit(1)
  return !!order
}

export async function listOrderPhotos(orderId: string): Promise<OrderPhoto[]> {
  const rows = await getDb().select().from(orderPhotos)
    .where(and(eq(orderPhotos.serviceOrderId, orderId), isNull(orderPhotos.removedAt)))
    .orderBy(orderPhotos.createdAt, orderPhotos.id)
  return rows.map(photoView)
}

/** Metadata needed to prepare/attach the selected photos (active + included) for one order's estimate. */
export interface PhotoAttachmentMeta {
  id: string
  imageHash: string
  filename: string
  contentType: string
  byteSize: number
  caption: string
  storagePath: string
}

/**
 * The ordered set of photos a manager chose to include, scoped to a single order. Only active
 * (not removed) and `included` rows are returned, in the same stable order as the packet/printout
 * (createdAt, then id). This is the source manifest for QuickBooks estimate attachments — it never
 * returns storage credentials, only the private storage PATH used server-side to read the bytes.
 */
export async function listIncludedPhotoMeta(orderId: string): Promise<PhotoAttachmentMeta[]> {
  return getDb().select({
    id: orderPhotos.id, imageHash: orderPhotos.imageHash, filename: orderPhotos.filename,
    contentType: orderPhotos.contentType, byteSize: orderPhotos.byteSize,
    caption: orderPhotos.caption, storagePath: orderPhotos.storagePath,
  }).from(orderPhotos)
    .where(and(eq(orderPhotos.serviceOrderId, orderId), isNull(orderPhotos.removedAt), eq(orderPhotos.included, true)))
    .orderBy(orderPhotos.createdAt, orderPhotos.id)
}

export async function getOrderPhoto(orderId: string, photoId: string): Promise<Row | null> {
  const [row] = await getDb().select().from(orderPhotos)
    .where(and(eq(orderPhotos.serviceOrderId, orderId), eq(orderPhotos.id, photoId), isNull(orderPhotos.removedAt))).limit(1)
  return row ?? null
}

export async function saveOrderPhoto(input: Pick<Row, 'serviceOrderId' | 'storagePath' | 'imageHash' | 'filename' | 'contentType' | 'byteSize' | 'uploadedBy' | 'resized'>) {
  // Retry/duplicate uploads never reset a manager's captions or packet selection.
  // A previously removed photo is restored by explicitly uploading it again.
  const [row] = await getDb().insert(orderPhotos).values(input).onConflictDoUpdate({
    target: [orderPhotos.serviceOrderId, orderPhotos.imageHash],
    set: { removedAt: null, updatedAt: new Date(), storagePath: input.storagePath,
      included: sql`CASE WHEN ${orderPhotos.removedAt} IS NOT NULL THEN true ELSE ${orderPhotos.included} END` },
  }).returning()
  return photoView(row)
}

export async function updateOrderPhoto(orderId: string, photoId: string, change: { caption?: string; included?: boolean; removedAt?: Date }) {
  const [row] = await getDb().update(orderPhotos).set({ ...change, updatedAt: new Date() })
    .where(and(eq(orderPhotos.serviceOrderId, orderId), eq(orderPhotos.id, photoId), isNull(orderPhotos.removedAt))).returning()
  return row ? photoView(row) : null
}
