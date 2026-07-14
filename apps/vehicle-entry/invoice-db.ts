import { eq, and, ne, count } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { demoStore } from '@/platform/demo-store'
import { invoiceBatches, mockQbInvoices, vehicleEntries } from '@/apps/vehicle-entry/schema'
import type { QBLine } from './qb/types'

const BATCH_COL  = 'invoice_batches'
const MOCK_QB_COL = 'mock_qb_invoices'

function isDemoMode() { return !process.env.DATABASE_URL }

// ── Invoice Batches ─────────────────────────────────────────────────────────

export type PittStopBatchStatus = 'draft' | 'active' | 'finalized' | 'closed' | 'cancelled'

export type InvoiceBatchRow = {
  id:                      string
  dealershipId:            string
  dealershipName:          string
  quickbooksCustomerId:    string | null
  quickbooksInvoiceId:     string | null
  quickbooksInvoiceNumber: string | null
  pittStopStatus:          PittStopBatchStatus
  batchStartDate:          Date
  finalizedDate:           Date | null
  closedDate:              Date | null
  createdAt:               Date
  updatedAt:               Date
}

export async function listInvoiceBatches(): Promise<InvoiceBatchRow[]> {
  if (isDemoMode()) return demoStore.list<InvoiceBatchRow>(BATCH_COL)
  const db = getDb()
  return (await db.select().from(invoiceBatches).orderBy(invoiceBatches.createdAt)) as InvoiceBatchRow[]
}

export async function getInvoiceBatch(id: string): Promise<InvoiceBatchRow | null> {
  if (isDemoMode()) return demoStore.get<InvoiceBatchRow>(BATCH_COL, id)
  const db = getDb()
  const [row] = await db.select().from(invoiceBatches).where(eq(invoiceBatches.id, id)).limit(1)
  return (row as InvoiceBatchRow) ?? null
}

export async function getActiveBatchForDealership(dealershipId: string): Promise<InvoiceBatchRow | null> {
  if (isDemoMode()) {
    return demoStore.list<InvoiceBatchRow>(BATCH_COL)
      .find(b => b.dealershipId === dealershipId && b.pittStopStatus === 'active') ?? null
  }
  const db = getDb()
  const [row] = await db
    .select()
    .from(invoiceBatches)
    .where(and(eq(invoiceBatches.dealershipId, dealershipId), eq(invoiceBatches.pittStopStatus, 'active')))
    .limit(1)
  return (row as InvoiceBatchRow) ?? null
}

export async function createInvoiceBatch(data: {
  dealershipId:            string
  dealershipName:          string
  quickbooksCustomerId:    string
  quickbooksInvoiceId:     string
  quickbooksInvoiceNumber: string
  pittStopStatus:          PittStopBatchStatus
}): Promise<string> {
  if (isDemoMode()) {
    const id = crypto.randomUUID()
    demoStore.insert<InvoiceBatchRow>(BATCH_COL, {
      id,
      ...data,
      batchStartDate: new Date(),
      finalizedDate:  null,
      closedDate:     null,
      createdAt:      new Date(),
      updatedAt:      new Date(),
    })
    return id
  }
  const db    = getDb()
  const [row] = await db.insert(invoiceBatches).values(data).returning({ id: invoiceBatches.id })
  return row.id
}

export async function updateInvoiceBatch(
  id: string,
  data: Partial<{
    pittStopStatus:          PittStopBatchStatus
    quickbooksCustomerId:    string
    quickbooksInvoiceId:     string
    quickbooksInvoiceNumber: string
    finalizedDate:           Date | null
    closedDate:              Date | null
  }>
): Promise<InvoiceBatchRow | null> {
  if (isDemoMode()) {
    return demoStore.update<InvoiceBatchRow>(BATCH_COL, id, { ...data, updatedAt: new Date() })
  }
  const db    = getDb()
  const [row] = await db
    .update(invoiceBatches)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(invoiceBatches.id, id))
    .returning()
  return (row as InvoiceBatchRow) ?? null
}

// Count vehicles in a batch (synced to that invoice)
export async function countVehiclesInBatch(batchId: string): Promise<number> {
  if (isDemoMode()) {
    return demoStore.list<{ invoiceBatchId: string }>('vehicle_entries')
      .filter(e => e.invoiceBatchId === batchId).length
  }
  const db = getDb()
  const [row] = await db
    .select({ n: count() })
    .from(vehicleEntries)
    .where(eq(vehicleEntries.invoiceBatchId, batchId))
  return Number(row?.n ?? 0)
}

// Count entries waiting for invoice assignment for a given dealership
// (by explicit dealershipId OR by stock number prefix)
export async function countPendingForDealership(
  dealershipId: string,
  stockPrefix: string
): Promise<number> {
  if (isDemoMode()) {
    return demoStore.list<{ invoiceSyncStatus: string; dealershipId: string; stockNumber: string }>('vehicle_entries')
      .filter(e =>
        e.invoiceSyncStatus === 'pending_invoice_assignment' &&
        (e.dealershipId === dealershipId ||
         (e.stockNumber ?? '').toUpperCase().startsWith(stockPrefix.toUpperCase()))
      ).length
  }
  const db = getDb()
  const all = await db
    .select({ id: vehicleEntries.id, dealershipId: vehicleEntries.dealershipId, stockNumber: vehicleEntries.stockNumber })
    .from(vehicleEntries)
    .where(eq(vehicleEntries.invoiceSyncStatus, 'pending_invoice_assignment'))
  return all.filter(e =>
    e.dealershipId === dealershipId ||
    (e.stockNumber ?? '').toUpperCase().startsWith(stockPrefix.toUpperCase())
  ).length
}

