/**
 * READ-ONLY QuickBooks ingestion for the CFO model. Reuses the existing QBO client (accounting
 * scope). Upserts fin_accounts (cash/card/clearing), appends BOOK balance snapshots, upserts the
 * debt register from QBO notes (book, unverified), and stores report summaries (P&L / BS / A/R /
 * payroll liabilities / employees) on the sync run. NEVER writes to QuickBooks.
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { queryQBO, qbApiRequest, getCompanyInfo } from '@/apps/quickbooks/client'
import { finAccounts, finBalanceSnapshots, finDebts, finSyncRuns } from './schema'

/* eslint-disable @typescript-eslint/no-explicit-any */
const cents = (n: any) => Math.round((typeof n === 'number' ? n : parseFloat(n) || 0) * 100)

// Classify a QBO account into our CFO kind. Bank → cash; Credit Card → liability; Undeposited
// Funds + Clover clearing accounts → clearing (never counted as cash). Others are ignored here
// (notes/loans go to the debt register; income/expense/equity aren't balance accounts we track).
function classifyAccount(a: any): { kind: string; classification: string; isCash: boolean; isLiability: boolean; clearing: boolean } | null {
  const type = a.AccountType, sub = a.AccountSubType, name = (a.Name ?? '').toLowerCase()
  if (sub === 'UndepositedFunds' || name.includes('clover payments')) return { kind: 'clearing', classification: 'asset', isCash: false, isLiability: false, clearing: true }
  if (type === 'Bank') return { kind: 'bank', classification: 'asset', isCash: true, isLiability: false, clearing: false }
  if (type === 'Credit Card') return { kind: 'credit_card', classification: 'liability', isCash: false, isLiability: true, clearing: false }
  return null
}

// A QBO liability account we treat as debt: any Long Term Liability, or anything named "N/P …".
function isDebtAccount(a: any): boolean {
  return a.AccountType === 'Long Term Liability' || /^n\/p/i.test(a.Name ?? '')
}
function debtKind(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('floor plan')) return 'floor_plan'
  if (n.includes('loc') || n.includes('line of credit')) return 'loc'
  return 'term_loan'
}

const walk = (rows: any[], out: [string, string][]) => {
  for (const r of rows ?? []) {
    if (r.Summary?.ColData) { const cd = r.Summary.ColData; if (cd[0]?.value) out.push([cd[0].value, cd[cd.length - 1]?.value ?? '']) }
    if (r.Rows?.Row) walk(r.Rows.Row, out)
  }
}
const reportTotals = (rep: any): Record<string, number> => {
  if (!rep?.Rows?.Row) return {}
  const out: [string, string][] = []; walk(rep.Rows.Row, out)
  const m: Record<string, number> = {}
  for (const [k, v] of out) if (v !== '') m[k] = parseFloat(v) || 0
  return m
}
const pick = (m: Record<string, number>, ...keys: string[]) => {
  const rows = Object.keys(m)
  for (const kk of keys) {
    // Prefer an exact (case-insensitive) label; fall back to a substring match. This avoids
    // "Total Liabilities" accidentally matching "TOTAL LIABILITIES AND EQUITY".
    const exact = rows.find((k) => k.toLowerCase() === kk.toLowerCase())
    if (exact) return m[exact]
    const sub = rows.find((k) => k.toLowerCase().includes(kk.toLowerCase()) && !k.toLowerCase().includes('and equity'))
    if (sub) return m[sub]
  }
  return null
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)

