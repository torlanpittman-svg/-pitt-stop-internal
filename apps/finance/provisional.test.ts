import { describe, it, expect } from 'vitest'
import { computeProvisional, traceReceipt, accountRefOf, type PReceipt, type PTxn, type PQb, type PLinks, type FeedCoverage } from './provisional'

const MONTH = '2026-11'
const noLinks = (): PLinks => ({ receiptTxn: {}, receiptNoBank: [], receiptQb: {}, txnQb: {} })
const FEEDS: FeedCoverage[] = [
  { accountRef: '*2649', through: '2026-11-16', healthy: true },
  { accountRef: '*5600', through: '2026-09-25', healthy: false },   // connection stopped updating
]
let n = 0
const rcpt = (o: Partial<PReceipt> & { vendor: string; date: string; totalCents: number }): PReceipt => ({ id: `r${++n}`, accountRef: '*2649', paymentMethod: 'card', entity: 'shared', ...o })
const txn = (o: Partial<PTxn> & { merchantName: string; date: string; amountCents: number }): PTxn => ({ id: `t${++n}`, name: o.merchantName, txnClass: 'expense', isExpense: true, pending: false, accountRef: '*2649', ...o })
const qbe = (o: Partial<PQb> & { date: string; totalCents: number }): PQb => ({ key: `Purchase:${++n}`, payee: null, accountRef: '*2649', paymentType: 'Cash', ...o })
const run = (receipts: PReceipt[], txns: PTxn[], qb: PQb[] = [], links: PLinks = noLinks(), feeds = FEEDS) => computeProvisional({ month: MONTH, receipts, txns, qb, links, feeds })

describe('accountRefOf', () => {
  it('names a paying account the way receipts do', () => {
    expect(accountRefOf('Pitt Stop Detail *2649')).toBe('*2649')
    expect(accountRefOf('Pitt Stop Auto Sales *5600')).toBe('*5600')
    expect(accountRefOf('AMEX  6-31007')).toBe('amex')
    expect(accountRefOf('Savings')).toBeNull()
  })
})