// Check if another entry in the same batch has the same stock number
export async function findDuplicateInBatch(
  currentEntryId: string,
  stockNumber: string,
  batchId: string
): Promise<string | null> {
  if (isDemoMode()) {
    const dupe = demoStore.list<{ id: string; stockNumber: string; invoiceBatchId: string; invoiceSyncStatus: string }>('vehicle_entries')
      .find(e =>
        e.id !== currentEntryId &&
        e.stockNumber === stockNumber &&
        e.invoiceBatchId === batchId &&
        e.invoiceSyncStatus === 'synced'
      )
    return dupe?.id ?? null
  }
  const db = getDb()
  const [row] = await db
    .select({ id: vehicleEntries.id })
    .from(vehicleEntries)
    .where(
      and(
        ne(vehicleEntries.id, currentEntryId),
        eq(vehicleEntries.stockNumber, stockNumber),
        eq(vehicleEntries.invoiceBatchId, batchId),
        eq(vehicleEntries.invoiceSyncStatus, 'synced')
      )
    )
    .limit(1)
  return row?.id ?? null
}

// List pending entries for a dealership (by dealershipId or stock prefix)
export async function listPendingEntriesForDealership(
  dealershipId: string,
  stockPrefix: string
): Promise<{ id: string; stockNumber: string | null; year: string | null; make: string | null; model: string | null; createdAt: Date }[]> {
  if (isDemoMode()) {
    return demoStore
      .list<{ id: string; stockNumber: string | null; dealershipId: string | null; year: string | null; make: string | null; model: string | null; createdAt: Date; invoiceSyncStatus: string | null }>('vehicle_entries')
      .filter(e =>
        e.invoiceSyncStatus === 'pending_invoice_assignment' &&
        (e.dealershipId === dealershipId ||
         (e.stockNumber ?? '').toUpperCase().startsWith(stockPrefix.toUpperCase()))
      )
      .map(e => ({ id: e.id, stockNumber: e.stockNumber, year: e.year, make: e.make, model: e.model, createdAt: e.createdAt }))
  }
  const db = getDb()
  const rows = await db
    .select({ id: vehicleEntries.id, stockNumber: vehicleEntries.stockNumber, dealershipId: vehicleEntries.dealershipId, year: vehicleEntries.year, make: vehicleEntries.make, model: vehicleEntries.model, createdAt: vehicleEntries.createdAt })
    .from(vehicleEntries)
    .where(eq(vehicleEntries.invoiceSyncStatus, 'pending_invoice_assignment'))
  return rows
    .filter(e =>
      e.dealershipId === dealershipId ||
      (e.stockNumber ?? '').toUpperCase().startsWith(stockPrefix.toUpperCase())
    )
    .map(e => ({ id: e.id, stockNumber: e.stockNumber, year: e.year, make: e.make, model: e.model, createdAt: e.createdAt }))
}

// ── Mock QuickBooks Invoices ─────────────────────────────────────────────────

export type MockQBInvoiceRow = {
  id:            string
  customerId:    string
  customerName:  string
  invoiceNumber: string
  syncToken:     number
  lines:         QBLine[]
  createdAt:     Date
  updatedAt:     Date
}

export async function getMockQBInvoice(id: string): Promise<MockQBInvoiceRow | null> {
  if (isDemoMode()) return demoStore.get<MockQBInvoiceRow>(MOCK_QB_COL, id)
  const db = getDb()
  const [row] = await db.select().from(mockQbInvoices).where(eq(mockQbInvoices.id, id)).limit(1)
  if (!row) return null
  return { ...row, lines: (row.lines ?? []) as QBLine[] } as MockQBInvoiceRow
}

export async function createMockQBInvoice(data: {
  id:            string
  customerId:    string
  customerName:  string
  invoiceNumber: string
}): Promise<MockQBInvoiceRow> {
  const row: MockQBInvoiceRow = {
    ...data,
    syncToken: 1,
    lines:     [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  if (isDemoMode()) {
    demoStore.insert<MockQBInvoiceRow>(MOCK_QB_COL, row)
    return row
  }
  const db = getDb()
  await db.insert(mockQbInvoices).values({ ...row, lines: [] })
  return row
}

export async function addLineToMockQBInvoice(
  invoiceId: string,
  expectedSyncToken: number,
  line: QBLine
): Promise<{ newSyncToken: number }> {
  const invoice = await getMockQBInvoice(invoiceId)
  if (!invoice) throw new Error(`Mock QB invoice ${invoiceId} not found`)
  if (invoice.syncToken !== expectedSyncToken) {
    throw new Error(`SyncToken mismatch: expected ${expectedSyncToken}, got ${invoice.syncToken}`)
  }
  const newLines     = [...invoice.lines, line]
  const newSyncToken = invoice.syncToken + 1

  if (isDemoMode()) {
    demoStore.update<MockQBInvoiceRow>(MOCK_QB_COL, invoiceId, { lines: newLines, syncToken: newSyncToken, updatedAt: new Date() })
    return { newSyncToken }
  }
  const db = getDb()
  await db
    .update(mockQbInvoices)
    .set({ lines: newLines as never, syncToken: newSyncToken, updatedAt: new Date() })
    .where(eq(mockQbInvoices.id, invoiceId))
  return { newSyncToken }
}

// Generate the next sequential mock invoice number
export async function nextMockInvoiceNumber(): Promise<string> {
  if (isDemoMode()) {
    const n = demoStore.list<unknown>(MOCK_QB_COL).length + 1
    return `PSI-${String(n).padStart(4, '0')}`
  }
  const db = getDb()
  const [row] = await db.select({ n: count() }).from(mockQbInvoices)
  const n = Number(row?.n ?? 0) + 1
  return `PSI-${String(n).padStart(4, '0')}`
}
