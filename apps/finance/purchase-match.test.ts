import { describe, it, expect } from 'vitest'
import { rankMatches, scorePair, sharedRef, type MatchSide } from './purchase-match'
import { countOnce, nodeKey, type PurchaseNode } from './purchase-ledger'
import { mapQbPurchase } from './qb-purchases'
import { isPreviewDeployment, previewDbDecision, previewStorageDecision, assertPreviewDbAllowed, environmentSummary } from '@/platform/preview-guard'

const receipt: MatchSide = { amountCents: 8021, date: '2026-11-13', names: ['Tesla Inc.'], refs: ['3000H0000513594', 'GPO-3Y3WMP6N16'], text: [] }

describe('scorePair — reliable identifiers and supporting evidence', () => {
  it('exact amount + close date + same name → strong', () => {
    expect(scorePair(receipt, { amountCents: 8021, date: '2026-11-14', names: ['TESLA INC SERVICE'] }).strength).toBe('strong')
  })
  it('a shared invoice number inside the other side’s memo is a reliable identifier', () => {
    const s = scorePair(receipt, { amountCents: 8021, date: '2026-11-20', names: ['Parts vendor'], text: ['Inv 3000H0000513594 seat foam'] })
    expect(s.strength).toBe('strong'); expect(s.refMatch).toBe('3000h0000513594')
  })
  it('an equal amount with no name or reference is only "possible" — never strong', () => {
    expect(scorePair(receipt, { amountCents: 8021, date: '2026-11-13', names: ['SHELL OIL'] }).strength).toBe('possible')
  })
  it('a different amount beyond tolerance is not a match even with the same name', () => {
    expect(scorePair(receipt, { amountCents: 9500, date: '2026-11-13', names: ['Tesla Inc.'] }).strength).toBe('none')
  })
  it('a check matches its bank line by check number + amount even weeks later', () => {
    const check: MatchSide = { amountCents: 7500, date: '2026-11-12', names: ['PDR'], refs: ['10390'] }
    expect(scorePair(check, { amountCents: 7500, date: '2026-12-05', names: ['CHECK 10390'], text: ['CHECK 10390'] }, { maxDays: 60 }).strength).toBe('strong')
    expect(scorePair(check, { amountCents: 7500, date: '2026-12-05', names: ['CHECK 10388'], text: ['CHECK 10388'] }, { maxDays: 60 }).strength).toBe('possible')
  })
  it('short references never match by accident', () => {
    expect(sharedRef({ amountCents: 1, date: null, names: [], refs: ['12'] }, { amountCents: 1, date: null, names: [], text: ['order 1234'] })).toBeNull()
  })
  it('two equally good candidates are flagged ambiguous, not chosen', () => {
    const cands = [{ id: 'a', amountCents: 8021, date: '2026-11-13', names: ['Tesla'] }, { id: 'b', amountCents: 8021, date: '2026-11-13', names: ['Tesla'] }]
    const r = rankMatches(receipt, cands, (c) => c, { limit: 2 })
    expect(r.every((x) => x.ambiguous)).toBe(true)
    const one = rankMatches(receipt, [cands[0], { id: 'c', amountCents: 8021, date: '2026-11-13', names: ['Shell'] }], (c) => c, { limit: 2 })
    expect(one[0].ambiguous).toBe(false)
  })
})

describe('countOnce — one purchase counts once across sources', () => {
  const n = (source: PurchaseNode['source'], id: string, amountCents: number): PurchaseNode => ({ key: nodeKey(source, id), source, id, amountCents, date: '2026-11-13', label: id })
  it('a purchase seen in four places is counted one time once they are matched', () => {
    const nodes = [n('receipt', 'r1', 8021), n('bank_txn', 't1', 8021), n('qb_purchase', 'Purchase:9', 8021), n('vehicle_event', 'v1', 8021)]
    const none = countOnce(nodes, [])
    expect(none.countedOnceCents).toBe(32084)             // unmatched: honestly reported as four records
    expect(none.singleSourceCount).toBe(4)
    const all = countOnce(nodes, [{ a: 'receipt:r1', b: 'bank_txn:t1' }, { a: 'bank_txn:t1', b: 'qb_purchase:Purchase:9' }, { a: 'receipt:r1', b: 'vehicle_event:v1' }])
    expect(all.countedOnceCents).toBe(8021)
    expect(all.naiveSumCents).toBe(32084)
    expect(all.duplicateCents).toBe(24063)
    expect(all).toMatchObject({ multiSourceCount: 1, singleSourceCount: 0 })
  })
  it('a receipt + inventory-ledger line for the same purchase do not inflate the total once matched', () => {
    const nodes = [n('receipt', 'r1', 5000), n('vehicle_event', 'v1', 5000), n('receipt', 'r2', 1200)]
    expect(countOnce(nodes, [{ a: 'receipt:r1', b: 'vehicle_event:v1' }]).countedOnceCents).toBe(6200)
  })
  it('the bank amount represents the purchase, and a disagreement is flagged', () => {
    const g = countOnce([n('receipt', 'r1', 8021), n('bank_txn', 't1', 8521)], [{ a: 'receipt:r1', b: 'bank_txn:t1' }])
    expect(g.countedOnceCents).toBe(8521)
    expect(g.disagreeCount).toBe(1)
  })
  it('an edge to a record outside the window is ignored, never a crash', () => {
    expect(countOnce([n('receipt', 'r1', 100)], [{ a: 'receipt:r1', b: 'bank_txn:gone' }]).countedOnceCents).toBe(100)
  })
})

