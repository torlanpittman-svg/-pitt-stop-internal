/**
 * GET /api/quickbooks/discover — READ-ONLY CFO Phase-0 discovery. Admin-gated (proxy.ts Basic
 * Auth). Runs ONLY read queries (SELECT) + read Reports (GET); it never creates, modifies,
 * deletes, pays, or transfers anything in QuickBooks. Returns a structured snapshot of the
 * company's financial structure so the CFO source inventory can be built from authoritative data.
 */
import { NextResponse } from 'next/server'
import { queryQBO, qbApiRequest, getCompanyInfo } from '@/apps/quickbooks/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/* eslint-disable @typescript-eslint/no-explicit-any */
const safe = async <T,>(fn: () => Promise<T>): Promise<{ ok: boolean; data?: T; error?: string }> => {
  try { return { ok: true, data: await fn() } } catch (e) { return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) } }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)

export async function GET(req: Request) {
  const now = new Date()

  // Read-only account-ledger investigation: ?tx=<accountId>&months=N → GeneralLedger rows for
  // that account (age / accumulation / whether balances are stale). SELECT/report GET only.
  const url = new URL(req.url)
  const txAccount = url.searchParams.get('tx')
  if (txAccount) {
    const months = Math.min(60, Math.max(1, parseInt(url.searchParams.get('months') ?? '24', 10) || 24))
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1))
    const gl = await safe(() => qbApiRequest<any>({ path: '/reports/GeneralLedger', query: {
      start_date: ymd(start), end_date: ymd(now), account: txAccount,
      columns: 'tx_date,txn_type,name,memo,subt_nat_amount,rbal_nat_amount',
    } }))
    return NextResponse.json({ ok: gl.ok, account: txAccount, months, generalLedger: gl.ok ? gl.data : { error: gl.error } })
  }

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  const report = (name: string, query: Record<string, string> = {}) =>
    qbApiRequest<any>({ path: `/reports/${name}`, query })

  const [company, accounts, vendors, openBills, employees, customersCount, purchases,
         pl, plLast, bs, agedAP, agedAR] = await Promise.all([
    safe(() => getCompanyInfo()),
    safe(() => queryQBO<{ Account?: any[] }>('SELECT * FROM Account MAXRESULTS 1000')),
    safe(() => queryQBO<{ Vendor?: any[] }>('SELECT * FROM Vendor MAXRESULTS 1000')),
    safe(() => queryQBO<{ Bill?: any[] }>("SELECT * FROM Bill WHERE Balance > '0' MAXRESULTS 1000")),
    safe(() => queryQBO<{ Employee?: any[] }>('SELECT * FROM Employee MAXRESULTS 200')),
    safe(() => queryQBO<{ totalCount?: number }>('SELECT COUNT(*) FROM Customer')),
    // A light 90-day expense sample (Purchase = card/check/cash spend) → recurring-vendor hints.
    safe(() => queryQBO<{ Purchase?: any[] }>(`SELECT * FROM Purchase WHERE TxnDate >= '${ymd(new Date(now.getTime() - 90 * 864e5))}' MAXRESULTS 1000`)),
    safe(() => report('ProfitAndLoss', { start_date: ymd(monthStart), end_date: ymd(now) })),
    safe(() => report('ProfitAndLoss', { start_date: ymd(lastMonthStart), end_date: ymd(lastMonthEnd) })),
    safe(() => report('BalanceSheet', { as_of: ymd(now) })),
    safe(() => report('AgedPayables', {})),
    safe(() => report('AgedReceivables', {})),
  ])

  // Parse the account list into a compact, classified shape (balances are QBO BOOK balances).
  const rawAccounts: any[] = accounts.ok ? (accounts.data?.Account ?? []) : []
  const accountList = rawAccounts.map((a) => ({
    id: a.Id, name: a.Name, fqName: a.FullyQualifiedName ?? a.Name,
    classification: a.Classification ?? null,   // Asset | Liability | Equity | Revenue | Expense
    type: a.AccountType ?? null,                 // Bank | Credit Card | Long Term Liability | ...
    subType: a.AccountSubType ?? null,
    currentBalance: a.CurrentBalance ?? null,    // BOOK balance (not a live bank/card balance)
    currency: a.CurrencyRef?.value ?? null,
    active: a.Active ?? null,
  }))
  const byType: Record<string, number> = {}
  for (const a of accountList) byType[a.type ?? 'Unknown'] = (byType[a.type ?? 'Unknown'] ?? 0) + 1

  const rawVendors: any[] = vendors.ok ? (vendors.data?.Vendor ?? []) : []
  const vendorList = rawVendors.map((v) => ({ id: v.Id, name: v.DisplayName ?? v.CompanyName, balance: v.Balance ?? 0, active: v.Active }))
    .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))

  const rawBills: any[] = openBills.ok ? (openBills.data?.Bill ?? []) : []
  const bills = rawBills.map((b) => ({ vendor: b.VendorRef?.name, total: b.TotalAmt, balance: b.Balance, txnDate: b.TxnDate, dueDate: b.DueDate }))

  const rawPurch: any[] = purchases.ok ? (purchases.data?.Purchase ?? []) : []
  // recurring-vendor hint: group 90-day Purchases by payee, count + total (NOT a bill list yet)
  const spendByPayee: Record<string, { count: number; total: number }> = {}
  for (const p of rawPurch) {
    const payee = p.EntityRef?.name || p.AccountRef?.name || '(unknown)'
    const amt = typeof p.TotalAmt === 'number' ? p.TotalAmt : 0
    const e = (spendByPayee[payee] ??= { count: 0, total: 0 }); e.count++; e.total += amt
  }
  const recurringHints = Object.entries(spendByPayee).map(([payee, v]) => ({ payee, ...v }))
    .filter((r) => r.count >= 2).sort((a, b) => b.total - a.total).slice(0, 40)

  return NextResponse.json({
    ok: true,
    generatedAt: now.toISOString(),
    company: company.data ?? company.error,
    accounts: { ok: accounts.ok, error: accounts.error, count: accountList.length, byType, list: accountList },
    vendors: { ok: vendors.ok, error: vendors.error, count: vendorList.length, list: vendorList },
    openBills: { ok: openBills.ok, error: openBills.error, count: bills.length, total: bills.reduce((s, b) => s + (b.balance ?? 0), 0), list: bills },
    employees: { ok: employees.ok, error: employees.error, count: (employees.data?.Employee ?? []).length, list: (employees.data?.Employee ?? []).map((e: any) => ({ name: e.DisplayName, active: e.Active })) },
    customers: { ok: customersCount.ok, error: customersCount.error, count: customersCount.data?.totalCount ?? null },
    recurringSpendHints90d: { ok: purchases.ok, error: purchases.error, list: recurringHints },
    reports: {
      profitAndLossThisMonth: pl.ok ? pl.data : { error: pl.error },
      profitAndLossLastMonth: plLast.ok ? plLast.data : { error: plLast.error },
      balanceSheet: bs.ok ? bs.data : { error: bs.error },
      agedPayables: agedAP.ok ? agedAP.data : { error: agedAP.error },
      agedReceivables: agedAR.ok ? agedAR.data : { error: agedAR.error },
    },
  })
}
