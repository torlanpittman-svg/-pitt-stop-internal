/**
 * REAL Postgres (PGlite, the app's actual schema) tests for "Assign to Auto Sales Vehicle":
 * a receipt assigned on the Receipts page shows under the vehicle and counts in its investment/profit WITHOUT a
 * second financial record; matching it to an expense already typed on the vehicle counts once; returns against
 * it reduce the investment and stay traceable; changing/removing the assignment moves the totals; the receipt
 * totals the CFO page reads never move.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as appSchema from '@/drizzle/schema'
import * as financeSchema from '@/apps/finance/schema'

const schema = { ...appSchema, ...financeSchema }
const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/platform/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { createReceipt, fileReceipt, getReceipt, rejectReceipt, monthlyExpenseReport, listInventoryVehiclesForPicker } from './db'
import { allocateReceipt } from './job-expenses'
import { setReceiptVehicle, vehicleExpenseCandidates, receiptVehicleViews, resolveVehicleMatch, describeVehicleMatchRisk } from './vehicle-link'
import { clearLink, decideLink, vehicleMatchRiskById } from '@/apps/finance/purchase-links'
import { getOwnerReconciliation } from '@/apps/finance/reconcile-links'
import { getReconciliation } from './reconcile'
import { createAcquisition, addExpenseEvent, addReturnRefund, getVehicleFolder, getInventoryList, getReturnableExpenses, removeVehicleExpense, reverseEvent, recordSale } from '@/apps/auto-sales/db'
import { loadMonthlyReport } from '@/apps/auto-sales/report-db'
import { isReceiptEvent } from '@/apps/auto-sales/receipt-expenses'
import type { CategoryChoice } from './types'

let db: PgliteDatabase<typeof schema>
const actor = { name: 'Torlan', key: 'torlan' }
const single = (key: string): CategoryChoice => ({ kind: 'single', key: key as never })
const count = async (t: string, where = 'true') => Number(((await db.execute(sql.raw(`SELECT count(*)::int n FROM ${t} WHERE ${where}`))) as unknown as { rows: { n: number }[] }).rows[0].n)

let n = 0
/** A receipt; `file` false leaves it in "needs attention". */
async function receipt(totalCents: number, file: Record<string, unknown> | false = {}) {
  n++
  const { id } = await createReceipt({
    storage: 'blob_private', storageRef: `business-receipts/v${n}.jpg`, filename: 'r.jpg', contentType: 'image/jpeg', imageHash: `vh${n}`, byteSize: 100,
    aiStatus: 'extracted', aiModel: 'gpt-4o', aiRaw: {}, aiExtracted: {}, confidence: {}, uploadedBy: 'Torlan', uploadedByKey: 'torlan',
    vendor: 'O’Reilly', receiptDate: '2026-11-10', totalCents, entity: 'auto_sales', category: 'parts',
  } as never)
  if (file !== false) {
    await fileReceipt(id, { entity: 'auto_sales', category: single('parts'), funding: 'business', paymentMethod: 'card', accountRef: '*5600', paymentLast4: '0320',
      vendor: 'O’Reilly', receiptDate: '2026-11-10', totalCents, ...file } as never, actor)
  }
  return id
}
async function vehicle(acqCents: number, ymm: [string, string, string]) {
  const r = await createAcquisition({ vin: null, year: ymm[0], make: ymm[1], model: ymm[2], acquisitionCostCents: acqCents, acquiredAt: '2026-11-01', actor: 'Torlan' })
  return r.inventoryVehicleId
}
const invested = async (vehicleId: string) => (await getVehicleFolder(vehicleId))!.summary.knownInvestmentCents
const lines = async (vehicleId: string) => (await getVehicleFolder(vehicleId))!.events.filter(isReceiptEvent)
const receiptTotals = async () => { const rep = await monthlyExpenseReport('2026-11'); return { count: rep.complete.length, cents: rep.complete.reduce((t, r) => t + (r.totalCents ?? 0), 0) } }

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
  // The confirmed-match uniqueness lives in migration 0079 (not in the drizzle table definition) — apply the real SQL.
  const mig = readFileSync(fileURLToPath(new URL('../../drizzle/migrations/manual/0079_purchase_links.sql', import.meta.url)), 'utf8')
  for (const stmt of mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter((s) => /^CREATE UNIQUE INDEX IF NOT EXISTS purchase_links_/.test(s))) await db.execute(sql.raw(stmt))
}, 120_000)

