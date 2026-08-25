/**
 * Financial Command Center — CFO Phase 1 (admin-only, desktop-first, READ-ONLY toward QuickBooks).
 * Server component behind the /admin ADMIN_PASSWORD gate (proxy.ts) + server actions for the few
 * manual inputs (payroll, obligation, document metadata) and the read-only QuickBooks refresh.
 * A QuickBooks BOOK balance is never presented as live cash. Safe-to-Spend + the 13-week forecast
 * are intentionally shown as UNAVAILABLE. No money movement anywhere.
 */
import { revalidatePath } from 'next/cache'
import { financeEnabled } from '@/apps/settings/db'
import { getAccounts, getDebts, getLatestPayroll, getObligations, getDocuments, getLatestSyncRun, getDataGaps, setNextPayroll, addObligation, addDocumentMeta, getPlaidConnections, verifyPlaidMapping, refreshPlaidBalances } from '@/apps/finance/db'
import { plaidDiagnostics } from '@/apps/finance/plaid'
import { freshnessLabel } from '@/apps/finance/sources'
import PlaidLinkButton from './PlaidLinkButton'

export const dynamic = 'force-dynamic'

const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dollars = (n: number | null | undefined) => n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function Badge({ confidence, asOf }: { confidence: string; asOf?: string }) {
  const map: Record<string, string> = {
    book: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
    live: 'bg-green-950/40 text-green-300 border-green-900/60',
    manual: 'bg-blue-950/40 text-blue-300 border-blue-900/60',
    manual_verified: 'bg-green-950/40 text-green-300 border-green-900/60',
    estimated: 'bg-gray-800 text-gray-300 border-gray-700',
  }
  const label = confidence === 'book' ? 'book · not live' : confidence === 'live' ? 'live' : confidence.replace('_', ' ')
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border ${map[confidence] ?? map.estimated}`}>{label}{asOf ? ` · ${freshnessLabel(asOf)}` : ''}</span>
}

// ── Server actions (manual inputs + read-only refresh) ──
async function refreshAction() {
  'use server'
  const { syncFromQbo } = await import('@/apps/finance/qbo-sync')
  await syncFromQbo('admin')
  revalidatePath('/admin/finance')
}
async function payrollAction(fd: FormData) {
  'use server'
  const date = String(fd.get('nextPayDate') ?? '')
  const amt = Math.round(parseFloat(String(fd.get('amount') ?? '')) * 100)
  if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(amt) && amt >= 0) {
    await setNextPayroll({ nextPayDate: date, expectedCashCents: amt, notes: String(fd.get('notes') ?? '') || undefined }, 'admin')
  }
  revalidatePath('/admin/finance')
}
async function obligationAction(fd: FormData) {
  'use server'
  const vendor = String(fd.get('vendor') ?? '').trim()
  if (vendor) {
    const amtRaw = String(fd.get('amount') ?? '')
    await addObligation({
      vendor, category: String(fd.get('category') ?? '') || undefined,
      amountCents: amtRaw ? Math.round(parseFloat(amtRaw) * 100) : undefined,
      frequency: String(fd.get('frequency') ?? '') || undefined,
      nextDue: /^\d{4}-\d{2}-\d{2}$/.test(String(fd.get('nextDue') ?? '')) ? String(fd.get('nextDue')) : undefined,
      essential: fd.get('essential') === 'on', notes: String(fd.get('notes') ?? '') || undefined,
    }, 'admin')
  }
  revalidatePath('/admin/finance')
}
async function verifyMappingAction(fd: FormData) {
  'use server'
  const plaidAccountId = String(fd.get('plaidAccountId') ?? '')
  const finAccountId = String(fd.get('finAccountId') ?? '')
  if (plaidAccountId && finAccountId) await verifyPlaidMapping({ plaidAccountId, finAccountId, actor: 'admin' })
  revalidatePath('/admin/finance')
}
async function refreshPlaidAction() {
  'use server'
  await refreshPlaidBalances('admin')
  revalidatePath('/admin/finance')
}
async function documentAction(fd: FormData) {
  'use server'
  // Phase 1: capture metadata only (no public file storage — secure storage is Phase 2).
  const type = String(fd.get('type') ?? '').trim()
  const filename = String(fd.get('filename') ?? '').trim()
  if (type && filename) {
    await addDocumentMeta({
      type, blobUrl: 'pending-secure-storage-phase2', filename,
      periodEnd: /^\d{4}-\d{2}-\d{2}$/.test(String(fd.get('asOf') ?? '')) ? String(fd.get('asOf')) : undefined,
      asOf: /^\d{4}-\d{2}-\d{2}$/.test(String(fd.get('asOf') ?? '')) ? String(fd.get('asOf')) : undefined,
      notes: String(fd.get('notes') ?? '') || undefined,
    }, 'admin')
  }
  revalidatePath('/admin/finance')
}

const input = 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white'
const card = 'rounded-2xl bg-gray-900 border border-gray-800 p-5'

export default async function FinancePage() {
  const [enabled, accounts, debts, payroll, obligations, documents, run, gaps, connections] = await Promise.all([
    financeEnabled(), getAccounts(), getDebts(), getLatestPayroll(), getObligations(), getDocuments(), getLatestSyncRun(), getDataGaps(), getPlaidConnections(),
  ])
  const plaid = plaidDiagnostics()
  const s = (run?.summary ?? {}) as any
  const cash = accounts.filter((a) => a.kind === 'bank')
  const cards = accounts.filter((a) => a.kind === 'credit_card')
  const clearing = accounts.filter((a) => a.clearingSuspect)
  const bankBookTotal = cash.reduce((t, a) => t + (a.balance?.cents ?? 0), 0)

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-8 py-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-3xl font-bold text-white">Financial Command Center</h1>
        <form action={refreshAction}><button className="bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-xl active:opacity-80">Refresh from QuickBooks</button></form>
      </div>
      <p className="text-gray-500 text-sm mb-1">QuickBooks <b>book</b> data · last synced {run ? freshnessLabel(run.startedAt) : 'never'} · read-only · admin-only</p>
      {!enabled && <p className="text-amber-400 text-xs mb-4">⚠ finance_enabled is OFF — shipped dark; not linked anywhere. Admin preview only.</p>}

      {/* Honesty banner: no live cash */}
      <div className="rounded-2xl border border-amber-900/60 bg-amber-950/20 px-5 py-3 mb-6">
        <p className="text-amber-300 text-sm"><b>No live bank/card data is connected.</b> Balances below are QuickBooks book figures — not verified live cash. <b>Safe-to-Spend and the 13-week forecast are unavailable</b> until live cash (Phase 2) and obligations (Phase 3) are connected.</p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        {/* Safe to Spend — intentionally unavailable */}
        <div className={card}>
          <p className="text-gray-500 text-xs uppercase tracking-widest">Safe to Spend</p>
          <p className="text-2xl font-bold text-gray-600 mt-1">Unavailable</p>
          <p className="text-gray-600 text-xs mt-1">Needs verified live bank balance + committed obligations.</p>
        </div>
        {/* Cash (book) */}
        <div className={card}>
          <p className="text-gray-500 text-xs uppercase tracking-widest">Bank cash (book)</p>
          <p className="text-2xl font-bold text-white mt-1">{money(bankBookTotal)} <span className="align-middle"><Badge confidence="book" /></span></p>
          <p className="text-gray-600 text-xs mt-1">QuickBooks book · not live cash.</p>
        </div>
        {/* 13-week forecast — unavailable */}
        <div className={card}>
          <p className="text-gray-500 text-xs uppercase tracking-widest">13-week forecast</p>
          <p className="text-2xl font-bold text-gray-600 mt-1">Unavailable</p>
          <p className="text-gray-600 text-xs mt-1">Arrives after Phases 2–6.</p>
        </div>
      </div>

      {/* Data Gaps / Required Inputs */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-3">Data Gaps / Required Inputs</h2>
        {gaps.length === 0 ? <p className="text-gray-500 text-sm">No gaps detected.</p> : (
          <ul className="space-y-1.5">
            {gaps.map((g) => (
              <li key={g.key} className="flex items-center gap-2 text-sm">
                <span className={`w-2 h-2 rounded-full ${g.severity === 'high' ? 'bg-red-500' : 'bg-amber-500'}`} />
                <span className="text-gray-300">{g.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Cash & Accounts */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-3">Cash &amp; Accounts <span className="text-gray-600 text-sm font-normal">(book — not live)</span></h2>
        <table className="w-full text-sm">
          <tbody>
            {[...cash, ...cards].map((a) => (
              <tr key={a.id} className="border-b border-gray-800">
                <td className="py-2 text-gray-300">{a.name}{a.institution ? ` · ${a.institution}` : ''}</td>
                <td className="py-2 text-gray-600">{a.kind === 'credit_card' ? 'Credit card' : 'Bank'}</td>
                <td className="py-2 text-right tabular-nums text-white">{money(a.balance?.cents)}</td>
                <td className="py-2 pl-3 text-right">{a.balance && <Badge confidence={a.balance.confidence} asOf={a.balance.asOf} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Bank Connections (live, read-only via Plaid) */}
      <div className={`${card} mb-6`}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-white font-bold text-lg">Bank Connections <span className="text-gray-600 text-sm font-normal">(Plaid · read-only · no money movement)</span></h2>
          {connections.length > 0 && <form action={refreshPlaidAction}><button className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Refresh balances</button></form>}
        </div>
        {!plaid.clientId || !plaid.secret ? (
          <p className="text-amber-400 text-sm mb-3">Plaid not configured yet (PLAID_CLIENT_ID / PLAID_SECRET). Set them in the environment to enable connecting.</p>
        ) : <p className="text-gray-500 text-xs mb-3">Environment: <b>{plaid.env}</b>{plaid.redirectUri ? ` · redirect ${plaid.redirectUri}` : ' · no redirect_uri set (required for OAuth/production)'}</p>}

        <div className="mb-4"><PlaidLinkButton /></div>

        {connections.length === 0 ? (
          <p className="text-gray-500 text-sm">No banks connected yet. The first target is <b>American Momentum → *2649 (operating)</b>.</p>
        ) : connections.map(({ item, accounts: pas }) => (
          <div key={item.id} className="mb-4 rounded-xl border border-gray-800 p-4">
            <p className="text-white font-semibold text-sm">{item.institutionName ?? 'Institution'} <span className="text-gray-600 font-normal">· {item.environment} · {item.status}{item.lastError ? ` · ${item.lastError}` : ''}</span></p>
            <table className="w-full text-sm mt-2"><tbody>
              {pas.map((a) => (
                <tr key={a.id} className="border-b border-gray-800 align-top">
                  <td className="py-2">
                    <p className="text-gray-200">{a.name}{a.mask ? ` ····${a.mask}` : ''}</p>
                    <p className="text-gray-600 text-xs">{a.type}{a.subtype ? `/${a.subtype}` : ''} · {a.currency ?? 'USD'} · as of {a.balanceAsOf ? freshnessLabel(a.balanceAsOf) : '—'}</p>
                  </td>
                  <td className="py-2 text-right">
                    <p className="text-white tabular-nums">Current {money(a.currentBalanceCents)}</p>
                    <p className="text-gray-400 tabular-nums text-xs">Available {money(a.availableBalanceCents)}</p>
                    <span className="text-[11px] px-2 py-0.5 rounded-full border bg-green-950/40 text-green-300 border-green-900/60">live · institution</span>
                  </td>
                  <td className="py-2 pl-4 text-right w-64">
                    {a.mappingVerified
                      ? <span className="text-green-400 text-xs">✓ Verified → mapped account</span>
                      : (
                        <form action={verifyMappingAction} className="flex items-center gap-1 justify-end">
                          <input type="hidden" name="plaidAccountId" value={a.plaidAccountId} />
                          <select name="finAccountId" className={input} defaultValue="">
                            <option value="" disabled>Verify this is…</option>
                            {accounts.filter((f) => f.kind === 'bank' || f.kind === 'credit_card').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                          </select>
                          <button className="bg-green-600 text-white text-xs font-semibold px-3 py-2 rounded-lg">Verify</button>
                        </form>
                      )}
                  </td>
                </tr>
              ))}
            </tbody></table>
            <p className="text-gray-600 text-xs mt-2">A discovered account is untrusted until you verify which QuickBooks account (e.g. *2649) it is. Verifying writes a <b>live</b> balance snapshot to that account.</p>
          </div>
        ))}
      </div>

      {/* Clearing / needs reconciliation */}
      {clearing.length > 0 && (
        <div className={`${card} mb-6 border-amber-900/40`}>
          <h2 className="text-amber-300 font-bold text-lg mb-1">Clearing / Needs reconciliation</h2>
          <p className="text-gray-500 text-xs mb-3">Unreconciled clearing accounts — <b>excluded from cash and from expected inflow</b>. Recommend a bookkeeper reconciliation. Not touched by this system.</p>
          {clearing.map((a) => (
            <div key={a.id} className="flex justify-between text-sm py-1"><span className="text-gray-300">{a.name}</span><span className="tabular-nums text-amber-300">{money(a.balance?.cents)} <Badge confidence="book" /></span></div>
          ))}
        </div>
      )}

      {/* Debt register */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-3">Debt register <span className="text-gray-600 text-sm font-normal">(book — terms need statements)</span></h2>
        <table className="w-full text-sm">
          <tbody>
            {debts.map((d) => (
              <tr key={d.id} className="border-b border-gray-800">
                <td className="py-2 text-gray-300">{d.name}</td>
                <td className="py-2 text-gray-600">{d.kind.replace('_', ' ')}</td>
                <td className="py-2 text-right tabular-nums text-white">{money(d.principalCents)}</td>
                <td className="py-2 pl-3 text-gray-600 text-xs">APR/payment/maturity: needs statement</td>
                <td className="py-2 pl-3 text-right"><Badge confidence={d.verified ? 'manual_verified' : 'book'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-gray-600 text-xs mt-2">Debt-service total: <b>unknown</b> until terms are verified.</p>
      </div>

      {/* Accounting (not cash) */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-1">Accounting <span className="text-gray-600 text-sm font-normal">(book — NOT a cash-flow view)</span></h2>
        <p className="text-gray-500 text-xs mb-3">QuickBooks P&amp;L understates real cash outflow (most spend runs through purchases/transfers). Do not read as cash.</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">P&amp;L this month</p>
            <p className="text-sm text-gray-300">Income {dollars(s.plThisMonth?.income)} · Expenses {dollars(s.plThisMonth?.expenses)} · Net {dollars(s.plThisMonth?.net)}</p>
            <p className="text-gray-500 text-xs uppercase tracking-widest mt-3 mb-1">P&amp;L last month</p>
            <p className="text-sm text-gray-300">Income {dollars(s.plLastMonth?.income)} · Expenses {dollars(s.plLastMonth?.expenses)} · Net {dollars(s.plLastMonth?.net)}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Balance sheet</p>
            <p className="text-sm text-gray-300">Assets {dollars(s.balanceSheet?.totalAssets)} · Liabilities {dollars(s.balanceSheet?.totalLiabilities)} · Equity {dollars(s.balanceSheet?.totalEquity)}</p>
            <p className="text-gray-500 text-xs uppercase tracking-widest mt-3 mb-1">A/R (aged)</p>
            <p className="text-sm text-gray-300">{dollars(s.arTotal)}</p>
          </div>
        </div>
      </div>

      {/* Payroll (manual) */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-1">Payroll <span className="text-gray-600 text-sm font-normal">(QuickBooks Payroll · manual next-run for now)</span></h2>
        {payroll ? (
          <p className="text-white text-sm mb-3">Next payroll <b>{payroll.nextPayDate}</b> · expected cash <b>{money(payroll.expectedCashCents)}</b> <Badge confidence="manual" asOf={String(payroll.asOf)} /> · by {payroll.enteredBy}</p>
        ) : <p className="text-amber-400 text-sm mb-3">No next payroll entered — needed to answer “can we make payroll this week?”</p>}
        <form action={payrollAction} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-gray-500">Next pay date<br /><input name="nextPayDate" type="date" className={input} required /></label>
          <label className="text-xs text-gray-500">Expected cash ($)<br /><input name="amount" type="number" step="0.01" min="0" className={input} required /></label>
          <label className="text-xs text-gray-500">Note<br /><input name="notes" className={input} /></label>
          <button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Save next payroll</button>
        </form>
        {Array.isArray(s.payrollLiabilities) && s.payrollLiabilities.length > 0 && (
          <p className="text-gray-600 text-xs mt-3">QBO payroll liabilities: {s.payrollLiabilities.map((p: any) => `${p.name} ${dollars(p.balance)}`).join(' · ')}</p>
        )}
        <p className="text-gray-600 text-xs mt-1">QuickBooks employees on file: {s.employeesCount ?? '—'}</p>
      </div>

      {/* Obligations (manual add only) */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-1">Recurring obligations <span className="text-gray-600 text-sm font-normal">(manual add only — automated discovery is Phase 3)</span></h2>
        {obligations.length === 0 ? <p className="text-gray-500 text-sm mb-3">None yet. Nothing is seeded from guesses.</p> : (
          <table className="w-full text-sm mb-3"><tbody>
            {obligations.map((o) => (
              <tr key={o.id} className="border-b border-gray-800">
                <td className="py-1.5 text-gray-300">{o.vendor}</td><td className="py-1.5 text-gray-600">{o.category ?? '—'}</td>
                <td className="py-1.5 text-gray-600">{o.frequency ?? '—'}</td><td className="py-1.5 text-right tabular-nums">{money(o.amountCents)}</td>
                <td className="py-1.5 pl-3 text-right"><Badge confidence="manual" asOf={String(o.asOf)} /></td>
                <td className="py-1.5 pl-2 text-gray-600 text-xs">by {o.enteredBy}</td>
              </tr>
            ))}
          </tbody></table>
        )}
        <form action={obligationAction} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-gray-500">Vendor<br /><input name="vendor" className={input} required /></label>
          <label className="text-xs text-gray-500">Category<br /><input name="category" className={input} /></label>
          <label className="text-xs text-gray-500">Amount ($)<br /><input name="amount" type="number" step="0.01" className={input} /></label>
          <label className="text-xs text-gray-500">Frequency<br /><input name="frequency" placeholder="monthly" className={input} /></label>
          <label className="text-xs text-gray-500">Next due<br /><input name="nextDue" type="date" className={input} /></label>
          <label className="text-xs text-gray-500 flex items-center gap-1"><input name="essential" type="checkbox" /> essential</label>
          <button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Add obligation</button>
        </form>
      </div>

      {/* Documents (metadata only in Phase 1) */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-1">Documents <span className="text-gray-600 text-sm font-normal">(metadata only in Phase 1 — secure file storage + extraction is Phase 2)</span></h2>
        {documents.length === 0 ? <p className="text-gray-500 text-sm mb-3">No documents recorded.</p> : (
          <ul className="text-sm mb-3 space-y-1">{documents.map((d) => <li key={d.id} className="text-gray-300">{d.type} · {d.filename} {d.asOf ? `· as-of ${d.asOf}` : ''} <Badge confidence="manual" asOf={String(d.createdAt)} /> · by {d.uploadedBy}</li>)}</ul>
        )}
        <form action={documentAction} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-gray-500">Type<br /><input name="type" placeholder="loan_statement" className={input} required /></label>
          <label className="text-xs text-gray-500">Filename / label<br /><input name="filename" className={input} required /></label>
          <label className="text-xs text-gray-500">As-of date<br /><input name="asOf" type="date" className={input} /></label>
          <label className="text-xs text-gray-500">Note<br /><input name="notes" className={input} /></label>
          <button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Record document</button>
        </form>
      </div>

      <p className="text-gray-700 text-xs">Reconciliation · CFO Agent · Monthly Package · live bank/card feeds — Phases 2–8.</p>
    </main>
  )
}
