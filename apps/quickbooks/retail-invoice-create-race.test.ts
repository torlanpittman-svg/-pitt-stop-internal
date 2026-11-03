/**
 * Employee part removal vs retail QuickBooks invoice Create — both orderings are safe:
 *   • a removal that commits BETWEEN Create's estimate read and its compare-and-set lock → Create re-reads under
 *     the lock, sees the change, releases the lock and refuses BEFORE any QuickBooks write (a retry then invoices
 *     the current estimate);
 *   • a removal attempted AFTER Create claimed the row (qb_status='creating') → the removal's own guard refuses it
 *     with the manager message, and the invoice is created with the part on it.
 * Real estimate/draft/payload/removal code against PGlite; QuickBooks mocked at the HTTP layer only; the ordering is
 * produced by running the removal inside getFullEstimate (the exact read Create makes before / after the lock).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
const qb = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; body?: Record<string, unknown> }>, live: [] as unknown[], invoice: null as Record<string, unknown> | null }))
vi.mock('@/apps/quickbooks/client', () => ({
  qboEscape: (s: string) => s.replace(/'/g, "\\'"),
  queryQBO: async (q: string) => {
    qb.calls.push({ method: 'QUERY', path: q })
    if (/from Item MAXRESULTS/i.test(q)) return { Item: qb.live }
    if (/from Item where Name = 'Labor'/i.test(q)) return { Item: [{ Id: '53', Name: 'Labor' }] }
    if (/from Item where Name = 'Fees'/i.test(q)) return { Item: [{ Id: '1010000012', Name: 'Fees' }] }
    if (/from Account/i.test(q)) return { Account: [{ Id: '1', Name: 'Services' }] }
    if (/from Invoice/i.test(q)) return { Invoice: [] }
    throw new Error(`unexpected QBO query: ${q}`)
  },
  qbApiRequest: async (req: { method?: string; path: string; body?: Record<string, unknown> }) => {
    const method = req.method ?? 'GET'
    qb.calls.push({ method, path: req.path, body: req.body })
    if (method === 'POST' && req.path === '/invoice') {
      const lines = req.body!.Line as Array<{ Amount: number }>
      qb.invoice = { ...req.body, Id: 'INV-1', DocNumber: '100900', SyncToken: '0', TotalAmt: Math.round(lines.reduce((s, l) => s + l.Amount, 0) * 100) / 100, Line: lines.map(() => ({ DetailType: 'SalesItemLineDetail' })) }
      return { Invoice: qb.invoice }
    }
    throw new Error(`unexpected QB call: ${method} ${req.path}`)
  },
}))
vi.mock('@/apps/quickbooks/retail-customer', async (orig) => ({
  ...(await orig<object>()),
  resolveRetailCustomer: async () => ({ qbCustomerId: 'CUST-1', billEmail: 'test@example.invalid', matchedBy: 'test', created: false, emailConflict: false, emailStatus: 'ok' }),
  resolveRetailCustomerIdentity: async () => ({ qbCustomerId: 'CUST-1' }),
}))
// Create's estimate reads go through this spy so a removal can be slipped in at an exact point: `after` runs once
// the real read has returned (Create now holds that copy), `before` runs just before the read is made.
const est = vi.hoisted(() => ({ call: 0, before: null as null | ((n: number) => Promise<void>), after: null as null | ((n: number) => Promise<void>) }))
vi.mock('@/apps/workflow/estimate-db', async (orig) => {
  const m = await orig<typeof import('@/apps/workflow/estimate-db')>()
  return { ...m, getFullEstimate: async (id: string) => {
    const n = ++est.call
    if (est.before) await est.before(n)
    const full = await m.getFullEstimate(id)
    if (est.after) await est.after(n)
    return full
  } }
})

import { seedProductionCatalog, LIVE_QB_ITEMS, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, setServicePrice, getEstimateView } from '@/apps/workflow/estimate-db'
import { createRetailQBInvoice } from './retail-invoice-service'
import { addPartForJob, removeEstimatePartWithLabor } from '@/apps/parts/estimate-parts'
import { INVOICED_NEEDS_MANAGER_MSG } from '@/apps/parts/job-items-view'
import { serviceOrders, vehicles, jobEstimates, jobParts } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema }); holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]); await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  qb.calls = []; qb.live = LIVE_QB_ITEMS; qb.invoice = null
  est.before = null; est.after = null; est.call = 0
  await seedProductionCatalog(db)
})

/** A priced retail Job (ready to invoice) with one employee-added part on its service. */
async function jobWithPart() {
  const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Accord', year: '2019' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `RC-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'ready', customerName: 'Race Test', services: ['Oil change'] }).returning()
  const e = await getOrCreateEstimate(o.id, 'Manager')
  const s = await addService(e.id, 'Oil change', { actor: 'Manager' })
  await setServicePrice(e.id, s.id, 6000, 'Manager')
  const part = await addPartForJob(o.id, { description: 'Cabin air filter', quantity: 2, sellPriceCents: 1250 }, 'Employee', null, s.id)
  return { orderId: o.id, estimateId: e.id, part }
}
const estRow = async (id: string) => (await db.select().from(jobEstimates).where(eq(jobEstimates.id, id)))[0]
const partRow = async (id: string) => (await db.select().from(jobParts).where(eq(jobParts.id, id)))[0]
const invoiceTotalCents = () => Math.round(Number(qb.invoice?.TotalAmt ?? 0) * 100)
const employeeRemove = (orderId: string, partId: string) => removeEstimatePartWithLabor(orderId, partId, { action: 'keep' }, 'Employee', { requireNotInvoiced: true })