describe('assigning a receipt to an Auto Sales vehicle', () => {
  it('a new filed receipt shows under the vehicle and raises its investment — with no second financial record', async () => {
    const a = await vehicle(500_000, ['2017', 'Jeep', 'Wrangler'])
    const id = await receipt(12_345)
    const before = { events: await count('vehicle_financial_events'), receipts: await count('business_receipts'), totals: await receiptTotals() }
    expect(await invested(a)).toBe(500_000)

    const r = await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    expect(r.ok).toBe(true)
    const folder = (await getVehicleFolder(a))!
    const line = folder.events.find((e) => e.id === id)!
    expect(line).toMatchObject({ source: 'business_receipt', amountCents: 12_345, status: 'verified', economicCategory: 'part', vendor: 'O’Reilly', eventDate: '2026-11-10' })
    expect(folder.receiptLineIds).toEqual([id])
    expect(folder.summary.knownInvestmentCents).toBe(512_345)
    expect(folder.attachments[id]).toMatchObject({ documentId: id, managerOnly: true, url: `/api/expenses/receipt/${id}/image` })
    // Nothing was written to the vehicle ledger and no receipt was added: one purchase, one record.
    expect(await count('vehicle_financial_events')).toBe(before.events)
    expect(await count('business_receipts')).toBe(before.receipts)
    // What the CFO/receipt reports read is unchanged by the assignment.
    expect(await receiptTotals()).toEqual(before.totals)
    // Inventory list + monthly accountant report use the same merged cost.
    expect((await getInventoryList()).find((v) => v.id === a)!.summary.knownInvestmentCents).toBe(512_345)
    // Audit trail on the receipt.
    const audit = (await getReceipt(id))!.auditLog as { action: string }[]
    expect(audit.filter((x) => x.action === 'vehicle_assigned')).toHaveLength(1)
  })

  it('repeating the same assignment is a no-op (no duplicate line, no second audit entry)', async () => {
    const a = await vehicle(100_000, ['2014', 'Toyota', 'Camry'])
    const id = await receipt(5_000)
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    const again = await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    expect(again).toMatchObject({ ok: true, already: true })
    expect(await lines(a)).toHaveLength(1)
    expect(await invested(a)).toBe(105_000)
    expect(((await getReceipt(id))!.auditLog as { action: string }[]).filter((x) => x.action === 'vehicle_assigned')).toHaveLength(1)
  })

  it('a receipt that still needs attention is listed as pending and NOT counted until it is filed', async () => {
    const a = await vehicle(200_000, ['2011', 'Nissan', 'Xterra'])
    const id = await receipt(7_500, false)
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    let folder = (await getVehicleFolder(a))!
    expect(folder.events.find((e) => e.id === id)!.status).toBe('unverified')
    expect(folder.summary.knownInvestmentCents).toBe(200_000)
    expect(folder.summary.unverifiedAdditionalCents).toBe(7_500)
    await fileReceipt(id, { entity: 'auto_sales', category: single('parts'), funding: 'business', paymentMethod: 'card', accountRef: '*5600', paymentLast4: '0320', vendor: 'O’Reilly', receiptDate: '2026-11-10', totalCents: 7_500 } as never, actor)
    folder = (await getVehicleFolder(a))!
    expect((await getReceipt(id))!.inventoryVehicleId).toBe(a)   // filing keeps the assignment
    expect(folder.summary.knownInvestmentCents).toBe(207_500)
  })

  it('an EXISTING filed receipt can be assigned later, moved from vehicle A to B, and removed — totals follow', async () => {
    const a = await vehicle(300_000, ['2015', 'Chrysler', '200'])
    const b = await vehicle(400_000, ['2015', 'Nissan', 'Frontier'])
    const id = await receipt(20_000)          // filed first, assigned afterwards
    expect((await getReceipt(id))!.status).toBe('filed')
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    expect([await invested(a), await invested(b)]).toEqual([320_000, 400_000])

    const moved = await setReceiptVehicle({ receiptId: id, inventoryVehicleId: b }, actor)
    expect(moved).toMatchObject({ ok: true, previousVehicleId: a, inventoryVehicleId: b })
    expect([await invested(a), await invested(b)]).toEqual([300_000, 420_000])
    expect(await lines(a)).toHaveLength(0)
    expect(await lines(b)).toHaveLength(1)

    const removed = await setReceiptVehicle({ receiptId: id, inventoryVehicleId: null }, actor)
    expect(removed.ok).toBe(true)
    expect([await invested(a), await invested(b)]).toEqual([300_000, 400_000])
    const row = (await getReceipt(id))!
    expect(row.status).toBe('filed')           // the receipt itself is untouched
    expect(row.inventoryVehicleId).toBeNull()
    expect((row.auditLog as { action: string }[]).map((x) => x.action).filter((x) => x.startsWith('vehicle_'))).toEqual(['vehicle_assigned', 'vehicle_assigned', 'vehicle_removed'])
  })

  it('a receipt saved without a vehicle changes no vehicle', async () => {
    const a = await vehicle(150_000, ['2009', 'Infiniti', 'FX35'])
    await receipt(9_999)
    expect(await invested(a)).toBe(150_000)
    expect(await lines(a)).toHaveLength(0)
  })

  it('a rejected receipt drops off the vehicle', async () => {
    const a = await vehicle(100_000, ['2001', 'Lexus', 'LS430'])
    const id = await receipt(4_000, false)
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    expect(await lines(a)).toHaveLength(1)
    await rejectReceipt(id, 'not ours', 'Torlan')
    expect(await lines(a)).toHaveLength(0)
    expect(await invested(a)).toBe(100_000)
  })

  it('profit on a sold vehicle reflects a receipt assigned after the sale', async () => {
    const a = await vehicle(500_000, ['2005', 'Chevrolet', 'Silverado'])
    await recordSale({ inventoryVehicleId: a, saleDate: '2026-11-12', salePriceCents: 800_000, proceedsReceived: 'yes', actor: 'Torlan' })
    expect((await getVehicleFolder(a))!.result.indicativeProfitCents).toBe(300_000)
    const id = await receipt(25_000)
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    expect((await getVehicleFolder(a))!.result.indicativeProfitCents).toBe(275_000)
    const report = await loadMonthlyReport('2026-11')
    expect(JSON.stringify(report)).toContain('275000')
    expect((await listInventoryVehiclesForPicker()).find((v) => v.id === a)).toMatchObject({ sold: true })
  })
})