describe('one purchase is counted once', () => {
  it('a receipt and its bank payment are ONE purchase, at the bank amount — never added together', () => {
    const r = rcpt({ vendor: "Lowe's", date: '2026-11-10', totalCents: 2009 })
    const p = run([r], [txn({ merchantName: "Lowe's", date: '2026-11-10', amountCents: 2009 })])
    expect(p.items).toHaveLength(1)
    expect(p.totalCents).toBe(2009)
    expect(p.provisionalCents).toBe(2009)
    expect(p.provisionalReceiptBackedCents).toBe(2009)
    expect(traceReceipt(p, r.id).item?.bank).toBe('bank_likely')
  })

  it('a confirmed receipt↔bank match is reported as confirmed and still counted once', () => {
    const r = rcpt({ vendor: 'Hotsy-Carlson of Bryan', date: '2026-11-10', totalCents: 6325 })
    const t = txn({ merchantName: 'Hotsy', date: '2026-11-12', amountCents: 6325 })
    const p = run([r], [t], [], { ...noLinks(), receiptTxn: { [r.id]: t.id } })
    expect(p.totalCents).toBe(6325)
    expect(p.bankConfirmedCount).toBe(1)
    expect(traceReceipt(p, r.id).item?.bank).toBe('bank_confirmed')
  })

  it('an equal amount ALONE never pairs a receipt with a bank payment — it is left unclear and NOT added', () => {
    const r = rcpt({ vendor: 'Allen Honda', date: '2026-11-04', totalCents: 1000 })
    const p = run([r], [txn({ merchantName: 'Shell', date: '2026-11-03', amountCents: 1000 })])
    expect(p.items.map((i) => i.label)).toEqual(['Shell'])          // the bank purchase stands on its own
    expect(p.totalCents).toBe(1000)                                 // the receipt added nothing
    expect(p.unclear.map((u) => u.receiptId)).toEqual([r.id])
  })

  it('a receipt paid from a healthy account with no bank payment is flagged, not counted', () => {
    const r = rcpt({ vendor: 'Allen Honda', date: '2026-11-04', totalCents: 101512 })
    const p = run([r], [])
    expect(p.totalCents).toBe(0)
    expect(p.unclear[0].reason).toMatch(/no bank payment/)
    expect(p.unclearCents).toBe(101512)
  })

  it('a wrong payment account is not matched even when vendor, amount and date agree', () => {
    const r = rcpt({ vendor: 'Kroger Fuel', date: '2026-11-04', totalCents: 1000, accountRef: '*5600' })
    const p = run([r], [txn({ merchantName: 'Kroger Fuel', date: '2026-11-04', amountCents: 1000, accountRef: '*2649' })])
    expect(p.items).toHaveLength(2)                                  // two different purchases
    expect(traceReceipt(p, r.id).item?.source).toBe('receipt')
  })

  it('two same-vendor same-amount purchases pair one-to-one with two receipts (competing candidates)', () => {
    const a = rcpt({ vendor: 'Kroger Fuel', date: '2026-11-05', totalCents: 6000 }), b = rcpt({ vendor: 'Kroger Fuel', date: '2026-11-05', totalCents: 6000 })
    const p = run([a, b], [txn({ merchantName: 'Kroger Fuel', date: '2026-11-05', amountCents: 6000 }), txn({ merchantName: 'Kroger Fuel', date: '2026-11-06', amountCents: 6000 })])
    expect(p.items).toHaveLength(2)
    expect(p.totalCents).toBe(12000)
    expect(new Set([traceReceipt(p, a.id).item?.txnId, traceReceipt(p, b.id).item?.txnId]).size).toBe(2)
  })

  it('cash movements (card payments, payroll, transfers, loan payments, owner draws) are never spending here', () => {
    const p = run([], [
      txn({ merchantName: 'Amex Epayment', date: '2026-11-04', amountCents: 55200, txnClass: 'card_payment', isExpense: false }),
      txn({ merchantName: 'Check', date: '2026-11-06', amountCents: 157245, txnClass: 'payroll', isExpense: false }),
      txn({ merchantName: 'To Checking', date: '2026-11-06', amountCents: 100000, txnClass: 'owner_draw', isExpense: false }),
      txn({ merchantName: 'Intuit Financing', date: '2026-11-09', amountCents: 145576, txnClass: 'debt_payment', isExpense: false }),
      txn({ merchantName: 'Transfer', date: '2026-11-15', amountCents: 500000, txnClass: 'transfer', isExpense: false }),
    ])
    expect(p.items).toHaveLength(0)
  })

  it('a pending bank transaction is not counted (it can still change)', () => {
    expect(run([], [txn({ merchantName: 'Shell', date: '2026-11-15', amountCents: 4000, pending: true })]).totalCents).toBe(0)
  })
})

describe('returns', () => {
  it('a net-of-returns receipt matches the NET bank payment — not the gross, and not another payment to the vendor', () => {
    // Harbor Freight: bought $19.98, returned $14.97, tax $0.42 → paid $5.43. Same day the card also paid $37.12.
    const r = rcpt({ vendor: 'Harbor Freight', date: '2026-11-11', totalCents: 543 })
    const net = txn({ merchantName: 'Harbor Freight Tools', date: '2026-11-12', amountCents: 543 })
    const other = txn({ merchantName: 'Harbor Freight Tools', date: '2026-11-12', amountCents: 3712 })
    const p = run([r], [net, other])
    expect(traceReceipt(p, r.id).item?.txnId).toBe(net.id)
    expect(traceReceipt(p, r.id).item?.amountCents).toBe(543)
    expect(p.totalCents).toBe(543 + 3712)                            // $19.98 gross appears nowhere
  })

  it('a refund coming back in is not spending and a zero/negative receipt adds nothing', () => {
    const p = run([rcpt({ vendor: 'Harbor Freight', date: '2026-11-11', totalCents: 0 })], [])
    expect(p.totalCents).toBe(0)
    expect(p.unclear).toHaveLength(0)
  })
})

