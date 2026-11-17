import { describe, it, expect } from 'vitest'
import { quietBills, outstandingChecks, spendVerdict, vendorToken, type BillInput, type BillTxn } from './cash-checks'

const TODAY = '2026-11-17'
const bill = (o: Partial<BillInput> & { vendor: string; amountCents: number }): BillInput => ({ id: o.vendor, frequency: 'monthly', ...o })
const pay = (name: string, date: string, amountCents: number): BillTxn => ({ date, amountCents, name, merchantName: name })

describe('quietBills — is a forecast bill still being charged?', () => {
  it('flags a monthly bill whose vendor has not charged for more than six weeks (the agency that stopped billing)', () => {
    const q = quietBills([bill({ vendor: 'Evolve Impact Group', amountCents: 75000 })], [pay('Evolve Impact Gr', '2026-09-01', 75000), pay('The Evolve Effect', '2026-10-01', 75000)], TODAY, '2026-11-16')
    expect(q).toHaveLength(1)
    expect(q[0].reason).toBe('no_payment_seen')
    expect(q[0].daysSince).toBe(47)
  })

  it('flags a bill whose latest charge was a very different amount (a final invoice), and says so', () => {
    const q = quietBills([bill({ vendor: 'Autoleap (software)', amountCents: 31814 })], [pay('AutoLeap Incorporated', '2026-10-21', 45326), pay('AutoLeap Incorporated', '2026-10-26', 15854), pay('AutoLeap Incorporated', '2026-11-06', 135978)], TODAY, '2026-11-16')
    expect(q[0].reason).toBe('amount_changed')
    expect(q[0].message).toMatch(/\$1,359\.78/)
  })

  it('a final invoice is flagged even when the usual smaller charges were recent (the newest charge is the newest evidence)', () => {
    const b = bill({ vendor: 'Autoleap (software)', amountCents: 31814, amountMinCents: 15854, amountMaxCents: 45326 })
    const q = quietBills([b], [pay('AutoLeap Incorporated', '2026-10-26', 15854), pay('AutoLeap Incorporated', '2026-11-06', 135978)], TODAY, '2026-11-16')
    expect(q.map((x) => x.reason)).toEqual(['amount_changed'])
  })

  it('leaves a bill alone when it was paid as usual, and when a recent charge is merely a little different', () => {
    const txns = [pay('WireStar Networks', '2026-10-22', 16338), pay('Google', '2026-11-16', 50000)]
    expect(quietBills([bill({ vendor: 'Wirestar Network (internet)', amountCents: 14414 }), bill({ vendor: 'Google Ads', amountCents: 43859, amountMinCents: 27600, amountMaxCents: 50000 })], txns, TODAY, '2026-11-16')).toEqual([])
  })

  it('a small side charge does not raise the question while the regular bill is still being paid', () => {
    const b = bill({ vendor: 'YouTube TV', amountCents: 8984 })
    expect(quietBills([b], [pay('YouTube', '2026-10-28', 8984), pay('YouTube', '2026-11-05', 1190)], TODAY, '2026-11-16')).toEqual([])
    // …but it does once the regular amount has stopped arriving.
    expect(quietBills([b], [pay('YouTube', '2026-09-28', 8984), pay('YouTube', '2026-11-05', 1190)], TODAY, '2026-11-16')[0].reason).toBe('amount_changed')
  })

  it('never judges a bill it cannot recognise in the bank by name (rent paid by transfer, a generic first word)', () => {
    expect(vendorToken('City of College Station')).toBeNull()
    expect(vendorToken('Rent — holding company')).toBeNull()
    expect(quietBills([bill({ vendor: 'Rent — holding company', amountCents: 491666 })], [pay('To Checking XX4183', '2026-08-15', 500000)], TODAY, '2026-11-16')).toEqual([])
  })

  it('is not fooled by another vendor that shares a common word', () => {
    // "group" appears in both; only the vendor's own name counts.
    const q = quietBills([bill({ vendor: 'Evolve Impact Group', amountCents: 75000 })], [pay('Evolve Impact Gr', '2026-10-01', 75000), pay('Sterling Auto Group', '2026-11-16', 1472)], TODAY, '2026-11-16')
    expect(q[0].lastDate).toBe('2026-10-01')
  })

  it('says nothing while the bank feed itself is behind — silence then proves nothing', () => {
    expect(quietBills([bill({ vendor: 'Evolve Impact Group', amountCents: 75000 })], [pay('Evolve Impact Gr', '2026-09-01', 75000)], TODAY, '2026-11-05')).toEqual([])
    expect(quietBills([bill({ vendor: 'Evolve Impact Group', amountCents: 75000 })], [], TODAY, null)).toEqual([])
  })

  it('ignores weekly bills and small subscriptions', () => {
    expect(quietBills([bill({ vendor: 'Youtube TV', amountCents: 4000 }), bill({ vendor: 'Thomas Blanchard', amountCents: 40000, frequency: 'weekly' })], [pay('YouTube', '2026-08-01', 4000), pay('Thomas Blanchard', '2026-08-01', 40000)], TODAY, '2026-11-16')).toEqual([])
  })
})