describe('the same purchase was already typed on the vehicle', () => {
  it('matching the receipt to that expense counts it once and leaves the original entry untouched', async () => {
    const a = await vehicle(600_000, ['2008', 'Toyota', '4Runner'])
    const manual = await addExpenseEvent({ inventoryVehicleId: a, economicCategory: 'part', amountCents: 8_021, eventDate: '2026-11-11', vendor: 'OReilly', actor: 'Tony' })
    const id = await receipt(8_021)
    expect(await invested(a)).toBe(608_021)

    const cands = await vehicleExpenseCandidates(a, { amountCents: 8_021, date: '2026-11-10', receiptId: id })
    expect(cands).toHaveLength(1)
    expect(cands[0]).toMatchObject({ eventId: manual, likely: true })

    // Without the match the reconcile screen flags the pair as a possible double entry…
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    expect(await invested(a)).toBe(616_042)
    const flagged = await getReconciliation({ today: '2026-11-19', includeBank: false })
    expect(JSON.stringify(flagged)).toContain(`${id}:veh:${manual}`)

    // …and matching it resolves that: one line, original amount, receipt attached to it.
    const eventsBefore = await count('vehicle_financial_events')
    const r = await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a, matchEventId: manual }, actor)
    expect(r.ok).toBe(true)
    const folder = (await getVehicleFolder(a))!
    expect(folder.summary.knownInvestmentCents).toBe(608_021)
    expect(folder.events.filter(isReceiptEvent)).toHaveLength(0)
    expect(folder.matchedReceiptIds).toEqual({ [manual]: id })
    expect(folder.attachments[manual]).toMatchObject({ documentId: id, managerOnly: true })
    expect(await count('vehicle_financial_events')).toBe(eventsBefore)                       // history preserved, nothing appended
    expect(folder.events.find((e) => e.id === manual)).toMatchObject({ amountCents: 8_021, vendor: 'OReilly', createdBy: 'Tony', status: 'verified' })
    expect(JSON.stringify(await getReconciliation({ today: '2026-11-19', includeBank: false }))).not.toContain(`${id}:veh:${manual}`)
    expect((await receiptVehicleViews([id])).get(id)).toMatchObject({ inventoryVehicleId: a, matchedEventId: manual })

    // A second receipt cannot claim the same vehicle expense, and it is no longer offered.
    const other = await receipt(8_021)
    expect(await vehicleExpenseCandidates(a, { amountCents: 8_021, date: '2026-11-10', receiptId: other })).toHaveLength(0)
    const clash = await setReceiptVehicle({ receiptId: other, inventoryVehicleId: a, matchEventId: manual }, actor)
    expect(clash.ok).toBe(false)
    expect((await getReceipt(other))!.inventoryVehicleId).toBeNull()

    // Removing the vehicle from the receipt undoes the match (kept as history) and the typed expense still counts.
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: null }, actor)
    expect(await invested(a)).toBe(608_021)
    expect(await count('purchase_links', `a_id = '${id}' AND status = 'confirmed'`)).toBe(0)
    expect(await count('purchase_links', `a_id = '${id}' AND status = 'cleared'`)).toBe(1)
  })

  it('a matched vehicle expense cannot be removed or undone until its receipt is resolved — then it comes off exactly once', async () => {
    const a = await vehicle(100_000, ['2012', 'Honda', 'Civic'])
    const manual = await addExpenseEvent({ inventoryVehicleId: a, economicCategory: 'part', amountCents: 3_000, eventDate: '2026-11-10', vendor: 'NAPA', actor: 'Tony' })
    const id = await receipt(3_000)
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a, matchEventId: manual }, actor)
    expect(await invested(a)).toBe(103_000)
    const eventsBefore = await count('vehicle_financial_events')

    // Server-side refusal (manager Remove) and the admin "undo" are both blocked; nothing is appended.
    const refused = await removeVehicleExpense({ eventId: manual, actor: 'Torlan' })
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/receipt from the Receipts page/i) })
    await reverseEvent(manual, 'Torlan')
    expect(await count('vehicle_financial_events')).toBe(eventsBefore)
    expect(await invested(a)).toBe(103_000)
    expect(await lines(a)).toHaveLength(0)                       // still one line, not two

    // Resolve the receipt first (take it off the vehicle) → the typed expense still counts once…
    expect((await setReceiptVehicle({ receiptId: id, inventoryVehicleId: null }, actor)).ok).toBe(true)
    expect(await invested(a)).toBe(103_000)
    // …and can now be removed: the vehicle drops by exactly that one purchase, and no receipt line appears.
    expect((await removeVehicleExpense({ eventId: manual, actor: 'Torlan' })).ok).toBe(true)
    expect(await invested(a)).toBe(100_000)
    expect(await lines(a)).toHaveLength(0)
  })

  it('assigning a vehicle never rewrites the receipt (category, business, total) or any existing ledger row', async () => {
    const a = await vehicle(250_000, ['2018', 'Honda', 'Accord'])
    await addExpenseEvent({ inventoryVehicleId: a, economicCategory: 'transport', amountCents: 15_000, eventDate: '2026-11-03', vendor: 'Tow Co', actor: 'Tony' })
    const snapshot = async () => JSON.stringify(((await db.execute(sql.raw(`SELECT id, inventory_vehicle_id, economic_category, cashflow_category, accounting_treatment, amount_cents, event_date, status, source FROM vehicle_financial_events ORDER BY id`))) as unknown as { rows: unknown[] }).rows)
    const ledgerBefore = await snapshot()
    const id = await receipt(4_321, { category: single('fuel'), entity: 'shared' })
    const before = (await getReceipt(id))!
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    const after = (await getReceipt(id))!
    expect({ category: after.category, entity: after.entity, totalCents: after.totalCents, status: after.status, qb: after.qbSyncStatus, funding: after.funding })
      .toEqual({ category: before.category, entity: before.entity, totalCents: before.totalCents, status: before.status, qb: before.qbSyncStatus, funding: before.funding })
    expect(after.category).toBe('fuel')                           // the vehicle bucket ("other") is display-only
    expect(await snapshot()).toBe(ledgerBefore)
    expect((await getVehicleFolder(a))!.events.find((e) => e.id === id)!.economicCategory).toBe('other')
    expect(await invested(a)).toBe(269_321)
  })
})

