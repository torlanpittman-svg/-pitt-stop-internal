/**
 * Shared retail invoice — pure rules: combining per-job segments never recalculates money (each Job keeps its
 * own fees / rounding; the combined total is exactly the sum), a single-job invoice is byte-identical to today's,
 * the line fingerprint detects QuickBooks-side edits, and the eligibility rules refuse paid / voided / dealer /
 * already-invoiced cases.
 */
import { describe, it, expect } from 'vitest'
import {
  combineSharedPayload, linesFromRawInvoice, linesFromPayload, linesFingerprint, sameLines,
  invoiceMoneyState, overwriteUnsafeLineTypes, anchorLocalBlock, memberLocalBlock, vehicleHeader, type SharedSegment,
} from './shared-invoice-plan'
import { buildRetailPayload, RetailTotalMismatchError } from './retail-invoice'
import { extractPsid } from './retail-format'
import { computeFees, effectiveFeeConfig, explicitPretaxTotals, type FeeConfig } from '@/apps/workflow/fees'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const FEES: FeeConfig = { shopSuppliesEnabled: true, shopSuppliesBps: 300, shopSuppliesCapCents: 2000, paymentEnabled: true, paymentBps: 300, paymentLabel: 'Card Payment', paymentBasis: 'work_plus_supplies' }

/** A Job's segment built exactly like Create: the real fee engine + the real per-job payload builder. */
function jobSegment(estimateId: string, workCents: number, vehicle: SharedSegment['vehicle'], waive: { waivePayment?: boolean; waiveShopSupplies?: boolean } = {}): SharedSegment {
  const t = explicitPretaxTotals(workCents, effectiveFeeConfig(FEES, { isDealer: false, ...waive }), 0, 'detailing')
  const p = buildRetailPayload({
    estimateId, vehicle, feesItemId: 'FEES', paymentLabel: 'Card Payment', shopSuppliesLabel: 'Shop supplies',
    workServices: [{ itemId: 'LABOR', description: 'Full Detail', amountCents: t.workPriceCents }],
    shopSuppliesCents: t.shopSuppliesCents, paymentChargeCents: t.paymentChargeCents, expectedTotalCents: t.totalCents,
  })
  return { estimateId, vehicle, totalCents: t.totalCents, lines: p.lines }
}
const civic = { year: '2019', make: 'Honda', model: 'Civic', vin: '1HGCV1F30KA000001' }
const f150 = { year: '2018', make: 'Ford', model: 'F-150', vin: null, licensePlate: 'ABC1234' }