describe('mapQbPurchase — the real QuickBooks shape, read-only', () => {
  const raw = { AccountRef: { value: '31', name: 'Pitt Stop Detail *2649' }, PaymentType: 'Check', EntityRef: { value: '652', name: 'PDR', type: 'Vendor' }, TotalAmt: 75, Id: '24657', DocNumber: '10390', TxnDate: '2026-11-12', PrivateNote: 'BMW X7', MetaData: { LastUpdatedTime: '2026-11-12T08:49:19-08:00' },
    Line: [{ Id: '1', Description: 'BMW X7', Amount: 75, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '16', name: 'Cost of Goods Sold:Job Supplies' } } }] }
  it('maps a check purchase', () => {
    expect(mapQbPurchase(raw, 'Purchase')).toMatchObject({ qbKey: 'Purchase:24657', totalCents: 7500, txnDate: '2026-11-12', paymentType: 'Check', accountName: 'Pitt Stop Detail *2649', payeeName: 'PDR', docNumber: '10390', privateNote: 'BMW X7', lineSummary: 'BMW X7', expenseAccounts: 'Cost of Goods Sold:Job Supplies' })
  })
  it('maps a bill (vendor, no paying account) and rejects junk', () => {
    expect(mapQbPurchase({ Id: '7', TotalAmt: '120.50', VendorRef: { name: 'Atmos Energy' }, TxnDate: '2026-11-01' }, 'Bill')).toMatchObject({ qbKey: 'Bill:7', totalCents: 12050, payeeName: 'Atmos Energy', accountName: null, paymentType: null })
    expect(mapQbPurchase({ TotalAmt: 5 }, 'Purchase')).toBeNull()
    expect(mapQbPurchase(null, 'Purchase')).toBeNull()
  })
})

describe('preview deployments fail closed', () => {
  const PROD = 'postgres://u:p@ep-morning-base-adq5h6rq-pooler.us-east-1.aws.neon.tech/neondb'
  const DEV = 'postgres://u:p@ep-quiet-dev-12345678.us-east-1.aws.neon.tech/neondb'
  it('production and local are never affected', () => {
    expect(isPreviewDeployment({ VERCEL: '1', VERCEL_ENV: 'production' })).toBe(false)
    expect(isPreviewDeployment({})).toBe(false)
    expect(previewDbDecision({ VERCEL: '1', VERCEL_ENV: 'production', APP_DATABASE_URL: PROD }).allowed).toBe(true)
    expect(() => assertPreviewDbAllowed({ VERCEL: '1', VERCEL_ENV: 'production', APP_DATABASE_URL: PROD })).not.toThrow()
  })
  it('a preview pointed at the production database is refused — reads included', () => {
    const env = { VERCEL: '1', VERCEL_ENV: 'preview', APP_DATABASE_URL: PROD, DATABASE_ENV: 'preview' }
    expect(previewDbDecision(env)).toMatchObject({ allowed: false })
    expect(() => assertPreviewDbAllowed(env)).toThrow(/Preview deployment blocked from database/)
  })
  it('a preview on an UNDECLARED database is refused; a declared non-production one is allowed', () => {
    expect(previewDbDecision({ VERCEL: '1', VERCEL_ENV: 'preview', APP_DATABASE_URL: DEV }).allowed).toBe(false)
    expect(previewDbDecision({ VERCEL: '1', VERCEL_ENV: 'preview', APP_DATABASE_URL: DEV, DATABASE_ENV: 'preview' }).allowed).toBe(true)
  })
  it('preview file storage is refused until an isolated store is declared', () => {
    expect(previewStorageDecision({ VERCEL: '1', VERCEL_ENV: 'preview', RECEIPTS_BLOB_READ_WRITE_TOKEN: 'x' }).allowed).toBe(false)
    expect(previewStorageDecision({ VERCEL: '1', VERCEL_ENV: 'preview', PREVIEW_STORAGE_ISOLATED: '1' }).allowed).toBe(true)
  })
  it('the build itself is not blocked, and the health summary exposes no setting values', () => {
    expect(() => assertPreviewDbAllowed({ VERCEL: '1', VERCEL_ENV: 'preview', APP_DATABASE_URL: PROD, NEXT_PHASE: 'phase-production-build' })).not.toThrow()
    const s = environmentSummary({ VERCEL: '1', VERCEL_ENV: 'preview', APP_DATABASE_URL: PROD, RECEIPTS_BLOB_READ_WRITE_TOKEN: 'secret-token' })
    expect(s).toMatchObject({ vercelEnv: 'preview', databaseTarget: 'production', databaseAccess: 'blocked', storageAccess: 'blocked' })
    expect(JSON.stringify(s)).not.toMatch(/secret-token|ep-morning|postgres:/)
  })
})