describe('returns against a receipt-backed expense', () => {
  it('reduce the investment, stay linked to the original purchase, and pin the assignment', async () => {
    const a = await vehicle(700_000, ['2016', 'Ford', 'F-150'])
    const b = await vehicle(100_000, ['2013', 'Kia', 'Soul'])
    const id = await receipt(10_000)
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    expect((await getReturnableExpenses(a)).find((x) => x.id === id)).toMatchObject({ amountCents: 10_000, remainingCents: 10_000 })

    const ret = await addReturnRefund({ inventoryVehicleId: a, originalEventId: id, econ: 'refund', refundMethod: 'card', cash: true, amountCents: 4_000, eventDate: '2026-11-14', refundStatus: 'pending', actor: 'Torlan' })
    expect(ret.ok).toBe(true)
    const folder = (await getVehicleFolder(a))!
    expect(folder.summary.knownInvestmentCents).toBe(706_000)             // 700,000 + 10,000 − 4,000
    const row = folder.events.find((e) => e.id === ret.eventId)!
    expect(row).toMatchObject({ originalEventId: id, economicCategory: 'refund', vendor: 'O’Reilly' })
    expect((row.evidence as { originalReceiptId?: string }).originalReceiptId).toBe(id)
    expect((await getReturnableExpenses(a)).find((x) => x.id === id)).toMatchObject({ returnedCents: 4_000, remainingCents: 6_000 })

    // Cannot return more than is left, and cannot return it from a different vehicle.
    expect((await addReturnRefund({ inventoryVehicleId: a, originalEventId: id, econ: 'refund', refundMethod: 'card', cash: true, amountCents: 7_000, eventDate: '2026-11-15', refundStatus: 'pending', actor: 'Torlan' })).ok).toBe(false)
    expect((await addReturnRefund({ inventoryVehicleId: b, originalEventId: id, econ: 'refund', refundMethod: 'card', cash: true, amountCents: 1_000, eventDate: '2026-11-15', refundStatus: 'pending', actor: 'Torlan' })).ok).toBe(false)

    // The return must never be left pointing at nothing: no move, no remove while it stands.
    expect((await setReceiptVehicle({ receiptId: id, inventoryVehicleId: b }, actor)).ok).toBe(false)
    expect((await setReceiptVehicle({ receiptId: id, inventoryVehicleId: null }, actor)).ok).toBe(false)
    expect((await getReceipt(id))!.inventoryVehicleId).toBe(a)
    expect((await receiptVehicleViews([id])).get(id)!.hasReturns).toBe(true)
    expect(await invested(b)).toBe(100_000)
  })
})