describe('combineSharedPayload — money is concatenated, never recalculated', () => {
  it('one Job → exactly today’s single-job payload (lines, memo, PSID note) — existing invoices never drift', () => {
    const seg = jobSegment(A, 21000, civic)
    const single = buildRetailPayload({
      estimateId: A, vehicle: civic, feesItemId: 'FEES', paymentLabel: 'Card Payment', shopSuppliesLabel: 'Shop supplies',
      workServices: [{ itemId: 'LABOR', description: 'Full Detail', amountCents: 21000 }],
      shopSuppliesCents: seg.lines[1].amountCents, paymentChargeCents: seg.lines[2].amountCents, expectedTotalCents: seg.totalCents,
    })
    expect(combineSharedPayload(A, [seg])).toEqual(single)
  })

  it('two Jobs → services per vehicle, then ONE combined supplies + ONE combined card line (exact per-job cents)', () => {
    // $2,100 → supplies capped at $20 + card $63.60 = $2,183.60 ; $150 → supplies $4.50 + card $4.64 = $159.14
    const a = jobSegment(A, 210000, civic)
    const b = jobSegment(B, 15000, f150)
    expect(a.totalCents).toBe(218360)
    expect(b.totalCents).toBe(15914)
    const p = combineSharedPayload(A, [a, b])
    expect(p.totalCents).toBe(218360 + 15914)
    expect(p.lines.filter((l) => l.kind !== 'text').reduce((t, l) => t + l.amountCents, 0)).toBe(p.totalCents)
    // Both vehicles' SERVICE lines come first (each keeps its own amount), then the fee lines are combined once:
    // supplies = $20.00 (capped) + $4.50 = $24.50 ; card = $63.60 + $4.64 = $68.24 — the EXACT sum of each Job's
    // already-capped/rounded fee cents, never re-based or re-rounded.
    const priced = p.lines.filter((l) => l.kind !== 'text').map((l) => [l.description, l.amountCents])
    expect(priced).toEqual([
      ['Full Detail', 210000],
      ['Full Detail', 15000],
      ['Shop supplies', 2000 + 450],
      ['Card Payment', 6360 + 464],
    ])
    // The combined fee lines carry the internal fee metadata (so later combines re-aggregate correctly)…
    const fees = p.lines.filter((l) => l.fee)
    expect(fees.map((l) => l.fee)).toEqual(['shop_supplies', 'payment'])
    // Pooling the work would have produced a different (wrong) total — prove the difference is real.
    const pooled = explicitPretaxTotals(225000, effectiveFeeConfig(FEES, { isDealer: false }), 0, 'detailing').totalCents
    expect(pooled).not.toBe(p.totalCents)
  })

  it('three Jobs → combined supplies + card are the sum across all three; headers stay in Job order', () => {
    const a = jobSegment(A, 10000, civic)   // supplies 300, card 309
    const b = jobSegment(B, 20000, f150)    // supplies 600, card 618
    const c = jobSegment(C, 5000, { make: 'Kia' })  // supplies 150, card 155 (154.5 cents rounds up)
    const p = combineSharedPayload(A, [a, b, c])
    const priced = p.lines.filter((l) => l.kind !== 'text').map((l) => [l.description, l.amountCents])
    expect(priced).toEqual([
      ['Full Detail', 10000], ['Full Detail', 20000], ['Full Detail', 5000],
      ['Shop supplies', 300 + 600 + 150], ['Card Payment', 309 + 618 + 155],
    ])
    expect(p.lines.filter((l) => l.kind === 'text')).toHaveLength(3)
    expect(p.totalCents).toBe(a.totalCents + b.totalCents + c.totalCents)
  })

  it('a waived fee on one Job is simply not in the sum; shop supplies stays before card even if the FIRST Job waived it', () => {
    // Anchor waives BOTH its fees (work only); member carries both. The combined invoice must still list supplies
    // before card even though the first appearance of each fee is on the member.
    const anchor = jobSegment(A, 20000, civic, { waiveShopSupplies: true, waivePayment: true })
    const member = jobSegment(B, 20000, f150)
    expect(anchor.totalCents).toBe(20000)
    const p = combineSharedPayload(A, [anchor, member])
    const priced = p.lines.filter((l) => l.kind !== 'text').map((l) => [l.description, l.amountCents])
    expect(priced).toEqual([
      ['Full Detail', 20000], ['Full Detail', 20000],
      ['Shop supplies', 600], ['Card Payment', 618],
    ])
    expect(p.totalCents).toBe(20000 + member.totalCents)
  })

  it('incompatible fee lines (different label / item ref) are NEVER silently merged — each stays its own line', () => {
    // Two member segments whose card fee uses a different label / item id than the anchor's. Same fee KIND, but
    // incompatible identity → three distinct card lines, each the sum of only its own compatible group.
    const anchor = jobSegment(A, 10000, civic)                 // FEES / 'Card Payment' / 309
    const b: SharedSegment = {
      estimateId: B, vehicle: f150, totalCents: 10309,
      lines: [
        { itemId: 'LABOR', description: 'Full Detail', amountCents: 10000 },
        { itemId: 'FEES', description: 'CC Processing Fee', amountCents: 309, fee: 'payment' },  // different LABEL
      ],
    }
    const cSeg: SharedSegment = {
      estimateId: C, vehicle: { make: 'Kia' }, totalCents: 10309,
      lines: [
        { itemId: 'LABOR', description: 'Full Detail', amountCents: 10000 },
        { itemId: 'OTHER-FEES', description: 'Card Payment', amountCents: 309, fee: 'payment' },  // different ITEM
      ],
    }
    const p = combineSharedPayload(A, [anchor, b, cSeg])
    const cards = p.lines.filter((l) => l.fee === 'payment').map((l) => [l.itemId, l.description, l.amountCents])
    expect(cards).toEqual([
      ['FEES', 'Card Payment', 309],
      ['FEES', 'CC Processing Fee', 309],
      ['OTHER-FEES', 'Card Payment', 309],
    ])
    expect(p.lines.filter((l) => l.fee === 'payment')).toHaveLength(3)
  })

  it('a waived card charge on one Job stays waived; the other Job keeps its charge', () => {
    const p = combineSharedPayload(A, [jobSegment(A, 20000, civic), jobSegment(B, 20000, f150, { waivePayment: true })])
    const cards = p.lines.filter((l) => l.description === 'Card Payment')
    expect(cards).toHaveLength(1)
    expect(p.totalCents).toBe(20000 + 600 + 618 + 20000 + 600)
  })

  it('vehicle headers are description-only lines, in Job order; memo lists every vehicle; anchor PSID stays first', () => {
    const p = combineSharedPayload(A, [jobSegment(A, 10000, civic), jobSegment(B, 10000, f150), jobSegment(C, 10000, { make: 'Kia' })])
    const headers = p.lines.filter((l) => l.kind === 'text').map((l) => l.description)
    expect(headers).toEqual([
      'Vehicle 1 of 3 — 2019 Honda Civic · VIN 1HGCV1F30KA000001',
      'Vehicle 2 of 3 — 2018 Ford F-150 · Plate ABC1234',
      'Vehicle 3 of 3 — Kia',
    ])
    expect(p.lines[0].kind).toBe('text')
    expect(p.customerMemo).toContain('Vehicle 1: 2019 Honda Civic')
    expect(p.customerMemo).toContain('Vehicle 2: 2018 Ford F-150')
    expect(extractPsid(p.privateNote)).toBe(A)       // the existing identity check still proves it is the anchor's
    expect(p.privateNote).toBe(`PSID:${A} | PSLINK:${B},${C}`)
  })

  it('refuses a segment whose lines don’t equal its own Job total, and a missing / misplaced anchor', () => {
    const bad = { ...jobSegment(B, 10000, f150), totalCents: 1 }
    expect(() => combineSharedPayload(A, [jobSegment(A, 10000, civic), bad])).toThrow(RetailTotalMismatchError)
    expect(() => combineSharedPayload(A, [jobSegment(B, 10000, f150), jobSegment(A, 10000, civic)])).toThrow(/anchor/)
    expect(() => combineSharedPayload(A, [])).toThrow()
  })

  it('fee engine reference: a dealer Job carries no retail charges (never reaches this builder)', () => {
    expect(computeFees(10000, effectiveFeeConfig(FEES, { isDealer: true }))).toEqual([])
  })
})

