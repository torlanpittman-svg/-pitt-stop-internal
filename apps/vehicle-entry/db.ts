import { eq, desc } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { demoStore } from '@/platform/demo-store'
import { vehicleEntries, dealerships } from '@/apps/vehicle-entry/schema'
import type { VehicleEntryStatus } from './types'
export type { VehicleEntryStatus }

const COLLECTION     = 'vehicle_entries'
const DEALER_COL     = 'dealerships'

function isDemoMode(): boolean {
  return !process.env.DATABASE_URL
}

// ── Dealership ─────────────────────────────────────────────────────────────

export type DealershipRow = {
  id:          string
  name:        string
  stockPrefix: string
  active:      boolean
  createdAt:   Date
}

const DEMO_DEALERSHIPS: DealershipRow[] = [
  { id: 'demo-1', name: 'Source S',  stockPrefix: 'S',  active: true, createdAt: new Date() },
  { id: 'demo-2', name: 'Source U',  stockPrefix: 'U',  active: true, createdAt: new Date() },
  { id: 'demo-3', name: 'Source K',  stockPrefix: 'K',  active: true, createdAt: new Date() },
  { id: 'demo-4', name: 'Source TZ', stockPrefix: 'TZ', active: true, createdAt: new Date() },
]

export async function listDealerships(activeOnly = false): Promise<DealershipRow[]> {
  if (isDemoMode()) {
    const rows = demoStore.list<DealershipRow>(DEALER_COL)
    const all  = rows.length > 0 ? rows : DEMO_DEALERSHIPS
    return activeOnly ? all.filter(d => d.active) : all
  }
  const db  = getDb()
  const all = await db.select().from(dealerships).orderBy(dealerships.name)
  return (activeOnly ? all.filter(d => d.active) : all) as DealershipRow[]
}

export async function getDealership(id: string): Promise<DealershipRow | null> {
  if (isDemoMode()) {
    return demoStore.get<DealershipRow>(DEALER_COL, id) ?? DEMO_DEALERSHIPS.find(d => d.id === id) ?? null
  }
  const db = getDb()
  const [row] = await db.select().from(dealerships).where(eq(dealerships.id, id)).limit(1)
  return (row as DealershipRow) ?? null
}

export async function createDealership(data: { name: string; stockPrefix: string }): Promise<string> {
  if (isDemoMode()) {
    const id = crypto.randomUUID()
    demoStore.insert<DealershipRow>(DEALER_COL, { id, ...data, active: true, createdAt: new Date() })
    return id
  }
  const db    = getDb()
  const [row] = await db.insert(dealerships).values(data).returning({ id: dealerships.id })
  return row.id
}

export async function updateDealership(
  id: string,
  data: Partial<{ name: string; stockPrefix: string; active: boolean }>
): Promise<DealershipRow | null> {
  if (isDemoMode()) {
    return demoStore.update<DealershipRow>(DEALER_COL, id, data)
  }
  const db    = getDb()
  const [row] = await db.update(dealerships).set(data).where(eq(dealerships.id, id)).returning()
  return (row as DealershipRow) ?? null
}

export async function deleteDealership(id: string): Promise<void> {
  if (isDemoMode()) {
    demoStore.update<DealershipRow>(DEALER_COL, id, { active: false })
    return
  }
  const db = getDb()
  await db.delete(dealerships).where(eq(dealerships.id, id))
}

// ── Vehicle Entry ──────────────────────────────────────────────────────────

export type VehicleEntryRow = {
  id: string
  createdAt: Date
  updatedAt: Date
  photoUrl: string
  originalPhotoUrl: string | null
  year: string | null
  make: string | null
  model: string | null
  color: string | null
  customColor: string | null
  stockNumber: string | null
  stockNumberCropUrl: string | null
  stockNumberAiPrediction: string | null
  stockDebugOverlayUrl: string | null
  stockDebugData: Record<string, unknown> | null
  ocrConfidence: Record<string, number> | null
  rawOcrResponse: unknown
  vin: string | null
  entryMethod: string
  dealershipId: string | null
  dealershipName: string | null
  // Invoice sync
  invoiceBatchId:    string | null
  quickbooksLineId:  string | null
  invoiceSyncStatus: string | null
  invoiceSyncedAt:   Date | null
  invoiceSyncError:  string | null
  wasCorrected: boolean
  status: string
  quickbooksInvoiceId: string | null
  // Pilot timing
  photoTakenAt:        Date | null
  ocrCompletedAt:      Date | null
  employeeConfirmedAt: Date | null
  isPilotEntry:        boolean
}