describe('outstandingChecks — cash already spent that the bank has not taken yet', () => {
  const chk = (n: number, amountCents: number, checkDate: string) => ({ id: `c${n}`, checkNumber: n, payeeName: 'Payee', amountCents, checkDate })
  it('a check with no bank payment of the same amount is outstanding', () => {
    const o = outstandingChecks([chk(1, 30000, '2026-11-16'), chk(2, 7900, '2026-10-19')], [], TODAY)
    expect(o.totalCents).toBe(37900)
    expect(o.checks.map((c) => c.checkNumber)).toEqual([2, 1])
  })
  it('each bank payment clears exactly ONE check — two $200 checks and one $200 payment leaves one outstanding', () => {
    const o = outstandingChecks([chk(1, 20000, '2026-11-03'), chk(2, 20000, '2026-11-05')], [{ id: 't1', date: '2026-11-06', amountCents: 20000 }], TODAY)
    expect(o.totalCents).toBe(20000)
    expect(o.checks[0].checkNumber).toBe(2)
  })
  it('a bank payment dated before the check was written cannot clear it', () => {
    expect(outstandingChecks([chk(1, 20000, '2026-11-10')], [{ id: 't1', date: '2026-11-03', amountCents: 20000 }], TODAY).totalCents).toBe(20000)
  })
  it('a check written today is left to today’s forecast bills (never subtracted twice)', () => {
    expect(outstandingChecks([chk(1, 157245, TODAY)], [], TODAY).totalCents).toBe(0)
  })
  it('a check older than 60 days is reported but NOT subtracted', () => {
    const o = outstandingChecks([chk(1, 5000, '2026-08-01')], [], TODAY)
    expect(o.totalCents).toBe(0)
    expect(o.oldCents).toBe(5000)
  })
})

describe('spendVerdict — when to show a number at all', () => {
  const ok = { hasOperatingAccount: true, balanceStale: false, bankFailed: false, payrollFloorCents: 304032, criticalBillCount: 5, unconfirmedAmountBills: [], quiet: [], outstandingOldCents: 0, cardOwedCents: null, cardReservedCents: 0 }
  it('shows the number when the essentials are present', () => {
    expect(spendVerdict(ok)).toEqual({ showNumber: true, blockers: [], cautions: [] })
  })
  it('refuses a number when the balance is missing, stale or the bank connection is failing', () => {
    expect(spendVerdict({ ...ok, hasOperatingAccount: false }).showNumber).toBe(false)
    expect(spendVerdict({ ...ok, balanceStale: true }).showNumber).toBe(false)
    expect(spendVerdict({ ...ok, bankFailed: true }).blockers[0]).toMatch(/failing/)
  })
  it('refuses a number when no payroll or critical bills are on file (nothing would be held back)', () => {
    expect(spendVerdict({ ...ok, payrollFloorCents: 0 }).showNumber).toBe(false)
    expect(spendVerdict({ ...ok, criticalBillCount: 0 }).showNumber).toBe(false)
  })
  it('keeps the number but states what could move it', () => {
    const v = spendVerdict({ ...ok, unconfirmedAmountBills: ['IRS back-tax payment plan'], cardOwedCents: 1633953, cardReservedCents: 55600,
      quiet: [{ id: 'a', vendor: 'Evolve Impact Group', expectedCents: 75000, reason: 'no_payment_seen', lastDate: '2026-10-01', lastCents: 75000, daysSince: 47, message: '' }] })
    expect(v.showNumber).toBe(true)
    expect(v.cautions).toHaveLength(3)
    expect(v.cautions.join(' ')).toMatch(/\$16,339\.53.*\$556\.00/)
  })
})