describe('line fingerprint — detects edits made in QuickBooks', () => {
  const p = combineSharedPayload(A, [jobSegment(A, 10000, civic), jobSegment(B, 5000, f150)])
  // What QuickBooks returns for the lines we wrote (plus its SubTotal line, which is ignored).
  const raw = [
    ...p.lines.map((l) => l.kind === 'text'
      ? { DetailType: 'DescriptionOnly', Description: l.description, DescriptionLineDetail: {} }
      : { DetailType: 'SalesItemLineDetail', Amount: l.amountCents / 100, Description: `${l.description}  `, SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: 1 } }),
    { DetailType: 'SubTotalLineDetail', Amount: p.totalCents / 100 },
  ]
  it('what we wrote == what QuickBooks holds (whitespace-insensitive, SubTotal ignored)', () => {
    expect(sameLines(linesFromRawInvoice(raw), linesFromPayload(p.lines))).toBe(true)
  })
  it('a line added, re-priced, re-itemed or re-described in QuickBooks changes the fingerprint', () => {
    const base = linesFingerprint(linesFromRawInvoice(raw))
    const added = [...raw, { DetailType: 'SalesItemLineDetail', Amount: 25, Description: 'Tip', SalesItemLineDetail: { ItemRef: { value: '9' } } }]
    const repriced = raw.map((l, i) => (i === 1 ? { ...l, Amount: 99 } : l))
    const reitemed = raw.map((l, i) => (i === 1 ? { ...l, SalesItemLineDetail: { ItemRef: { value: 'OTHER' } } } : l))
    const redescribed = raw.map((l, i) => (i === 1 ? { ...l, Description: 'Something else' } : l))
    for (const changed of [added, repriced, reitemed, redescribed]) expect(linesFingerprint(linesFromRawInvoice(changed))).not.toBe(base)
  })
})