describe('employee part removal racing retail invoice Create', () => {
  it('baseline: no race → the invoice bills service + part × qty exactly once', async () => {
    const { orderId } = await jobWithPart()
    const r = await createRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(r).toMatchObject({ ok: true, status: 'created' })
    expect(invoiceTotalCents()).toBe(6000 + 2500)
  })

  it('removal commits between Create’s read and its lock → Create refuses before any QuickBooks write, releases the lock; a retry invoices the current estimate', async () => {
    const { orderId, estimateId, part } = await jobWithPart()
    let removed = false
    // Create's FIRST read (before the lock) has returned WITH the part; the employee's removal then commits
    // before Create's compare-and-set — the exact window.
    est.after = async (n) => { if (n === 1) { await employeeRemove(orderId, part.id); removed = true } }
    const r = await createRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(removed).toBe(true)
    expect(r).toMatchObject({ ok: false, status: 'refused' })
    expect(r.error).toMatch(/estimate changed/i)
    expect(qb.calls.filter((c) => c.method === 'POST')).toEqual([])   // nothing written to QuickBooks
    const e = await estRow(estimateId)
    expect(e.qbStatus).toBe('none'); expect(e.qbInvoiceId).toBeNull()   // lock released
    expect((await partRow(part.id)).status).toBe('cancelled')             // the employee's removal stands
    expect((await getEstimateView(orderId)).workTotalCents).toBe(6000)
    // Retry: invoices what is on the estimate NOW.
    est.after = null
    const r2 = await createRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(r2).toMatchObject({ ok: true, status: 'created' })
    expect(invoiceTotalCents()).toBe(6000)
    expect((await estRow(estimateId)).qbInvoiceId).toBe('INV-1')
  })

  it('removal attempted after Create claimed the row (qb_status=creating) → refused by the removal’s own guard; the invoice bills the part', async () => {
    const { orderId, estimateId, part } = await jobWithPart()
    let refusedWith: string | null = null
    est.before = async (n) => {
      if (n === 2) {   // the re-read UNDER the lock: Create has already compare-and-set qb_status='creating'
        expect((await estRow(estimateId)).qbStatus).toBe('creating')
        await employeeRemove(orderId, part.id).catch((err: Error) => { refusedWith = err.message })
      }
    }
    const r = await createRetailQBInvoice({ orderId, actor: 'Manager' })
    expect(refusedWith).toBe(INVOICED_NEEDS_MANAGER_MSG)
    expect(r).toMatchObject({ ok: true, status: 'created' })
    expect(invoiceTotalCents()).toBe(6000 + 2500)
    expect((await partRow(part.id)).status).toBe('needed')   // still on the Job — and on the invoice
    expect((await estRow(estimateId)).qbInvoiceId).toBe('INV-1')
    // And afterwards (invoice exists): still manager-only.
    est.before = null
    await expect(employeeRemove(orderId, part.id)).rejects.toThrow(INVOICED_NEEDS_MANAGER_MSG)
  })
})
