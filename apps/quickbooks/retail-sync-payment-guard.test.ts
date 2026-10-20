/**
 * A payment recorded (or in flight / unconfirmed) on the linked invoice freezes it: Sync refuses before
 * any estimate review or QuickBooks call, so a paid invoice is never rewritten in place — and a payment
 * lock taken AFTER Sync's early check but before Sync's own lock still wins (the exclusion is in the
 * compare-and-set, not the read).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
const hooks = vi.hoisted(() => ({ review: null as null | (() => Promise<void>), raw: null as null | Record<string, unknown> }))
const reviewCalls = vi.fn()
vi.mock('@/apps/workflow/estimate-review', () => ({
  loadEstimateReview: async () => {
    reviewCalls()
    if (!hooks.review) throw new Error('must not be reached')
    await hooks.review()
    return { readiness: { ready: true, issues: [], summary: '' } }
  },
}))
const qbRead = vi.fn()
const qbWrite = vi.fn()
vi.mock('@/apps/quickbooks/retail-invoice-write', () => ({
  getRetailInvoiceRaw: async () => { qbRead(); return hooks.raw },
  updateRetailInvoiceInQB: async () => { qbWrite(); throw new Error('must not write') },
  resolveRetailItems: async () => { qbWrite(); throw new Error('must not build a payload') },
}))
vi.mock('@/apps/quickbooks/retail-customer', async (orig) => ({ ...(await orig<object>()), resolveRetailCustomerIdentity: async () => ({ qbCustomerId: 'C1' }) }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))

import { syncRetailQBInvoice, sendRetailQBInvoice } from './retail-invoice-service'
import { serviceOrders, vehicles, jobEstimates } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema }); holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]); await apply()
})

describe('Sync is blocked once a payment exists', () => {
  for (const status of ['paid', 'recording', 'uncertain', 'review']) {
    it(`qb_payment_status=${status} → block 'paid', no QuickBooks call`, async () => {
      const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Civic', year: '2019' }).returning()
      const [o] = await db.insert(serviceOrders).values({ orderNumber: `SG-${status}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'ready', customerName: 'X' }).returning()
      await db.insert(jobEstimates).values({ serviceOrderId: o.id, qbInvoiceId: `9${status.length}`, qbInvoiceNumber: '1', qbStatus: 'sent', qbPaymentStatus: status })
      const r = await syncRetailQBInvoice({ orderId: o.id, actor: 'T', confirmSent: true })
      expect(r).toMatchObject({ ok: false, block: 'paid' })
      expect(reviewCalls).not.toHaveBeenCalled()
      expect(qbRead).not.toHaveBeenCalled()
    })
  }

  for (const status of ['paid', 'recording', 'uncertain', 'review']) {
    it(`unpaid Send is refused once qb_payment_status=${status} (Email Paid Invoice owns emailing; no QuickBooks call)`, async () => {
      const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Civic', year: '2019' }).returning()
      const [o] = await db.insert(serviceOrders).values({ orderNumber: `SS-${status}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'ready', customerName: 'X' }).returning()
      await db.insert(jobEstimates).values({ serviceOrderId: o.id, qbInvoiceId: `8${status.length}`, qbInvoiceNumber: '2', qbStatus: 'created', qbPaymentStatus: status })
      qbRead.mockClear()
      const r = await sendRetailQBInvoice({ orderId: o.id, actor: 'T' })
      expect(r).toMatchObject({ ok: false, block: 'paid' })
      expect(qbRead).not.toHaveBeenCalled()
    })
  }

  it('Record Payment locks the invoice between Sync\'s early check and Sync\'s lock → Sync never takes it, nothing written', async () => {
    const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Civic', year: '2019' }).returning()
    const [o] = await db.insert(serviceOrders).values({ orderNumber: 'SG-race', vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'ready', customerName: 'X' }).returning()
    const [e] = await db.insert(jobEstimates).values({ serviceOrderId: o.id, priceMode: 'explicit_pretax', explicitTotalCents: 12000, qbInvoiceId: 'INV-R', qbInvoiceNumber: '7', qbStatus: 'created' }).returning()
    hooks.raw = { Id: 'INV-R', DocNumber: '7', SyncToken: '0', PrivateNote: `PSID:${e.id}`, CustomerRef: { value: 'C1' }, TotalAmt: 120, EmailStatus: 'NotSet' }
    // The interleaving point: Sync has passed its payment check; Record Payment now takes its lock.
    hooks.review = async () => {
      await db.update(jobEstimates).set({ qbPaymentStatus: 'recording', qbPaymentRequestId: 'attempt-1', qbPaymentStartedAt: new Date() }).where(eq(jobEstimates.id, e.id))
    }
    const r = await syncRetailQBInvoice({ orderId: o.id, actor: 'T' })
    expect(r.ok).toBe(false)
    expect(['paid', 'syncing']).toContain(r.block)
    expect(qbWrite).not.toHaveBeenCalled()
    const [after] = await db.select().from(jobEstimates).where(eq(jobEstimates.id, e.id))
    expect(after).toMatchObject({ qbStatus: 'created', qbPaymentStatus: 'recording' })
    hooks.review = null
  })

  it('Record Payment\'s own Cash / Check sync: only the attempt that HOLDS the payment lock gets through', async () => {
    const [v] = await db.insert(vehicles).values({ make: 'Honda', model: 'Civic', year: '2019' }).returning()
    const [o] = await db.insert(serviceOrders).values({ orderNumber: 'SG-owner', vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'ready', customerName: 'X' }).returning()
    const lockAt = new Date('2026-10-20T12:00:00.123Z')
    const [e] = await db.insert(jobEstimates).values({ serviceOrderId: o.id, priceMode: 'explicit_pretax', explicitTotalCents: 12000, qbInvoiceId: 'INV-O', qbInvoiceNumber: '8', qbStatus: 'sent', qbPaymentStatus: 'recording', qbPaymentRequestId: 'attempt-1', qbPaymentStartedAt: lockAt }).returning()
    hooks.raw = { Id: 'INV-O', DocNumber: '8', SyncToken: '0', PrivateNote: `PSID:${e.id}`, CustomerRef: { value: 'C1' }, TotalAmt: 120, EmailStatus: 'EmailSent' }
    // A different / superseded attempt → refused before any review or QuickBooks call.
    reviewCalls.mockClear(); qbRead.mockClear()
    for (const lock of [{ requestId: 'attempt-2', startedAt: lockAt }, { requestId: 'attempt-1', startedAt: new Date(lockAt.getTime() + 1) }]) {
      expect(await syncRetailQBInvoice({ orderId: o.id, actor: 'T', confirmSent: true, paymentLock: lock })).toMatchObject({ ok: false, block: 'paid' })
    }
    expect(reviewCalls).not.toHaveBeenCalled()
    expect(qbRead).not.toHaveBeenCalled()
    // The owner passes the payment gate and takes the Sync lock (a plain Sync still cannot).
    let plainSync: unknown = null
    hooks.review = async () => { plainSync = await syncRetailQBInvoice({ orderId: o.id, actor: 'T', confirmSent: true }) }
    const r = await syncRetailQBInvoice({ orderId: o.id, actor: 'T', confirmSent: true, paymentLock: { requestId: 'attempt-1', startedAt: lockAt } })
    hooks.review = null
    expect(plainSync).toMatchObject({ ok: false, block: 'paid' })
    expect(qbRead).toHaveBeenCalled()
    // It got past the lock (the fake payload builder then fails) — and the payment lock is untouched.
    expect(r).toMatchObject({ ok: false, block: 'sync_failed', ambiguous: false })
    const [after] = await db.select().from(jobEstimates).where(eq(jobEstimates.id, e.id))
    expect(after).toMatchObject({ qbStatus: 'error', qbPaymentStatus: 'recording', qbPaymentRequestId: 'attempt-1' })
  })
})
