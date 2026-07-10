import { eq, desc } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { demoStore } from '@/platform/demo-store'
import { vehicleEntries } from '@/apps/vehicle-entry/schema'
import type { VehicleEntryStatus } from './types'

const COLLECTION = 'vehicle_entries'

function isDemoMode(): boolean {
  return !process.env.DATABASE_URL
}

// Row shape used by both demo store and real DB
export type VehicleEntryRow = {
  id: string
  createdAt: Date
  updatedAt: Date
  photoUrl: string
  year: string | null
  make: string | null
  model: string | null
  color: string | null
  customColor: string | null
  stockNumber: string | null
  ocrConfidence: Record<string, number> | null
  rawOcrResponse: unknown
  wasCorrected: boolean
  status: string
  quickbooksInvoiceId: string | null
}

type NewEntry = {
  photoUrl: string
  year?: string | null
  make?: string | null
  model?: string | null
  color?: string | null
  customColor?: string | null
  stockNumber?: string | null
  ocrConfidence?: Record<string, number> | null
  rawOcrResponse?: unknown
}

type EntryUpdate = {
  year?: string | null
  make?: string | null
  model?: string | null
  color?: string | null
  customColor?: string | null
  stockNumber?: string | null
  wasCorrected?: boolean
  status?: VehicleEntryStatus
  quickbooksInvoiceId?: string | null
}

export async function createVehicleEntry(data: NewEntry): Promise<string> {
  if (isDemoMode()) {
    const id = crypto.randomUUID()
    demoStore.insert<VehicleEntryRow>(COLLECTION, {
      id,
      createdAt:          new Date(),
      updatedAt:          new Date(),
      photoUrl:           data.photoUrl,
      year:               data.year            ?? null,
      make:               data.make            ?? null,
      model:              data.model           ?? null,
      color:              data.color           ?? null,
      customColor:        data.customColor     ?? null,
      stockNumber:        data.stockNumber     ?? null,
      ocrConfidence:      data.ocrConfidence   ?? null,
      rawOcrResponse:     data.rawOcrResponse  ?? null,
      wasCorrected:       false,
      status:             'ready_for_quickbooks',
      quickbooksInvoiceId: null,
    })
    return id
  }

  const db = getDb()
  const [row] = await db
    .insert(vehicleEntries)
    .values({
      photoUrl:        data.photoUrl,
      year:            data.year            ?? null,
      make:            data.make            ?? null,
      model:           data.model           ?? null,
      color:           data.color           ?? null,
      customColor:     data.customColor     ?? null,
      stockNumber:     data.stockNumber     ?? null,
      ocrConfidence:   data.ocrConfidence   ?? null,
      rawOcrResponse:  data.rawOcrResponse  ?? null,
    })
    .returning({ id: vehicleEntries.id })
  return row.id
}

export async function getVehicleEntry(id: string): Promise<VehicleEntryRow | null> {
  if (isDemoMode()) {
    return demoStore.get<VehicleEntryRow>(COLLECTION, id)
  }

  const db = getDb()
  const [row] = await db
    .select()
    .from(vehicleEntries)
    .where(eq(vehicleEntries.id, id))
    .limit(1)
  return (row as VehicleEntryRow) ?? null
}

export async function listVehicleEntries(limit = 100): Promise<VehicleEntryRow[]> {
  if (isDemoMode()) {
    return demoStore
      .list<VehicleEntryRow>(COLLECTION)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit)
  }

  const db = getDb()
  return (await db
    .select()
    .from(vehicleEntries)
    .orderBy(desc(vehicleEntries.createdAt))
    .limit(limit)) as VehicleEntryRow[]
}

export async function updateVehicleEntry(
  id: string,
  data: EntryUpdate
): Promise<VehicleEntryRow | null> {
  if (isDemoMode()) {
    return demoStore.update<VehicleEntryRow>(COLLECTION, id, {
      ...data,
      updatedAt: new Date(),
    })
  }

  const db = getDb()
  const [row] = await db
    .update(vehicleEntries)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(vehicleEntries.id, id))
    .returning()
  return (row as VehicleEntryRow) ?? null
}