describe('a purchase belongs to a customer job OR a sales vehicle', () => {
  it('refuses the second assignment in either order', async () => {
    const a = await vehicle(100_000, ['2010', 'Mazda', '3'])
    const v = (await db.execute(sql.raw(`INSERT INTO vehicles(year,make,model) VALUES('2020','Tesla','Model 3') RETURNING id`))) as unknown as { rows: { id: string }[] }
    const o = (await db.execute(sql.raw(`INSERT INTO service_orders(order_number,vehicle_id,customer_name) VALUES('SO-20261119-0001','${v.rows[0].id}','Pat Sample') RETURNING id`))) as unknown as { rows: { id: string }[] }
    const jobId = o.rows[0].id

    const onJob = await receipt(2_000)
    expect((await allocateReceipt({ receiptId: onJob, target: 'job', serviceOrderId: jobId, amountCents: null }, actor)).ok).toBe(true)
    expect((await setReceiptVehicle({ receiptId: onJob, inventoryVehicleId: a }, actor)).ok).toBe(false)

    const onVehicle = await receipt(2_500)
    await setReceiptVehicle({ receiptId: onVehicle, inventoryVehicleId: a }, actor)
    expect((await allocateReceipt({ receiptId: onVehicle, target: 'job', serviceOrderId: jobId, amountCents: null }, actor)).ok).toBe(false)
    expect(await invested(a)).toBe(102_500)
  })

  it('refuses a vehicle that does not exist', async () => {
    const id = await receipt(1_000)
    expect((await setReceiptVehicle({ receiptId: id, inventoryVehicleId: '00000000-0000-4000-8000-000000000000' }, actor)).ok).toBe(false)
  })
})