describe('what the bank cannot see', () => {
  it('a purchase too recent for the feed is added from its receipt, labelled not visible yet', () => {
    const r = rcpt({ vendor: "O'Reilly Auto Parts", date: '2026-11-16', totalCents: 1045 })
    const p = run([r], [])
    const it0 = traceReceipt(p, r.id).item
    expect(it0?.source).toBe('receipt')
    expect(it0?.bank).toBe('not_visible_yet')
    expect(p.provisionalReceiptOnlyCents).toBe(1045)
  })

  it('…and stops adding the moment the bank posts it (no double count across the hand-off)', () => {
    const r = rcpt({ vendor: "O'Reilly Auto Parts", date: '2026-11-16', totalCents: 1045 })
    const p = run([r], [txn({ merchantName: "O'Reilly Auto Parts", date: '2026-11-17', amountCents: 1045, txnClass: 'inventory' })], [], noLinks(), [{ accountRef: '*2649', through: '2026-11-17', healthy: true }])
    expect(p.items).toHaveLength(1)
    expect(p.totalCents).toBe(1045)
    expect(p.provisionalReceiptOnlyCents).toBe(0)
  })

  it('a purchase on an account whose connection stopped updating is added from its receipt and says why', () => {
    const r = rcpt({ vendor: 'Kroger Fuel', date: '2026-11-04', totalCents: 1000, accountRef: '*5600' })
    const it0 = traceReceipt(run([r], []), r.id).item
    expect(it0?.bank).toBe('not_visible_yet')
    expect(it0?.note).toMatch(/not updating/)
  })

  it('cash is added from its receipt', () => {
    const r = rcpt({ vendor: 'Car wash supply', date: '2026-11-05', totalCents: 2500, accountRef: 'cash', paymentMethod: 'cash' })
    expect(traceReceipt(run([r], []), r.id).item?.bank).toBe('cash')
  })
})

describe('QuickBooks catching up', () => {
  const setup = () => {
    const r = rcpt({ vendor: "O'Reilly Auto Parts", date: '2026-11-10', totalCents: 3709 })
    const t = txn({ merchantName: "O'Reilly Auto Parts", date: '2026-11-10', amountCents: 3709, txnClass: 'inventory' })
    return { r, t }
  }
  it('before: provisional. after a matching QuickBooks entry appears on the same account: no longer provisional', () => {
    const { r, t } = setup()
    expect(run([r], [t]).provisionalCents).toBe(3709)
    const after = run([r], [t], [qbe({ date: '2026-11-10', totalCents: 3709, payee: "O'Reilly" })])
    expect(after.provisionalCents).toBe(0)
    expect(after.likelyInQuickBooksCents).toBe(3709)
    expect(after.totalCents).toBe(3709)                              // still one purchase, the receipt is still attached
    expect(traceReceipt(after, r.id).item?.quickbooks).toBe('likely_in_quickbooks')
  })

  it('a person confirming the QuickBooks match moves it to confirmed — through the bank payment or the receipt', () => {
    const { r, t } = setup()
    const q = qbe({ date: '2026-11-10', totalCents: 3709 })
    expect(run([r], [t], [q], { ...noLinks(), txnQb: { [t.id]: q.key } }).inQuickBooksCents).toBe(3709)
    expect(run([r], [t], [q], { ...noLinks(), receiptQb: { [r.id]: q.key } }).inQuickBooksCents).toBe(3709)
  })

  it('one QuickBooks entry cannot absorb two bank payments of the same amount', () => {
    const a = txn({ merchantName: 'Shell', date: '2026-11-02', amountCents: 1000 }), b = txn({ merchantName: 'ExxonMobil', date: '2026-11-03', amountCents: 1000 })
    const p = run([], [a, b], [qbe({ date: '2026-11-02', totalCents: 1000 })])
    expect(p.likelyInQuickBooksCents).toBe(1000)
    expect(p.provisionalCents).toBe(1000)
  })

  it('a QuickBooks entry on a DIFFERENT paying account does not recognise the purchase', () => {
    const t = txn({ merchantName: 'Shell', date: '2026-11-02', amountCents: 1000 })
    expect(run([], [t], [qbe({ date: '2026-11-02', totalCents: 1000, accountRef: '*5600' })]).provisionalCents).toBe(1000)
  })

  it('a written check recorded in QuickBooks weeks before it clears is recognised; a later-dated entry is not', () => {
    const t = txn({ merchantName: 'Check(C21 Inclearings)', date: '2026-11-13', amountCents: 20000, txnClass: 'check' })
    expect(run([], [t], [qbe({ date: '2026-10-20', totalCents: 20000, paymentType: 'Check', payee: 'Thomas Blanchard' })]).provisionalCents).toBe(0)
    expect(run([], [t], [qbe({ date: '2026-11-25', totalCents: 20000, paymentType: 'Check' })]).provisionalCents).toBe(20000)
  })

  it('a receipt-only purchase is recognised by a QuickBooks entry on its own account', () => {
    const r = rcpt({ vendor: 'Kroger Fuel', date: '2026-11-04', totalCents: 1000, accountRef: '*5600' })
    const p = run([r], [], [qbe({ date: '2026-11-04', totalCents: 1000, accountRef: '*5600', payee: 'Kroger' })])
    expect(p.provisionalCents).toBe(0)
    expect(traceReceipt(p, r.id).item?.quickbooks).toBe('likely_in_quickbooks')
  })
})