describe('legacy layout reconstruction — invoices written before the combined layout stay recognisable', () => {
  const a = jobSegment(A, 210000, civic)
  const b = jobSegment(B, 15000, f150)
  const combined = combineSharedPayload(A, [a, b])
  const legacy = combineSharedPayload(A, [a, b], { layout: 'legacy' })
  const toRaw = (lines: typeof combined.lines) => lines.map((l) => l.kind === 'text'
    ? { DetailType: 'DescriptionOnly', Description: l.description, DescriptionLineDetail: {} }
    : { DetailType: 'SalesItemLineDetail', Amount: l.amountCents / 100, Description: l.description, SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: 1 } })

  it('legacy = the original per-vehicle interleaved layout (same money, different arrangement → different fingerprint)', () => {
    const priced = legacy.lines.filter((l) => l.kind !== 'text').map((l) => [l.description, l.amountCents])
    expect(priced).toEqual([
      ['Full Detail', 210000], ['Shop supplies', 2000], ['Card Payment', 6360],
      ['Full Detail', 15000], ['Shop supplies', 450], ['Card Payment', 464],
    ])
    expect(legacy.totalCents).toBe(combined.totalCents)
    expect(linesFingerprint(linesFromPayload(legacy.lines))).not.toBe(linesFingerprint(linesFromPayload(combined.lines)))
  })

  it('an invoice QuickBooks still holds in the legacy layout matches the legacy reconstruction (a tampered one matches neither)', () => {
    const rawLegacy = toRaw(legacy.lines)
    expect(sameLines(linesFromRawInvoice(rawLegacy), linesFromPayload(legacy.lines))).toBe(true)
    expect(sameLines(linesFromRawInvoice(rawLegacy), linesFromPayload(combined.lines))).toBe(false)
    // Someone edits an amount in QuickBooks → matches NEITHER deterministic reconstruction → still refused.
    const tampered = rawLegacy.map((l, i) => (i === 1 ? { ...l, Amount: 1 } : l))
    expect(sameLines(linesFromRawInvoice(tampered), linesFromPayload(legacy.lines))).toBe(false)
    expect(sameLines(linesFromRawInvoice(tampered), linesFromPayload(combined.lines))).toBe(false)
  })
})

describe('invoiceMoneyState — only an untouched invoice may take more Jobs', () => {
  it('unpaid, nothing applied → untouched', () => {
    expect(invoiceMoneyState({ TotalAmt: 218.36, Balance: 218.36 })).toMatchObject({ untouched: true, totalCents: 21836, balanceCents: 21836 })
  })
  it('partial payment / credit / linked payment / paid / voided / no balance → refused with a reason', () => {
    expect(invoiceMoneyState({ TotalAmt: 200, Balance: 150 })).toMatchObject({ untouched: false })
    expect(invoiceMoneyState({ TotalAmt: 200, Balance: 200, LinkedTxn: [{ TxnType: 'Payment' }] })).toMatchObject({ untouched: false })
    expect(invoiceMoneyState({ TotalAmt: 200, Balance: 200, LinkedTxn: [{ TxnType: 'CreditMemo' }] })).toMatchObject({ untouched: false })
    expect(invoiceMoneyState({ TotalAmt: 200, Balance: 0 }).reason).toMatch(/paid/)
    expect(invoiceMoneyState({ TotalAmt: 0, Balance: 0 }).reason).toMatch(/voided/)
    expect(invoiceMoneyState({ TotalAmt: 200 }).untouched).toBe(false)
  })
  it('a non-money linked transaction (e.g. the estimate it came from) does not block', () => {
    expect(invoiceMoneyState({ TotalAmt: 200, Balance: 200, LinkedTxn: [{ TxnType: 'Estimate' }] }).untouched).toBe(true)
  })
})

