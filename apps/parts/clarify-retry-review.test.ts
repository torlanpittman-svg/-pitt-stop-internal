/**
 * REGRESSION: "clarify a service line as (also) a part" must be failure-safe and idempotent.
 *
 *   1. Invalid input (bad quantity / price) rejects with NOTHING written — the service_as_part review
 *      stays in place (it must never be cleared before the part is actually created and linked).
 *   2. A retry / double-tap / two simultaneous requests create ONE charged part, not two.
 *   3. After a lost response, retrying the exact request returns the same, fully-built part — and a
 *      post-commit failure (recompute/sync flag) is finalized on the retry, not silently skipped.
 *   4. A conflicting retry that CHANGES the part is refused (saved part untouched), never silent success.
 *   5. A failure DURING the atomic statement (DB trigger) rolls the whole thing back — no part, no
 *      line, no audit, and the original review is intact.
 *   6. Migration 0054 is idempotent and its claim index only constrains clarification parts.
 *
 * In-memory PGlite from the real Drizzle schema + production-shaped catalog + migrations 0052/0053/0054.
 * No DB/QB/network.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { and, eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
// Inject ONE post-commit failure into the derived-pricing recompute (the step that runs AFTER the
// atomic clarify statement has committed), to prove a retry finalizes the unfinished work.
const inject = vi.hoisted(() => ({ failSettleOnce: false }))
vi.mock('@/apps/workflow/estimate-db', async (orig) => {
  const real = await orig<typeof import('@/apps/workflow/estimate-db')>()
  return {
    ...real,
    settlePricingAfterLineChange: async (estimateId: string, priced: boolean) => {
      if (inject.failSettleOnce) { inject.failSettleOnce = false; throw new Error('injected post-commit failure') }
      return real.settlePricingAfterLineChange(estimateId, priced)
    },
  }
})

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { getOrCreateEstimate, addService, addLine, getEstimateView, removeEstimateService } from '@/apps/workflow/estimate-db'
import { loadEstimateReview } from '@/apps/workflow/estimate-review'
import { clarifyServiceWithPart, removeEstimatePart } from '@/apps/parts/estimate-parts'
import { serviceOrders, vehicles, jobParts, jobServices, jobLineItems, jobEstimates, serviceOrderEvents } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  await seedProductionCatalog(db)
  inject.failSettleOnce = false
})

async function order() {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'F-150', year: '2019' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `CLR-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived', customerName: 'Test Customer' }).returning()
  const est = await getOrCreateEstimate(o.id, 'Manager')
  return { orderId: o.id, estimateId: est.id }
}
/** A service line that is really a physical part, priced so the clarified labor keeps a real price. */
async function partTypedAsService(estimateId: string) {
  const svc = await addService(estimateId, 'Driver-side mirror assembly', { entryText: 'dr mirr assy', actor: 'Manager' })
  await addLine(svc.id, { type: 'labor', name: 'Driver-side mirror assembly', description: 'Driver-side mirror assembly', qty: 1, unit: 'each', costCents: 0, priceCents: 26500, taxable: true, taxCategory: 'repair_parts' })
  return svc
}
const partCount = async (orderId: string) => (await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, orderId))).length
const codes = async (orderId: string) => (await loadEstimateReview(orderId)).readiness.issues.map((i) => i.code)
const eventCount = async (orderId: string, type: string) =>
  (await db.select().from(serviceOrderEvents).where(and(eq(serviceOrderEvents.serviceOrderId, orderId), eq(serviceOrderEvents.eventType, type)))).length
const estTotal = async (orderId: string) => (await db.select().from(jobEstimates).where(eq(jobEstimates.serviceOrderId, orderId)))[0].totalCents