export async function syncFromQbo(actor: string | null): Promise<{ ok: boolean; runId: string; summary: any; error?: string }> {
  const db = getDb()
  const now = new Date()
  const [run] = await db.insert(finSyncRuns).values({ source: 'qbo', status: 'partial', actor }).returning({ id: finSyncRuns.id })
  const summary: any = { accounts: 0, snapshots: 0, debts: 0 }
  try {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const lastStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const lastEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
    const report = (name: string, q: Record<string, string> = {}) => qbApiRequest<any>({ path: `/reports/${name}`, query: q })

    const [company, accRes, empRes, pl, plLast, bs, agedAR] = await Promise.all([
      getCompanyInfo().catch(() => null),
      queryQBO<{ Account?: any[] }>('SELECT * FROM Account MAXRESULTS 1000'),
      queryQBO<{ Employee?: any[] }>('SELECT * FROM Employee MAXRESULTS 500'),
      report('ProfitAndLoss', { start_date: ymd(monthStart), end_date: ymd(now) }).catch((e) => ({ __err: String(e) })),
      report('ProfitAndLoss', { start_date: ymd(lastStart), end_date: ymd(lastEnd) }).catch((e) => ({ __err: String(e) })),
      report('BalanceSheet', { as_of: ymd(now) }).catch((e) => ({ __err: String(e) })),
      report('AgedReceivables', {}).catch((e) => ({ __err: String(e) })),
    ])
    const accounts = accRes.Account ?? []

    // ── Accounts + balance snapshots (cash / card / clearing) ──
    for (const a of accounts) {
      const c = classifyAccount(a)
      if (!c) continue
      const [existing] = await db.select({ id: finAccounts.id }).from(finAccounts)
        .where(and(eq(finAccounts.externalSource, 'qbo'), eq(finAccounts.externalId, String(a.Id)))).limit(1)
      const vals = {
        name: a.Name, kind: c.kind, classification: c.classification, isCash: c.isCash, isLiability: c.isLiability,
        clearingSuspect: c.clearing, externalSource: 'qbo', externalId: String(a.Id),
        accountType: a.AccountType ?? null, accountSubType: a.AccountSubType ?? null,
        currency: a.CurrencyRef?.value ?? 'USD', active: a.Active ?? true, updatedAt: now,
      }
      let accountId: string
      if (existing) { await db.update(finAccounts).set(vals).where(eq(finAccounts.id, existing.id)); accountId = existing.id }
      else { const [ins] = await db.insert(finAccounts).values(vals).returning({ id: finAccounts.id }); accountId = ins.id }
      await db.insert(finBalanceSnapshots).values({
        accountId, balanceCents: cents(a.CurrentBalance ?? 0), asOf: now, source: 'qbo', confidence: 'book',
        raw: { currentBalance: a.CurrentBalance, type: a.AccountType, sub: a.AccountSubType },
      })
      summary.accounts++; summary.snapshots++
    }

    // ── Debt register (book, unverified) ──
    for (const a of accounts) {
      if ((a.Classification ?? '') !== 'Liability' || !isDebtAccount(a)) continue
      const principal = Math.abs(cents(a.CurrentBalance ?? 0))
      const [existing] = await db.select({ id: finDebts.id }).from(finDebts)
        .where(and(eq(finDebts.externalSource, 'qbo'), eq(finDebts.externalId, String(a.Id)))).limit(1)
      const vals = {
        name: a.Name, kind: debtKind(a.Name ?? ''), externalSource: 'qbo', externalId: String(a.Id),
        principalCents: principal, source: 'qbo', confidence: 'book', verified: false, asOf: now, updatedAt: now,
        notes: 'Seeded from QuickBooks book balance — APR / payment / maturity need a statement.',
      }
      if (existing) await db.update(finDebts).set({ principalCents: principal, asOf: now, updatedAt: now }).where(eq(finDebts.id, existing.id))
      else await db.insert(finDebts).values(vals)
      summary.debts++
    }

    // ── Report summaries (BOOK) stored on the run ──
    const plM = reportTotals(pl), plL = reportTotals(plLast), bsM = reportTotals(bs), arM = reportTotals(agedAR)
    const payrollLiab = accounts.filter((a: any) => a.AccountSubType === 'PayrollTaxPayable').map((a: any) => ({ name: a.Name, balance: a.CurrentBalance }))
    summary.company = company
    summary.plThisMonth = { income: pick(plM, 'Total Income'), expenses: pick(plM, 'Total Expenses'), net: pick(plM, 'Net Income'), grossProfit: pick(plM, 'Gross Profit') }
    summary.plLastMonth = { income: pick(plL, 'Total Income'), expenses: pick(plL, 'Total Expenses'), net: pick(plL, 'Net Income'), grossProfit: pick(plL, 'Gross Profit') }
    summary.balanceSheet = { totalAssets: pick(bsM, 'TOTAL ASSETS', 'Total Assets'), totalBank: pick(bsM, 'Total Bank Accounts'), totalLiabilities: pick(bsM, 'Total Liabilities'), totalEquity: pick(bsM, 'Total Equity'), totalCreditCards: pick(bsM, 'Total Credit Cards') }
    summary.arTotal = pick(arM, 'TOTAL', 'Total')
    summary.employeesCount = (empRes.Employee ?? []).length
    summary.employees = (empRes.Employee ?? []).map((e: any) => e.DisplayName)
    summary.payrollLiabilities = payrollLiab
    summary.reportErrors = { pl: (pl as any).__err, plLast: (plLast as any).__err, bs: (bs as any).__err, agedAR: (agedAR as any).__err }

    await db.update(finSyncRuns).set({ status: 'ok', finishedAt: new Date(), summary }).where(eq(finSyncRuns.id, run.id))
    return { ok: true, runId: run.id, summary }
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    await db.update(finSyncRuns).set({ status: 'error', finishedAt: new Date(), error: msg, summary }).where(eq(finSyncRuns.id, run.id))
    return { ok: false, runId: run.id, summary, error: msg }
  }
}