describe('overwriteUnsafeLineTypes — a shared rewrite fails closed on lines it can’t rebuild', () => {
  it('our priced item lines, DescriptionOnly headers and QuickBooks’ own SubTotal are safe', () => {
    expect(overwriteUnsafeLineTypes([
      { DetailType: 'SalesItemLineDetail' }, { DetailType: 'DescriptionOnly' }, { DetailType: 'SubTotalLineDetail' },
    ])).toEqual([])
    expect(overwriteUnsafeLineTypes([])).toEqual([])
    expect(overwriteUnsafeLineTypes(null)).toEqual([])
    expect(overwriteUnsafeLineTypes(undefined)).toEqual([])
  })
  it('a discount, group or unknown line is reported (distinct) so the caller refuses instead of dropping it', () => {
    expect(overwriteUnsafeLineTypes([{ DetailType: 'SalesItemLineDetail' }, { DetailType: 'DiscountLineDetail' }])).toEqual(['DiscountLineDetail'])
    expect(overwriteUnsafeLineTypes([{ DetailType: 'GroupLineDetail' }, { DetailType: 'GroupLineDetail' }, { DetailType: null }, {}])).toEqual(['GroupLineDetail', '(unknown)'])
    // A discount line is invisible to the line fingerprint (it normalizes only item + description lines), so this
    // guard is the only thing standing between a shared rewrite and silently overwriting it.
    const withDiscount = [
      { DetailType: 'SalesItemLineDetail', Amount: 100, Description: 'Full Detail', SalesItemLineDetail: { ItemRef: { value: 'LABOR' } } },
      { DetailType: 'DiscountLineDetail', Amount: 10, DiscountLineDetail: { PercentBased: false } },
    ]
    const withoutDiscount = withDiscount.slice(0, 1)
    expect(linesFingerprint(linesFromRawInvoice(withDiscount))).toBe(linesFingerprint(linesFromRawInvoice(withoutDiscount)))
    expect(overwriteUnsafeLineTypes(withDiscount)).toEqual(['DiscountLineDetail'])
  })
})

describe('eligibility rules', () => {
  const ok = { qbStatus: 'created', qbPaymentStatus: 'none', qbPaymentBalanceState: null, qbSyncError: null, orderStatus: 'ready', isDealer: false }
  it('anchor: created or sent, no payment, not under review, retail, not removed', () => {
    expect(anchorLocalBlock(ok)).toBeNull()
    expect(anchorLocalBlock({ ...ok, qbStatus: 'sent' })).toBeNull()
    expect(anchorLocalBlock({ ...ok, qbPaymentBalanceState: 'unpaid' })).toBeNull()
    for (const bad of [
      { isDealer: true }, { orderStatus: 'cancelled' }, { qbStatus: 'syncing' }, { qbStatus: 'error' }, { qbStatus: 'sending' },
      { qbPaymentStatus: 'recording' }, { qbPaymentStatus: 'recorded' }, { qbPaymentBalanceState: 'partial' },
      { qbSyncError: 'Needs review — customer changed' },
    ]) expect(anchorLocalBlock({ ...ok, ...bad })).not.toBeNull()
  })
  it('new Job: retail, active, no invoice of its own, not already linked, not mid-create', () => {
    const m = { isDealer: false, orderStatus: 'arrived', qbInvoiceId: null, qbStatus: 'none', activeMembership: false }
    expect(memberLocalBlock(m)).toBeNull()
    expect(memberLocalBlock({ ...m, qbStatus: 'error' })).toBeNull()   // failed Create: allowed after a PSID check
    expect(memberLocalBlock({ ...m, isDealer: true })?.code).toBe('dealer')
    expect(memberLocalBlock({ ...m, qbInvoiceId: '77' })?.code).toBe('has_invoice')
    expect(memberLocalBlock({ ...m, qbInvoiceId: '77' })?.message).toMatch(/never merged automatically/)
    expect(memberLocalBlock({ ...m, activeMembership: true })?.code).toBe('already_linked')
    expect(memberLocalBlock({ ...m, qbStatus: 'linked' })?.code).toBe('already_linked')
    expect(memberLocalBlock({ ...m, qbStatus: 'creating' })?.code).toBe('busy')
    expect(memberLocalBlock({ ...m, orderStatus: 'cancelled' })?.code).toBe('cancelled')
    expect(memberLocalBlock({ ...m, orderStatus: 'estimate' })?.code).toBe('estimate')
  })
  it('vehicle header falls back gracefully', () => {
    expect(vehicleHeader({}, 0, 2)).toBe('Vehicle 1 of 2 — Vehicle')
  })
})