type NewEntry = {
  photoUrl: string
  originalPhotoUrl?: string | null
  year?: string | null
  make?: string | null
  model?: string | null
  color?: string | null
  customColor?: string | null
  stockNumber?: string | null
  stockNumberCropUrl?: string | null
  stockNumberAiPrediction?: string | null
  stockDebugOverlayUrl?: string | null
  stockDebugData?: Record<string, unknown> | null
  ocrConfidence?: Record<string, number> | null
  rawOcrResponse?: unknown
  vin?: string | null
  entryMethod?: string
  dealershipId?: string | null
  dealershipName?: string | null
  photoTakenAt?: Date | null
  ocrCompletedAt?: Date | null
  isPilotEntry?: boolean
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
  // Invoice sync fields
  invoiceBatchId?:    string | null
  quickbooksLineId?:  string | null
  invoiceSyncStatus?: string | null
  invoiceSyncedAt?:   Date | null
  invoiceSyncError?:  string | null
  // Pilot timing
  employeeConfirmedAt?: Date | null
}

export async function createVehicleEntry(data: NewEntry): Promise<string> {
  if (isDemoMode()) {
    const id = crypto.randomUUID()
    demoStore.insert<VehicleEntryRow>(COLLECTION, {
      id,
      createdAt:               new Date(),
      updatedAt:               new Date(),
      photoUrl:                data.photoUrl,
      originalPhotoUrl:        data.originalPhotoUrl        ?? null,
      year:                    data.year                    ?? null,
      make:                    data.make                    ?? null,
      model:                   data.model                   ?? null,
      color:                   data.color                   ?? null,
      customColor:             data.customColor             ?? null,
      stockNumber:             data.stockNumber             ?? null,
      stockNumberCropUrl:      data.stockNumberCropUrl      ?? null,
      stockNumberAiPrediction: data.stockNumberAiPrediction ?? null,
      stockDebugOverlayUrl:    data.stockDebugOverlayUrl    ?? null,
      stockDebugData:          data.stockDebugData          ?? null,
      ocrConfidence:           data.ocrConfidence           ?? null,
      rawOcrResponse:          data.rawOcrResponse          ?? null,
      vin:                     data.vin                     ?? null,
      entryMethod:             data.entryMethod             ?? 'key-tag',
      dealershipId:            data.dealershipId            ?? null,
      dealershipName:          data.dealershipName          ?? null,
      invoiceBatchId:          null,
      quickbooksLineId:        null,
      invoiceSyncStatus:       null,
      invoiceSyncedAt:         null,
      invoiceSyncError:        null,
      wasCorrected:            false,
      status:                  'ready_for_quickbooks',
      quickbooksInvoiceId:     null,
      photoTakenAt:            data.photoTakenAt            ?? null,
      ocrCompletedAt:          data.ocrCompletedAt          ?? null,
      employeeConfirmedAt:     null,
      isPilotEntry:            data.isPilotEntry             ?? false,
    })
    return id
  }

  const db = getDb()
  const [row] = await db
    .insert(vehicleEntries)
    .values({
      photoUrl:                data.photoUrl,
      originalPhotoUrl:        data.originalPhotoUrl        ?? null,
      year:                    data.year                    ?? null,
      make:                    data.make                    ?? null,
      model:                   data.model                   ?? null,
      color:                   data.color                   ?? null,
      customColor:             data.customColor             ?? null,
      stockNumber:             data.stockNumber             ?? null,
      stockNumberCropUrl:      data.stockNumberCropUrl      ?? null,
      stockNumberAiPrediction: data.stockNumberAiPrediction ?? null,
      stockDebugOverlayUrl:    data.stockDebugOverlayUrl    ?? null,
      stockDebugData:          data.stockDebugData          ?? null,
      ocrConfidence:           data.ocrConfidence           ?? null,
      rawOcrResponse:          data.rawOcrResponse          ?? null,
      vin:                     data.vin                     ?? null,
      entryMethod:             data.entryMethod             ?? 'key-tag',
      dealershipId:            data.dealershipId            ?? null,
      dealershipName:          data.dealershipName          ?? null,
      photoTakenAt:            data.photoTakenAt            ?? null,
      ocrCompletedAt:          data.ocrCompletedAt          ?? null,
      isPilotEntry:            data.isPilotEntry             ?? false,
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

// Lightweight row type for pilot stats — excludes large JSONB blobs (rawOcrResponse, stockDebugData, etc.)
export type PilotEntryRow = {
  id:                      string
  createdAt:               Date
  wasCorrected:            boolean
  year:                    string | null
  make:                    string | null
  model:                   string | null
  color:                   string | null
  stockNumber:             string | null
  stockNumberAiPrediction: string | null
  entryMethod:             string
  dealershipId:            string | null
  dealershipName:          string | null
  invoiceSyncStatus:       string | null
  invoiceSyncError:        string | null
  invoiceBatchId:          string | null
  photoTakenAt:            Date | null
  ocrCompletedAt:          Date | null
  employeeConfirmedAt:     Date | null
  isPilotEntry:            boolean
}

export async function listPilotEntries(limit = 500): Promise<PilotEntryRow[]> {
  if (isDemoMode()) {
    return demoStore
      .list<VehicleEntryRow>(COLLECTION)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit)
      .map(e => ({
        id: e.id, createdAt: e.createdAt, wasCorrected: e.wasCorrected,
        year: e.year, make: e.make, model: e.model, color: e.color,
        stockNumber: e.stockNumber, stockNumberAiPrediction: e.stockNumberAiPrediction,
        entryMethod: e.entryMethod, dealershipId: e.dealershipId, dealershipName: e.dealershipName,
        invoiceSyncStatus: e.invoiceSyncStatus, invoiceSyncError: e.invoiceSyncError,
        invoiceBatchId: e.invoiceBatchId, photoTakenAt: e.photoTakenAt,
        ocrCompletedAt: e.ocrCompletedAt, employeeConfirmedAt: e.employeeConfirmedAt,
        isPilotEntry: e.isPilotEntry,
      }))
  }

  const db = getDb()
  return (await db
    .select({
      id:                      vehicleEntries.id,
      createdAt:               vehicleEntries.createdAt,
      wasCorrected:            vehicleEntries.wasCorrected,
      year:                    vehicleEntries.year,
      make:                    vehicleEntries.make,
      model:                   vehicleEntries.model,
      color:                   vehicleEntries.color,
      stockNumber:             vehicleEntries.stockNumber,
      stockNumberAiPrediction: vehicleEntries.stockNumberAiPrediction,
      entryMethod:             vehicleEntries.entryMethod,
      dealershipId:            vehicleEntries.dealershipId,
      dealershipName:          vehicleEntries.dealershipName,
      invoiceSyncStatus:       vehicleEntries.invoiceSyncStatus,
      invoiceSyncError:        vehicleEntries.invoiceSyncError,
      invoiceBatchId:          vehicleEntries.invoiceBatchId,
      photoTakenAt:            vehicleEntries.photoTakenAt,
      ocrCompletedAt:          vehicleEntries.ocrCompletedAt,
      employeeConfirmedAt:     vehicleEntries.employeeConfirmedAt,
      isPilotEntry:            vehicleEntries.isPilotEntry,
    })
    .from(vehicleEntries)
    .orderBy(desc(vehicleEntries.createdAt))
    .limit(limit)) as PilotEntryRow[]
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
