import { getDb } from '@/platform/db'
import { estimates, estimatePhotos, estimateLineItems, retailCustomers } from './schema'
import { eq, desc } from 'drizzle-orm'

export type EstimateRow = typeof estimates.$inferSelect
export type EstimatePhotoRow = typeof estimatePhotos.$inferSelect
export type EstimateLineItemRow = typeof estimateLineItems.$inferSelect
export type RetailCustomerRow = typeof retailCustomers.$inferSelect

export type EstimateWithDetails = EstimateRow & {
  photos: EstimatePhotoRow[]
  lineItems: EstimateLineItemRow[]
}

export async function createCustomer(data: {
  name: string
  phone: string | null
}): Promise<RetailCustomerRow> {
  const db = getDb()
  const [row] = await db.insert(retailCustomers).values(data).returning()
  return row
}

export async function createEstimate(data: {
  customerId: string
  customerName: string
  customerPhone: string | null
  serviceFocus: string | null
}): Promise<EstimateRow> {
  const db = getDb()
  const [row] = await db.insert(estimates).values(data).returning()
  return row
}

export async function getEstimate(id: string): Promise<EstimateRow | null> {
  const db = getDb()
  const rows = await db.select().from(estimates).where(eq(estimates.id, id)).limit(1)
  return rows[0] ?? null
}

export async function getEstimateWithDetails(id: string): Promise<EstimateWithDetails | null> {
  const db = getDb()
  const est = await getEstimate(id)
  if (!est) return null

  const [photos, lineItems] = await Promise.all([
    db.select().from(estimatePhotos).where(eq(estimatePhotos.estimateId, id)),
    db.select().from(estimateLineItems).where(eq(estimateLineItems.estimateId, id)),
  ])

  return { ...est, photos, lineItems }
}

export async function updateEstimate(
  id: string,
  data: Partial<typeof estimates.$inferInsert>
): Promise<EstimateRow> {
  const db = getDb()
  const [row] = await db
    .update(estimates)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(estimates.id, id))
    .returning()
  return row
}

export async function createEstimatePhoto(data: {
  estimateId: string
  photoUrl: string
  role: string
  captureOrder: number
}): Promise<EstimatePhotoRow> {
  const db = getDb()
  const [row] = await db.insert(estimatePhotos).values(data).returning()
  return row
}

export async function createEstimateLineItem(
  data: Partial<typeof estimateLineItems.$inferInsert> & {
    estimateId: string
    displayOrder: number
  }
): Promise<EstimateLineItemRow> {
  const db = getDb()
  const [row] = await db.insert(estimateLineItems).values(data).returning()
  return row
}

export async function listEstimates(limit = 50): Promise<EstimateRow[]> {
  const db = getDb()
  return db.select().from(estimates).orderBy(desc(estimates.createdAt)).limit(limit)
}

function pad(n: number, width: number) {
  return String(n).padStart(width, '0')
}

export function generateEstimateNumber(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = pad(now.getMonth() + 1, 2)
  const d = pad(now.getDate(), 2)
  const rand = pad(Math.floor(Math.random() * 9000) + 1000, 4)
  return `EST-${y}${m}${d}-${rand}`
}