describe('shared overhead and the acceptance case', () => {
  it('six shared-overhead receipts ($146.31): four ride on their bank payments, two are receipt-only, nothing doubles', () => {
    const receipts = [
      rcpt({ vendor: "O'Reilly Auto Parts", date: '2026-11-16', totalCents: 1045 }),
      rcpt({ vendor: "O'Reilly Auto Parts", date: '2026-11-10', totalCents: 3709 }),
      rcpt({ vendor: 'Hotsy-Carlson of Bryan', date: '2026-11-10', totalCents: 6325 }),
      rcpt({ vendor: 'Kroger Fuel', date: '2026-11-04', totalCents: 1000, accountRef: '*5600' }),
      rcpt({ vendor: "Lowe's", date: '2026-11-10', totalCents: 2009 }),
      rcpt({ vendor: 'Harbor Freight', date: '2026-11-11', totalCents: 543 }),
    ]
    const txns = [
      txn({ merchantName: "O'Reilly Auto Parts", date: '2026-11-10', amountCents: 3709, txnClass: 'inventory' }),
      txn({ merchantName: 'Hotsy', date: '2026-11-12', amountCents: 6325 }),
      txn({ merchantName: "Lowe's", date: '2026-11-10', amountCents: 2009 }),
      txn({ merchantName: 'Harbor Freight Tools', date: '2026-11-12', amountCents: 543 }),
    ]
    const p = run(receipts, txns)
    expect(p.totalCents).toBe(14631)
    expect(p.provisionalCents).toBe(14631)
    expect(p.provisionalReceiptBackedCents).toBe(12586)
    expect(p.provisionalReceiptOnlyCents).toBe(2045)
    expect(p.provisionalByEntity).toEqual({ shared: 14631 })
    expect(p.unclear).toHaveLength(0)
  })

  it('only purchases dated in the month are reported; an earlier payment still claims its own QuickBooks entry', () => {
    const oct = txn({ merchantName: 'Shell', date: '2026-10-30', amountCents: 1000 }), nov = txn({ merchantName: 'Shell', date: '2026-11-02', amountCents: 1000 })
    const p = run([], [oct, nov], [qbe({ date: '2026-10-30', totalCents: 1000 })])
    expect(p.items).toHaveLength(1)
    expect(p.provisionalCents).toBe(1000)                            // November's is NOT hidden by October's entry
  })
})