describe('review: clarification is failure-safe and idempotent', () => {
  it('removing a clarified shop part cancels it, drops its billed line, and keeps the labor line priced', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    const part = await clarifyServiceWithPart(orderId, svc.id, { description: 'Windshield', supply: 'shop', quantity: 1, sellPriceCents: 8000 }, 'Manager', 'manager')
    const lineId = part.jobLineItemId
    await removeEstimatePart(orderId, part.id, 'Manager')
    const [saved] = await db.select().from(jobParts).where(eq(jobParts.id, part.id))
    expect(saved.status).toBe('cancelled')
    expect(saved.jobServiceId).toBeNull()        // own structural links cleared so no FK dangles as the row is deleted
    expect(saved.jobLineItemId).toBeNull()
    expect(await db.select().from(jobLineItems).where(eq(jobLineItems.id, lineId!))).toHaveLength(0)   // billed line gone
    const v = await getEstimateView(orderId)
    expect(v.parts).toHaveLength(0)
    expect(v.services[0].priceCents).toBe(26500)   // the labor line (its price) is untouched
    expect(await partCount(orderId)).toBe(1)        // soft-cancel, not a duplicate
  })

  it('removing the covering labor line reopens the clarified part, clears its labor + clarify keys, keeps its price', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    const part = await clarifyServiceWithPart(orderId, svc.id, { description: 'Windshield', supply: 'shop', quantity: 1, sellPriceCents: 8000 }, 'Manager', 'manager')
    await removeEstimateService(orderId, svc.id, 'Manager')   // delete the service that was covering installation
    const [reopened] = await db.select().from(jobParts).where(eq(jobParts.id, part.id))
    expect(reopened.status).not.toBe('cancelled')     // the part itself survives
    expect(reopened.sellPriceCents).toBe(8000)        // its price is preserved
    expect(reopened.laborServiceId).toBeNull()        // link to the deleted labor cleared
    expect(reopened.clarifiesServiceId).toBeNull()    // and the clarify key that pointed at it
    expect(reopened.laborStatus).toBe('needs_review')
    expect(await codes(orderId)).toContain('part_labor')   // review re-opens
    expect(await partCount(orderId)).toBe(1)               // no orphan / double-charged part
    expect(await eventCount(orderId, 'part_labor_reopened')).toBe(1)
  })

  it('invalid quantity rejects and leaves the part warning in place (no write)', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    await expect(clarifyServiceWithPart(orderId, svc.id, { description: 'Mirror assembly', supply: 'shop', quantity: 0 }, 'Manager', 'manager')).rejects.toThrow()
    expect(await codes(orderId)).toContain('service_as_part')
    expect(await partCount(orderId)).toBe(0)
  })

  it('invalid price rejects and leaves the part warning in place (no write)', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    await expect(clarifyServiceWithPart(orderId, svc.id, { description: 'Mirror assembly', supply: 'shop', quantity: 1, sellPriceCents: -5 }, 'Manager', 'manager')).rejects.toThrow()
    expect(await codes(orderId)).toContain('service_as_part')
    expect(await partCount(orderId)).toBe(0)
  })

  it('simultaneous clarification requests create one charged part', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    const input = { description: 'Mirror assembly', supply: 'shop' as const, quantity: 1, sellPriceCents: 15000 }
    const results = await Promise.all([
      clarifyServiceWithPart(orderId, svc.id, input, 'Manager', 'manager'),
      clarifyServiceWithPart(orderId, svc.id, input, 'Manager', 'manager'),
    ])
    expect(results[0].id).toBe(results[1].id)
    expect(await partCount(orderId)).toBe(1)
  })

  it('a retry after a lost response returns the same, fully-built part (no partial, no duplicate)', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    const input = { description: 'Mirror assembly', supply: 'shop' as const, quantity: 1, sellPriceCents: 15000 }
    const first = await clarifyServiceWithPart(orderId, svc.id, input, 'Manager', 'manager')
    const retry = await clarifyServiceWithPart(orderId, svc.id, input, 'Manager', 'manager')   // client never saw the first response
    expect(retry.id).toBe(first.id)
    expect(await partCount(orderId)).toBe(1)

    const v = await getEstimateView(orderId)
    expect(v.services).toHaveLength(1)
    expect(v.services[0]).toMatchObject({ title: 'Driver-side mirror assembly', priceCents: 26500, matchState: 'custom', partLike: null })
    expect(v.parts).toEqual([expect.objectContaining({ description: 'Mirror assembly', supply: 'shop', laborStatus: 'included', laborServiceId: svc.id, sellPriceCents: 15000 })])
    expect(v.review!.ready).toBe(true)
  })

  it('a post-commit failure is finalized on retry: one part/line/audit, derived totals recomputed, QB sync flagged', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    await db.update(jobEstimates).set({ qbInvoiceId: 'INV-OLD', qbInvoiceNumber: '100800' }).where(eq(jobEstimates.id, estimateId))
    const input = { description: 'Mirror assembly', supply: 'shop' as const, quantity: 1, sellPriceCents: 15000 }

    inject.failSettleOnce = true   // the atomic statement commits, then the recompute throws
    await expect(clarifyServiceWithPart(orderId, svc.id, input, 'Manager', 'manager')).rejects.toThrow(/injected/)
    expect(await estTotal(orderId)).toBe(0)   // derived totals NOT yet finalized (recompute never ran)

    const retry = await clarifyServiceWithPart(orderId, svc.id, input, 'Manager', 'manager')   // same request, now succeeds
    expect(await partCount(orderId)).toBe(1)                                         // never duplicated
    const [part] = await db.select().from(jobParts).where(eq(jobParts.id, retry.id))
    const lines = await db.select().from(jobLineItems).where(and(eq(jobLineItems.jobServiceId, part.jobServiceId!), eq(jobLineItems.generated, false)))
    expect(lines).toHaveLength(1)                                                    // one priced line, not two
    expect(await eventCount(orderId, 'part_added')).toBe(1)
    expect(await eventCount(orderId, 'part_labor_review')).toBe(1)
    expect(await eventCount(orderId, 'service_matched')).toBe(1)                     // audits written once (by the committed statement)
    expect(await estTotal(orderId)).toBeGreaterThan(0)                              // derived totals finalized on the retry
    const [est] = await db.select().from(jobEstimates).where(eq(jobEstimates.id, estimateId))
    expect(est.qbSyncError).toMatch(/sync needed/i)                                 // and the QB-sync flag finalized too
    expect((await getEstimateView(orderId)).review!.ready).toBe(true)
  })

  it('a conflicting retry that CHANGES the part is refused (saved part untouched), not silently ignored', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    const first = await clarifyServiceWithPart(orderId, svc.id, { description: 'Mirror assembly', supply: 'shop', quantity: 1, sellPriceCents: 15000 }, 'Manager', 'manager')
    // Same line + description + source but a DIFFERENT price → explicit conflict, saved part left as-is.
    await expect(clarifyServiceWithPart(orderId, svc.id, { description: 'Mirror assembly', supply: 'shop', quantity: 1, sellPriceCents: 99900 }, 'Manager', 'manager'))
      .rejects.toThrow(/already added/i)
    expect(await partCount(orderId)).toBe(1)
    const [part] = await db.select().from(jobParts).where(eq(jobParts.id, first.id))
    expect(part.sellPriceCents).toBe(15000)
    expect((await getEstimateView(orderId)).parts![0].sellPriceCents).toBe(15000)
  })

  it('a failure DURING the atomic statement rolls back every write and leaves the review intact', async () => {
    const { orderId, estimateId } = await order()
    const svc = await partTypedAsService(estimateId)
    await db.execute(`CREATE OR REPLACE FUNCTION clarify_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'clarify boom'; END; $$`)
    await db.execute(`CREATE TRIGGER clarify_boom_trg BEFORE INSERT ON service_order_events FOR EACH ROW WHEN (NEW.event_type = 'part_labor_review') EXECUTE FUNCTION clarify_boom()`)
    try {
      await expect(clarifyServiceWithPart(orderId, svc.id, { description: 'Mirror assembly', supply: 'shop', quantity: 1, sellPriceCents: 15000 }, 'Manager', 'manager')).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'P0001', message: 'clarify boom' }) })
      // Nothing committed: no part, no part estimate row, no part line, no audit — and the line is still flagged.
      expect(await partCount(orderId)).toBe(0)
      expect((await db.select().from(jobServices).where(eq(jobServices.jobEstimateId, estimateId))).filter((s) => s.kind === 'part')).toHaveLength(0)
      expect(await db.select().from(jobLineItems).where(eq(jobLineItems.jobServiceId, svc.id))).toHaveLength(1)   // only the original labor line
      expect(await eventCount(orderId, 'part_added')).toBe(0)
      expect(await eventCount(orderId, 'service_matched')).toBe(0)
      const [row] = await db.select().from(jobServices).where(eq(jobServices.id, svc.id))
      expect(row.matchMethod).toBeNull()                     // the line was NOT confirmed as custom
      expect(await codes(orderId)).toContain('service_as_part')
    } finally {
      await db.execute(`DROP TRIGGER IF EXISTS clarify_boom_trg ON service_order_events`)
      await db.execute(`DROP FUNCTION IF EXISTS clarify_boom()`)
    }
  })
})

