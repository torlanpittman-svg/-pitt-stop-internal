/**
 * Atomic behavior of the parts-screenshot import data layer, on an in-memory PGlite with the REAL schema (no
 * live DB, no network). Covers: atomic batch+image creation, idempotent resume, atomic proposal persistence
 * (failure leaves 'reading'), apply (new + mark-ordered), link eligibility, no-silent-partial-apply,
 * duplicate supplier-order guard + confirm, optimistic revision, and soft cancel with audit.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))

import {
  createBatchWithImages, listBatchImages, claimBatchReading, applyExtraction,
  getBatch, getBatchView, saveBatchReview, applyImport, cancelBatch, type MergedExtraction,
} from './import-db'
import { attachTestBatch } from './import-batch-test-adapter'
import { serviceOrders, vehicles, jobParts, partImportBatches, partImportRows, serviceOrderEvents } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let seq = 0
let hashSeq = 0
const hash = () => String(++hashSeq).padStart(64, '0')

beforeAll(async () => {
  const pg = new PGlite()
  // The real per-job transaction (applyImport uses db.batch) needs a faithful batch on the PGlite driver.
  db = attachTestBatch(drizzle(pg, { schema }), pg)
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  await db.execute('TRUNCATE service_orders CASCADE')
  await db.execute('TRUNCATE vehicles CASCADE')
})

async function order() {
  const [v] = await db.insert(vehicles).values({ make: 'Ford', model: 'Test', year: '2020' }).returning()
  const [o] = await db.insert(serviceOrders).values({ orderNumber: `PI-${++seq}`, vehicleId: v.id, source: 'quick_entry', serviceType: 'retail', status: 'arrived' }).returning()
  return o.id
}
function images(n = 1) { return Array.from({ length: n }, () => ({ imageHash: hash(), storageRef: 'private', contentType: 'image/png', byteSize: 100 })) }

function extraction(imageId: string | null, over: Partial<MergedExtraction['rows'][number]> = {}, batchOver: Partial<MergedExtraction> = {}): MergedExtraction {
  return {
    aiStatus: 'extracted', aiModel: 'mock', aiRaw: null,
    documentKind: 'purchase', supplier: 'NAPA', orderReference: 'REF-1', taxCents: null, shippingCents: null, coreCents: null,
    rows: [{ sourceImageId: imageId, description: 'Rotor', partNumber: 'NB-123', brand: null, supplier: 'NAPA', quantity: 1, unitCostCents: 1000, listPriceCents: null, lineTotalCents: 1000, ...over }],
    ...batchOver,
  }
}
async function propose(orderId: string, over: Partial<MergedExtraction['rows'][number]> = {}, batchOver: Partial<MergedExtraction> = {}, imgs = images(1)) {
  const { batchId } = await createBatchWithImages({ orderId, captureId: null, images: imgs, uploadedBy: 'Mgr', uploadedByKey: 'm' })
  const claim = await claimBatchReading(batchId)
  if (!claim.ok) throw new Error('claim failed')
  await applyExtraction(batchId, claim.token, extraction(claim.images[0]?.id ?? null, over, batchOver))
  return batchId
}

describe('createBatchWithImages — atomic + idempotent', () => {
  it('a failed image insert strands nothing; a retry creates the batch with its image', async () => {
    const id = await order()
    const src = { orderId: id, captureId: null, images: images(1), uploadedBy: 'M', uploadedByKey: 'm' }
    await db.execute("CREATE OR REPLACE FUNCTION reject_img() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$")
    await db.execute('CREATE TRIGGER reject_img BEFORE INSERT ON part_import_images FOR EACH ROW EXECUTE FUNCTION reject_img()')
    await expect(createBatchWithImages(src)).rejects.toThrow()
    await db.execute('DROP TRIGGER reject_img ON part_import_images')
    const retry = await createBatchWithImages(src)
    expect(await listBatchImages(retry.batchId)).toHaveLength(1)
  })

  it('same capture id resumes the SAME batch (no second AI read, no duplicated images)', async () => {
    const id = await order()
    const imgs = images(1)
    const first = await createBatchWithImages({ orderId: id, captureId: '11111111-1111-4111-8111-111111111111', images: imgs, uploadedBy: 'M', uploadedByKey: 'm' })
    const second = await createBatchWithImages({ orderId: id, captureId: '11111111-1111-4111-8111-111111111111', images: imgs, uploadedBy: 'M', uploadedByKey: 'm' })
    expect(second.duplicate).toBe(true)
    expect(second.batchId).toBe(first.batchId)
    expect(await listBatchImages(first.batchId)).toHaveLength(1)
  })

  it('identical screenshots (same set hash) resume the same batch', async () => {
    const id = await order()
    const imgs = images(2)
    const a = await createBatchWithImages({ orderId: id, captureId: null, images: imgs, uploadedBy: 'M', uploadedByKey: 'm' })
    const b = await createBatchWithImages({ orderId: id, captureId: null, images: [imgs[1], imgs[0]], uploadedBy: 'M', uploadedByKey: 'm' })
    expect(b.duplicate).toBe(true)
    expect(b.batchId).toBe(a.batchId)
  })
})

describe('applyExtraction — atomic proposal persistence', () => {
  it('a failed row insert rolls back the status (stays reading), never a completed empty proposal', async () => {
    const id = await order()
    const { batchId } = await createBatchWithImages({ orderId: id, captureId: null, images: images(1), uploadedBy: 'M', uploadedByKey: 'm' })
    const claim = await claimBatchReading(batchId)
    if (!claim.ok) throw new Error('claim')
    await db.execute("CREATE OR REPLACE FUNCTION reject_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$")
    await db.execute('CREATE TRIGGER reject_row BEFORE INSERT ON part_import_rows FOR EACH ROW EXECUTE FUNCTION reject_row()')
    await expect(applyExtraction(batchId, claim.token, extraction(claim.images[0].id))).rejects.toThrow()
    await db.execute('DROP TRIGGER reject_row ON part_import_rows')
    expect((await getBatch(batchId, id))?.status).toBe('reading')
  })

  it('a read with zero usable rows lands failed (actionable), never proposed', async () => {
    const id = await order()
    const { batchId } = await createBatchWithImages({ orderId: id, captureId: null, images: images(1), uploadedBy: 'M', uploadedByKey: 'm' })
    const claim = await claimBatchReading(batchId)
    if (!claim.ok) throw new Error('claim')
    await applyExtraction(batchId, claim.token, { aiStatus: 'extracted', aiModel: 'm', aiRaw: null, documentKind: 'unknown', supplier: null, orderReference: null, taxCents: null, shippingCents: null, coreCents: null, rows: [] })
    expect((await getBatch(batchId, id))?.status).toBe('failed')
  })
})

describe('applyImport — creates parts, marks ordered, blocks silent partial/duplicate', () => {
  it('applies new rows as tracked parts (needed)', async () => {
    const id = await order()
    const batchId = await propose(id)
    const r = await applyImport(batchId, id, 'Mgr')
    expect(r.ok).toBe(true)
    expect(r.inserted).toBe(1)
    const parts = await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, id))
    expect(parts).toHaveLength(1)
    expect(parts[0].status).toBe('needed')
    expect(parts[0].importRowId).not.toBeNull()
    expect((await getBatch(batchId, id))?.status).toBe('applied')
  })

  it('“already placed” marks new parts ordered with supplier + order #', async () => {
    const id = await order()
    const batchId = await propose(id)
    await saveBatchReview(batchId, id, { markOrdered: true }, 'Mgr')
    await applyImport(batchId, id, 'Mgr')
    const [p] = await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, id))
    expect(p.status).toBe('ordered')
    expect(p.supplierOrderNumber).toBe('REF-1')
    expect(p.orderedAt).not.toBeNull()
  })

  it('a new row missing a quantity blocks apply (no silent partial, batch not applied)', async () => {
    const id = await order()
    const batchId = await propose(id, { quantity: null })
    const r = await applyImport(batchId, id, 'Mgr')
    expect(r.ok).toBe(false)
    expect((await getBatch(batchId, id))?.status).not.toBe('applied')
  })

  it('writes a money-free audit event', async () => {
    const id = await order()
    const batchId = await propose(id)
    await applyImport(batchId, id, 'Mgr')
    const evs = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, id))
    const applied = evs.find((e) => e.eventType === 'parts_import_applied')
    expect(applied).toBeTruthy()
    expect(applied?.note ?? '').not.toMatch(/\$|cents|cost/i)
  })
})

describe('applyImport — link eligibility + duplicate target', () => {
  it('linking to an already-imported part is rejected and does NOT apply the batch', async () => {
    const id = await order()
    const b1 = await propose(id)
    await applyImport(b1, id, 'Mgr')
    const [existing] = await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, id))
    const b2 = await propose(id, {}, { orderReference: 'REF-2' })
    const [row2] = await db.select().from(partImportRows).where(eq(partImportRows.batchId, b2))
    await saveBatchReview(b2, id, { rows: [{ id: row2.id, linkDecision: 'link', matchedPartId: existing.id }] }, 'Mgr')
    const r = await applyImport(b2, id, 'Mgr')
    expect(r.ok).toBe(false)
    expect((await getBatch(b2, id))?.status).not.toBe('applied')
  })

  it('links a still-needed shop part and promotes it to ordered without clobbering, when marked ordered', async () => {
    const id = await order()
    // an existing manually-added shop part with a sell price set
    const [existing] = await db.insert(jobParts).values({ serviceOrderId: id, description: 'Caliper', supplier: null, sellPriceCents: 9900, status: 'needed', supply: 'shop' }).returning()
    const b = await propose(id, { description: 'Caliper', unitCostCents: 5000 })
    const [row] = await db.select().from(partImportRows).where(eq(partImportRows.batchId, b))
    await saveBatchReview(b, id, { markOrdered: true, rows: [{ id: row.id, linkDecision: 'link', matchedPartId: existing.id }] }, 'Mgr')
    const r = await applyImport(b, id, 'Mgr')
    expect(r.ok).toBe(true)
    expect(r.linked).toBe(1)
    const [p] = await db.select().from(jobParts).where(eq(jobParts.id, existing.id))
    expect(p.status).toBe('ordered')          // promoted
    expect(p.sellPriceCents).toBe(9900)        // preserved (never clobbered)
    expect(p.unitCostCents).toBe(5000)         // filled (was null)
    expect(p.supplierOrderNumber).toBe('REF-1')
  })
})

describe('applyImport — duplicate supplier order guard', () => {
  it('blocks a second import of the same supplier order unless explicitly confirmed', async () => {
    const id = await order()
    const b1 = await propose(id)
    await applyImport(b1, id, 'Mgr')
    const b2 = await propose(id) // same supplier NAPA + REF-1
    const blocked = await applyImport(b2, id, 'Mgr')
    expect(blocked.ok).toBe(false)
    expect(blocked.needsDuplicateConfirm).toBe(true)
    const confirmed = await applyImport(b2, id, 'Mgr', { duplicateConfirmed: true })
    expect(confirmed.ok).toBe(true)
  })
})

describe('optimistic revision + idempotent apply', () => {
  it('apply with a stale expectedRevision is a conflict (no apply)', async () => {
    const id = await order()
    const batchId = await propose(id)
    const rev = (await getBatch(batchId, id))!.revision
    const r = await applyImport(batchId, id, 'Mgr', { expectedRevision: rev - 1 })
    expect(r.ok).toBe(false)
    expect((await getBatch(batchId, id))?.status).not.toBe('applied')
  })

  it('a second apply (double-tap) is an idempotent no-op, not a duplicate', async () => {
    const id = await order()
    const batchId = await propose(id)
    await applyImport(batchId, id, 'Mgr')
    const again = await applyImport(batchId, id, 'Mgr')
    expect(again.ok).toBe(true)
    expect((await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, id)))).toHaveLength(1)
  })
})

describe('cancelBatch — soft, audited, not after apply', () => {
  it('cancels a proposed batch with an audit event', async () => {
    const id = await order()
    const batchId = await propose(id)
    const r = await cancelBatch(batchId, id, 'Mgr')
    expect(r.ok).toBe(true)
    expect((await getBatch(batchId, id))?.status).toBe('cancelled')
    const evs = await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, id))
    expect(evs.some((e) => e.eventType === 'parts_import_cancelled')).toBe(true)
  })

  it('refuses to cancel an applied batch', async () => {
    const id = await order()
    const batchId = await propose(id)
    await applyImport(batchId, id, 'Mgr')
    const r = await cancelBatch(batchId, id, 'Mgr')
    expect(r.ok).toBe(false)
  })

  it('redaction note: getBatchView exposes skuWarning + canMarkOrdered', async () => {
    const id = await order()
    const batchId = await propose(id)
    const view = await getBatchView(batchId, id)
    expect(view?.canMarkOrdered).toBe(true)
    expect(view?.rows[0]).toHaveProperty('skuWarning')
  })
})

describe('applyImport — atomic rollback + hard guards', () => {
  it('a silently-skipped link UPDATE rolls back the WHOLE apply (status proposed, no events)', async () => {
    const id = await order()
    const [target] = await db.insert(jobParts).values({ serviceOrderId: id, description: 'Rotor', quantity: '1', supply: 'shop', status: 'needed' }).returning()
    const batchId = await propose(id)
    const [row] = await db.select().from(partImportRows).where(eq(partImportRows.batchId, batchId))
    await saveBatchReview(batchId, id, { rows: [{ id: row.id, linkDecision: 'link', matchedPartId: target.id }] }, 'Tester')
    await db.execute("CREATE OR REPLACE FUNCTION skip_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$")
    await db.execute('CREATE TRIGGER skip_link BEFORE UPDATE ON job_parts FOR EACH ROW WHEN (NEW.import_row_id IS NOT NULL) EXECUTE FUNCTION skip_link()')
    let result: { ok: boolean }
    try { result = await applyImport(batchId, id, 'Tester') } catch { result = { ok: false } }
    await db.execute('DROP TRIGGER skip_link ON job_parts')
    expect(result.ok).toBe(false)
    expect((await getBatch(batchId, id))?.status).toBe('proposed')
    expect(await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, id))).toHaveLength(0)
  })

  it('the DB (not a precheck) rejects case-variant duplicate supplier orders', async () => {
    const id = await order()
    await db.insert(partImportBatches).values({ serviceOrderId: id, status: 'applied', supplier: 'NAPA', orderReference: 'DEMO-1' })
    await expect(db.insert(partImportBatches).values({ serviceOrderId: id, status: 'applied', supplier: 'napa', orderReference: 'demo-1' })).rejects.toThrow()
  })

  it('linking a part from a different supplier is rejected', async () => {
    const id = await order()
    const [existing] = await db.insert(jobParts).values({ serviceOrderId: id, description: 'Caliper', supplier: 'WorldPac', status: 'needed', supply: 'shop' }).returning()
    const b = await propose(id) // import supplier is NAPA
    const [row] = await db.select().from(partImportRows).where(eq(partImportRows.batchId, b))
    await saveBatchReview(b, id, { rows: [{ id: row.id, linkDecision: 'link', matchedPartId: existing.id }] }, 'Tester')
    const r = await applyImport(b, id, 'Tester')
    expect(r.ok).toBe(false)
    expect((await getBatch(b, id))?.status).not.toBe('applied')
  })

  it('a new SKU already tracked on the job needs an explicit acknowledgement', async () => {
    const id = await order()
    await db.insert(jobParts).values({ serviceOrderId: id, description: 'Rotor', partNumber: 'NB-123', status: 'needed', supply: 'shop' })
    const b = await propose(id) // new row partNumber NB-123 matches
    const blocked = await applyImport(b, id, 'Tester')
    expect(blocked.needsDuplicateAck).toBe(true)
    const ok = await applyImport(b, id, 'Tester', { acknowledgeDuplicates: true })
    expect(ok.ok).toBe(true)
  })

  it('the SAME SKU repeated among NEW rows in one import needs an acknowledgement', async () => {
    const id = await order()
    const { batchId } = await createBatchWithImages({ orderId: id, captureId: null, images: images(1), uploadedBy: 'M', uploadedByKey: 'm' })
    const claim = await claimBatchReading(batchId)
    if (!claim.ok) throw new Error('claim')
    const r = (d: string) => ({ sourceImageId: claim.images[0].id, description: d, partNumber: 'DUP-1', brand: null, supplier: 'NAPA', quantity: 1, unitCostCents: 1000, listPriceCents: null, lineTotalCents: null })
    await applyExtraction(batchId, claim.token, { aiStatus: 'extracted', aiModel: 'm', aiRaw: null, documentKind: 'purchase', supplier: 'NAPA', orderReference: 'R', taxCents: null, shippingCents: null, coreCents: null, rows: [r('Rotor'), r('Rotor again')] })
    const blocked = await applyImport(batchId, id, 'Tester')
    expect(blocked.needsDuplicateAck).toBe(true)
    const ok = await applyImport(batchId, id, 'Tester', { acknowledgeDuplicates: true })
    expect(ok.ok).toBe(true)
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, id))).toHaveLength(2)
  })

  it.each([
    { label: 'quantity', patch: { quantity: '2' } },
    { label: 'order #', patch: { supplierOrderNumber: 'DIFFERENT-ORDER' } },
  ])('a conflicting linked $label is rejected with no partial write', async ({ patch }) => {
    const id = await order()
    const [target] = await db.insert(jobParts).values({ serviceOrderId: id, description: 'Rotor', quantity: '1', supply: 'shop', status: 'needed', supplier: 'NAPA', ...patch }).returning()
    const b = await propose(id) // import supplier NAPA, order REF-1, row qty 1
    const [row] = await db.select().from(partImportRows).where(eq(partImportRows.batchId, b))
    await saveBatchReview(b, id, { markOrdered: true, rows: [{ id: row.id, linkDecision: 'link', matchedPartId: target.id }] }, 'Tester')
    const r = await applyImport(b, id, 'Tester')
    expect(r.ok).toBe(false)
    expect((await getBatch(b, id))?.status).not.toBe('applied')
    const [after] = await db.select().from(jobParts).where(eq(jobParts.id, target.id))
    expect(after.importRowId).toBeNull()
  })

  it('concurrent same capture with different images returns a conflict for exactly one caller', async () => {
    const id = await order()
    const cap = '33333333-3333-4333-8333-333333333333'
    const [a, b] = await Promise.all([
      createBatchWithImages({ orderId: id, captureId: cap, images: images(1), uploadedBy: 'M', uploadedByKey: 'm' }),
      createBatchWithImages({ orderId: id, captureId: cap, images: images(1), uploadedBy: 'M', uploadedByKey: 'm' }),
    ])
    expect([a, b].filter((r) => r.conflict)).toHaveLength(1)
    expect(a.batchId).toBe(b.batchId)
    expect(await listBatchImages(a.batchId)).toHaveLength(1)
  })
})

describe('createBatchWithImages / saveBatchReview — conflict + duplicate-target rejection', () => {
  it('same capture id with a DIFFERENT screenshot set is flagged as a conflict', async () => {
    const id = await order()
    const cap = '22222222-2222-4222-8222-222222222222'
    await createBatchWithImages({ orderId: id, captureId: cap, images: images(1), uploadedBy: 'M', uploadedByKey: 'm' })
    const r = await createBatchWithImages({ orderId: id, captureId: cap, images: images(1), uploadedBy: 'M', uploadedByKey: 'm' })
    expect(r.conflict).toBe(true)
  })

  it('review rejects two rows linking the same existing part', async () => {
    const id = await order()
    const [p1] = await db.insert(jobParts).values({ serviceOrderId: id, description: 'X', status: 'needed', supply: 'shop' }).returning()
    const { batchId } = await createBatchWithImages({ orderId: id, captureId: null, images: images(1), uploadedBy: 'M', uploadedByKey: 'm' })
    const claim = await claimBatchReading(batchId)
    if (!claim.ok) throw new Error('claim')
    const mk = (d: string) => ({ sourceImageId: claim.images[0].id, description: d, partNumber: null, brand: null, supplier: null, quantity: 1, unitCostCents: null, listPriceCents: null, lineTotalCents: null })
    await applyExtraction(batchId, claim.token, { aiStatus: 'extracted', aiModel: 'm', aiRaw: null, documentKind: 'purchase', supplier: 'NAPA', orderReference: 'R', taxCents: null, shippingCents: null, coreCents: null, rows: [mk('A'), mk('B')] })
    const rows = await db.select().from(partImportRows).where(eq(partImportRows.batchId, batchId))
    const r = await saveBatchReview(batchId, id, { rows: rows.map((x) => ({ id: x.id, linkDecision: 'link' as const, matchedPartId: p1.id })) }, 'Tester')
    expect(r.ok).toBe(false)
  })
})

describe('applyImport — per-job transaction serializes concurrent DISTINCT imports (Dot race)', () => {
  // Two DISTINCT proposed batches on the SAME job, same SKU, NO supplier order reference. Before the lock,
  // both passed the per-batch guards; now the job row lock + fresh post-commit snapshot gates the loser.
  it('parallel distinct imports of the same unreferenced SKU apply exactly once', async () => {
    const id = await order()
    const a = await propose(id, {}, { orderReference: null })
    const b = await propose(id, {}, { orderReference: null })
    const results = await Promise.all([applyImport(a, id, 'A'), applyImport(b, id, 'B')])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.some((r) => !r.ok && r.needsDuplicateAck)).toBe(true)
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, id))).toHaveLength(1)
    // No partial / duplicate audit — exactly one apply event for the winner.
    expect(await db.select().from(serviceOrderEvents).where(eq(serviceOrderEvents.serviceOrderId, id))).toHaveLength(1)
  })

  it('the duplicate loser can then explicitly acknowledge and add the additional part', async () => {
    const id = await order()
    const a = await propose(id, {}, { orderReference: null })
    const b = await propose(id, {}, { orderReference: null })
    expect((await applyImport(a, id, 'A')).ok).toBe(true)
    const blocked = await applyImport(b, id, 'B')
    expect(blocked.ok).toBe(false); expect(blocked.needsDuplicateAck).toBe(true)
    const ack = await applyImport(b, id, 'B', { acknowledgeDuplicates: true })
    expect(ack.ok).toBe(true)
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, id))).toHaveLength(2)
  })

  it('distinct SKUs in parallel both apply (no false duplicate)', async () => {
    const id = await order()
    const a = await propose(id, { partNumber: 'SKU-A' }, { orderReference: null })
    const b = await propose(id, { partNumber: 'SKU-B' }, { orderReference: null })
    const results = await Promise.all([applyImport(a, id, 'A'), applyImport(b, id, 'B')])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, id))).toHaveLength(2)
  })

  it('parallel same supplier ORDER asks for CONFIRMATION (not acknowledgement) and applies once', async () => {
    const id = await order()
    const a = await propose(id) // supplier NAPA, orderReference REF-1 (same for both)
    const b = await propose(id)
    const results = await Promise.all([applyImport(a, id, 'A'), applyImport(b, id, 'B')])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const loser = results.find((r) => !r.ok)!
    expect(loser.needsDuplicateConfirm).toBe(true)
    expect(loser.needsDuplicateAck).toBeFalsy()
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, id))).toHaveLength(1)
  })

  it('the SKU lock is per-job: the same SKU on two different jobs both apply', async () => {
    const j1 = await order(); const j2 = await order()
    const a = await propose(j1, {}, { orderReference: null })
    const b = await propose(j2, {}, { orderReference: null })
    const results = await Promise.all([applyImport(a, j1, 'A'), applyImport(b, j2, 'B')])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, j1))).toHaveLength(1)
    expect(await db.select().from(jobParts).where(eq(jobParts.serviceOrderId, j2))).toHaveLength(1)
  })
})