describe('undoing a match that keeps one purchase from counting twice on a vehicle (Finance reconcile)', () => {
  const linkOf = async (receiptId: string) => ((await db.execute(sql.raw(`SELECT id FROM purchase_links WHERE a_id = '${receiptId}' AND status = 'confirmed'`))) as unknown as { rows: { id: string }[] }).rows[0]?.id
  const linkStatuses = async (receiptId: string) => ((await db.execute(sql.raw(`SELECT status FROM purchase_links WHERE a_id = '${receiptId}' ORDER BY decided_at, status`))) as unknown as { rows: { status: string }[] }).rows.map((r) => r.status).sort()
  const auditActions = async (receiptId: string) => ((await getReceipt(receiptId))!.auditLog as { action: string }[]).map((x) => x.action)
  const ownerView = () => getOwnerReconciliation({ today: '2026-11-19', days: 60 })
  /** A vehicle with one typed expense and a filed receipt matched to it (counted once). */
  async function matched(acq: number, typedCents: number, receiptCents = typedCents, ymm: [string, string, string] = ['2019', 'Subaru', 'Outback']) {
    const a = await vehicle(acq, ymm)
    const manual = await addExpenseEvent({ inventoryVehicleId: a, economicCategory: 'part', amountCents: typedCents, eventDate: '2026-11-10', vendor: 'NAPA', actor: 'Tony' })
    const id = await receipt(receiptCents)
    expect((await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a, matchEventId: manual }, actor)).ok).toBe(true)
    return { a, manual, id, linkId: (await linkOf(id))! }
  }

  it('a plain undo, a "not the same", and every assignment shortcut are REFUSED — nothing is separated silently', async () => {
    const { a, manual, id, linkId } = await matched(100_000, 5_000)
    const b = await vehicle(50_000, ['2010', 'Ford', 'Focus'])
    const before = { events: await count('vehicle_financial_events'), finEvents: await count('fin_events'), totals: await receiptTotals() }
    expect(await invested(a)).toBe(105_000)
    expect(await vehicleMatchRiskById(linkId)).toMatchObject({ receiptId: id, eventId: manual, inventoryVehicleId: a, receiptCents: 5_000, eventCents: 5_000 })

    // Finance reconcile "Undo this match" (and any direct call to it)
    expect(await clearLink(linkId, 'admin')).toMatchObject({ ok: false, needsResolution: true, error: expect.stringMatching(/count the purchase twice/i) })
    // Finance reconcile "Not the same" posted for the same pair
    expect(await decideLink({ kind: 'receipt_vehicle_event', aId: id, bId: manual, status: 'dismissed', actor: 'admin' })).toMatchObject({ ok: false, needsResolution: true })
    // Receipts-side shortcuts: un-match in place, re-point to another vehicle
    expect((await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a, matchEventId: null }, actor)).ok).toBe(false)
    expect((await setReceiptVehicle({ receiptId: id, inventoryVehicleId: b }, actor)).ok).toBe(false)
    // An unknown / missing resolution is not a resolution
    expect((await resolveVehicleMatch(linkId, 'whatever' as never, actor)).ok).toBe(false)

    expect(await linkStatuses(id)).toEqual(['confirmed'])
    expect(await invested(a)).toBe(105_000)
    expect(await invested(b)).toBe(50_000)
    expect(await lines(a)).toHaveLength(0)
    expect(await count('vehicle_financial_events')).toBe(before.events)
    expect(await count('fin_events')).toBe(before.finEvents)            // a refused undo writes no audit of a change
    expect(await receiptTotals()).toEqual(before.totals)
    expect((await getReceipt(id))!.inventoryVehicleId).toBe(a)
  })

  it('Keep matched: nothing changes and the purchase keeps counting once', async () => {
    const { a, id, linkId } = await matched(200_000, 6_000)
    const before = { events: await count('vehicle_financial_events'), finEvents: await count('fin_events'), audit: await auditActions(id) }
    expect(await resolveVehicleMatch(linkId, 'keep_matched', actor)).toMatchObject({ ok: true, resolution: 'keep_matched' })
    expect(await invested(a)).toBe(206_000)
    expect(await linkStatuses(id)).toEqual(['confirmed'])
    expect(await count('vehicle_financial_events')).toBe(before.events)
    expect(await count('fin_events')).toBe(before.finEvents)
    expect(await auditActions(id)).toEqual(before.audit)
    expect((await ownerView()).confirmed.some((c) => c.linkId === linkId)).toBe(true)
  })

  it('Different purchases: only an explicit confirmation lets both count — recorded, and never suggested again', async () => {
    const { a, manual, id, linkId } = await matched(300_000, 7_000)
    const cfoBefore = await receiptTotals()
    const eventsBefore = await count('vehicle_financial_events')
    expect(await resolveVehicleMatch(linkId, 'different_purchases', actor)).toMatchObject({ ok: true, resolution: 'different_purchases' })

    const folder = (await getVehicleFolder(a))!
    expect(folder.summary.knownInvestmentCents).toBe(314_000)             // 300,000 + typed 7,000 + receipt 7,000
    expect(folder.events.filter(isReceiptEvent).map((e) => e.id)).toEqual([id])
    expect(folder.events.find((e) => e.id === manual)).toMatchObject({ amountCents: 7_000, status: 'verified' })   // typed expense untouched
    expect(await count('vehicle_financial_events')).toBe(eventsBefore)     // no ledger row written or removed
    expect(await receiptTotals()).toEqual(cfoBefore)                       // receipt totals (CFO) unchanged
    // History kept: the confirmed row is cleared, a "not the same" decision is the live one.
    expect(await linkStatuses(id)).toEqual(['cleared', 'dismissed'])
    expect(await auditActions(id)).toContain('vehicle_match_resolved')
    expect(await count('fin_events', `entity = 'purchase_link' AND action = 'dismiss' AND after->>'vehicleSplit' = 'different_purchases'`)).toBeGreaterThanOrEqual(1)
    // Finance reconcile reflects it: not a confirmed match, not re-suggested, not flagged as a possible double entry.
    const o = await ownerView()
    expect(o.confirmed.some((c) => c.a.id === id)).toBe(false)
    expect(o.suggestions.some((x) => x.a.id === id && x.b.id === manual)).toBe(false)
    expect(JSON.stringify(await getReconciliation({ today: '2026-11-19', includeBank: false }))).not.toContain(`${id}:veh:${manual}`)
    // Refunds/returns keep working against either purchase.
    expect((await addReturnRefund({ inventoryVehicleId: a, originalEventId: id, econ: 'refund', refundMethod: 'card', cash: true, amountCents: 1_000, eventDate: '2026-11-14', refundStatus: 'pending', actor: 'Torlan' })).ok).toBe(true)
    expect((await addReturnRefund({ inventoryVehicleId: a, originalEventId: manual, econ: 'refund', refundMethod: 'card', cash: true, amountCents: 2_000, eventDate: '2026-11-14', refundStatus: 'pending', actor: 'Torlan' })).ok).toBe(true)
    expect(await invested(a)).toBe(311_000)
  })

  it('Remove duplicate entry: the typed expense is reversed (kept in history), the receipt carries the purchase — still once', async () => {
    const { a, manual, id, linkId } = await matched(400_000, 8_000, 8_250)   // receipt shows the true total
    const cfoBefore = await receiptTotals()
    expect(await invested(a)).toBe(408_000)
    expect(await describeVehicleMatchRisk((await vehicleMatchRiskById(linkId))!)).toMatchObject({ canRemoveDuplicate: true, removeBlockedWhy: null })
    expect(await resolveVehicleMatch(linkId, 'remove_duplicate', actor)).toMatchObject({ ok: true, resolution: 'remove_duplicate' })

    const folder = (await getVehicleFolder(a))!
    expect(folder.summary.knownInvestmentCents).toBe(408_250)             // once, at the receipt's amount
    expect(folder.events.filter(isReceiptEvent).map((e) => e.id)).toEqual([id])
    // Existing correction workflow: original row untouched + ONE appended reversing adjustment with an audit.
    const orig = folder.events.find((e) => e.id === manual)!
    expect(orig).toMatchObject({ amountCents: 8_000, status: 'verified', createdBy: 'Tony' })
    const reversals = folder.events.filter((e) => e.reversesEventId === manual)
    expect(reversals).toHaveLength(1)
    expect(reversals[0]).toMatchObject({ economicCategory: 'adjustment', amountCents: 8_000, createdBy: 'Torlan' })
    expect((reversals[0].evidence as { removal: Record<string, unknown> }).removal).toMatchObject({ reason: 'duplicate_of_receipt', duplicateOfReceiptId: id, originalEventId: manual, removedBy: 'Torlan' })
    expect(await receiptTotals()).toEqual(cfoBefore)
    expect(await linkStatuses(id)).toEqual(['cleared'])
    expect(await auditActions(id)).toContain('vehicle_match_resolved')
    expect(await count('fin_events', `entity = 'purchase_link' AND action = 'clear' AND after->>'vehicleSplit' = 'duplicate_removed'`)).toBeGreaterThanOrEqual(1)
    // Finance reconcile: no confirmed match left, the removed line is neither suggested nor flagged.
    const o = await ownerView()
    expect(o.confirmed.some((c) => c.a.id === id)).toBe(false)
    expect(o.suggestions.some((x) => x.a.id === id)).toBe(false)
    expect(JSON.stringify(await getReconciliation({ today: '2026-11-19', includeBank: false }))).not.toContain(`${id}:veh:${manual}`)
    // Repeating it cannot remove anything else, and returns work against the receipt-backed line.
    expect((await resolveVehicleMatch(linkId, 'remove_duplicate', actor)).ok).toBe(false)
    expect(await invested(a)).toBe(408_250)
    expect((await addReturnRefund({ inventoryVehicleId: a, originalEventId: id, econ: 'refund', refundMethod: 'card', cash: true, amountCents: 250, eventDate: '2026-11-14', refundStatus: 'pending', actor: 'Torlan' })).ok).toBe(true)
    expect(await invested(a)).toBe(408_000)
  })

  it('profit on a sold vehicle follows each resolution exactly', async () => {
    const { a, linkId } = await matched(500_000, 10_000)
    await recordSale({ inventoryVehicleId: a, saleDate: '2026-11-15', salePriceCents: 700_000, proceedsReceived: 'yes', actor: 'Torlan' })
    const profit = async () => (await getVehicleFolder(a))!.result.indicativeProfitCents
    expect(await profit()).toBe(190_000)
    await clearLink(linkId, 'admin')                                      // refused → unchanged
    expect(await profit()).toBe(190_000)
    await resolveVehicleMatch(linkId, 'different_purchases', actor)
    expect(await profit()).toBe(180_000)
  })

  it('Remove duplicate is refused when the typed expense has a return against it (the return is never orphaned)', async () => {
    const a = await vehicle(100_000, ['2015', 'GMC', 'Sierra'])
    const manual = await addExpenseEvent({ inventoryVehicleId: a, economicCategory: 'part', amountCents: 9_000, eventDate: '2026-11-10', vendor: 'NAPA', actor: 'Tony' })
    await addReturnRefund({ inventoryVehicleId: a, originalEventId: manual, econ: 'refund', refundMethod: 'card', cash: true, amountCents: 1_000, eventDate: '2026-11-12', refundStatus: 'pending', actor: 'Torlan' })
    const id = await receipt(9_000)
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a, matchEventId: manual }, actor)
    const linkId = (await linkOf(id))!
    expect(await describeVehicleMatchRisk((await vehicleMatchRiskById(linkId))!)).toMatchObject({ canRemoveDuplicate: false })
    expect(await resolveVehicleMatch(linkId, 'remove_duplicate', actor)).toMatchObject({ ok: false, error: expect.stringMatching(/return or refund/i) })
    expect(await invested(a)).toBe(108_000)
    expect(await linkStatuses(id)).toEqual(['confirmed'])
  })

  it('matches that are NOT protecting a vehicle total still undo normally', async () => {
    // receipt not assigned to any vehicle, matched to a vehicle expense by the owner on the reconcile page
    const a = await vehicle(100_000, ['2014', 'Hyundai', 'Sonata'])
    const manual = await addExpenseEvent({ inventoryVehicleId: a, economicCategory: 'part', amountCents: 1_500, eventDate: '2026-11-10', vendor: 'NAPA', actor: 'Tony' })
    const id = await receipt(1_500)
    const made = await decideLink({ kind: 'receipt_vehicle_event', aId: id, bId: manual, status: 'confirmed', actor: 'admin' })
    expect(made.ok).toBe(true)
    expect(await vehicleMatchRiskById(made.id!)).toBeNull()
    expect((await clearLink(made.id!, 'admin')).ok).toBe(true)
    expect(await invested(a)).toBe(101_500)
    // …and taking a matched receipt off its vehicle (Receipts → Remove) still works and still counts once.
    const m = await matched(100_000, 2_000)
    expect((await setReceiptVehicle({ receiptId: m.id, inventoryVehicleId: null }, actor)).ok).toBe(true)
    expect(await invested(m.a)).toBe(102_000)
    expect(await linkStatuses(m.id)).toEqual(['cleared'])
  })

  it('the reconcile page cannot match a receipt that has a return recorded against its own vehicle line', async () => {
    const a = await vehicle(100_000, ['2016', 'Mazda', 'CX-5'])
    const manual = await addExpenseEvent({ inventoryVehicleId: a, economicCategory: 'part', amountCents: 4_000, eventDate: '2026-11-10', vendor: 'NAPA', actor: 'Tony' })
    const id = await receipt(4_000)
    await setReceiptVehicle({ receiptId: id, inventoryVehicleId: a }, actor)
    await addReturnRefund({ inventoryVehicleId: a, originalEventId: id, econ: 'refund', refundMethod: 'card', cash: true, amountCents: 500, eventDate: '2026-11-12', refundStatus: 'pending', actor: 'Torlan' })
    expect((await decideLink({ kind: 'receipt_vehicle_event', aId: id, bId: manual, status: 'confirmed', actor: 'admin' })).ok).toBe(false)
    expect(await invested(a)).toBe(107_500)
  })
})