describe('migration 0054 — clarify claim index', () => {
  const MIGRATION_0054 = readFileSync(path.join(process.cwd(), 'drizzle/migrations/manual/0054_clarify_part_idempotency.sql'), 'utf8')
  const exec = async (sqlText: string) => (db as unknown as { $client: { exec: (s: string) => Promise<unknown> } }).$client.exec(sqlText)

  it('applies cleanly twice (idempotent) and constrains only clarification parts', async () => {
    await exec(MIGRATION_0054)
    await exec(MIGRATION_0054)   // re-run: IF NOT EXISTS → no error

    const { orderId, estimateId } = await order()
    const anchor = await addService(estimateId, 'Replace windshield', { actor: 'Manager' })

    // Ordinary parts (clarifies_service_id NULL) are NOT constrained — same name, even same source, is fine.
    await db.insert(jobParts).values({ serviceOrderId: orderId, description: 'Brake pad', supply: 'shop', quantity: '1' })
    await db.insert(jobParts).values({ serviceOrderId: orderId, description: 'Brake pad', supply: 'shop', quantity: '1' })
    await db.insert(jobParts).values({ serviceOrderId: orderId, description: 'Brake pad', supply: 'customer', quantity: '1' })

    // Clarification parts ARE constrained per (clarified line, description, source).
    await db.insert(jobParts).values({ serviceOrderId: orderId, description: 'Windshield', supply: 'shop', quantity: '1', clarifiesServiceId: anchor.id })
    await expect(db.insert(jobParts).values({ serviceOrderId: orderId, description: 'Windshield', supply: 'shop', quantity: '1', clarifiesServiceId: anchor.id })).rejects.toThrow()
    // A different source is a different clarification key → allowed.
    await db.insert(jobParts).values({ serviceOrderId: orderId, description: 'Windshield', supply: 'customer', quantity: '1', clarifiesServiceId: anchor.id })
    // A cancelled clarification frees the key again.
    await db.update(jobParts).set({ status: 'cancelled' }).where(and(eq(jobParts.clarifiesServiceId, anchor.id), eq(jobParts.supply, 'shop')))
    await db.insert(jobParts).values({ serviceOrderId: orderId, description: 'Windshield', supply: 'shop', quantity: '1', clarifiesServiceId: anchor.id })
  })
})
