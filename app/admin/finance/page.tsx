/**
 * Financial Command Center — CFO Phase 1 (admin-only, desktop-first, READ-ONLY toward QuickBooks).
 * Server component behind the /admin ADMIN_PASSWORD gate (proxy.ts) + server actions for the few
 * manual inputs (payroll, obligation, document metadata) and the read-only QuickBooks refresh.
 * A QuickBooks BOOK balance is never presented as live cash. Safe-to-Spend + the 13-week forecast
 * are intentionally shown as UNAVAILABLE. No money movement anywhere.
 */
import { revalidatePath } from 'next/cache'
import { financeEnabled } from '@/apps/settings/db'
import { getAccounts, getDebts, getLatestPayroll, getDocuments, getLatestSyncRun, getDataGaps, setNextPayroll, addDocumentMeta, getPlaidConnections, verifyPlaidMapping, refreshPlaidBalances, getOperatingCash, getAutoSalesLiquidity, setPlaidAccountStatus, setAccountStatus } from '@/apps/finance/db'
import { plaidDiagnostics } from '@/apps/finance/plaid'
import { ingestTransactions, getRecentTransactions, getClassificationSummary } from '@/apps/finance/transactions'
import { discoverObligations, getObligationsByStatus, setObligationStatus } from '@/apps/finance/obligations-discovery'
import { computeSafeToSpend, projectCashLow, forecastWithInflows, getObligationCalendar } from '@/apps/finance/safe-to-spend'
import { getExpectedInflows, getPipelineContext, addManualInflow, dismissInflow, deriveExpectedInflows } from '@/apps/finance/expected-inflows'
import { getReservePolicy } from '@/apps/settings/db'
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
async function syncTransactionsAction() {
  'use server'
  const { refreshPlaidBalances } = await import('@/apps/finance/db')
  await refreshPlaidBalances('admin')
  await ingestTransactions('admin')
  await discoverObligations('admin')
  revalidatePath('/admin/finance')
}
async function obligationStatusAction(fd: FormData) {
  'use server'
  const id = String(fd.get('id') ?? ''); const status = String(fd.get('status') ?? '') as 'confirmed' | 'ignored' | 'proposed'
  if (id && ['confirmed', 'ignored', 'proposed', 'paused'].includes(status)) await setObligationStatus(id, status as any, 'admin')
  revalidatePath('/admin/finance')
}
async function inflowAddAction(fd: FormData) {
  'use server'
  const label = String(fd.get('label') ?? '').trim()
  const amt = Math.round(parseFloat(String(fd.get('amount') ?? '')) * 100)
  const date = String(fd.get('expectedDate') ?? '')
  const confidence = String(fd.get('confidence') ?? 'probable') as 'high' | 'probable' | 'pipeline'
  if (label && Number.isFinite(amt) && amt > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    await addManualInflow({ label, amountCents: amt, expectedDate: date, confidence }, 'admin')
  }
  revalidatePath('/admin/finance')
}
async function inflowDismissAction(fd: FormData) {
  'use server'
  const id = String(fd.get('id') ?? '')
  if (id) await dismissInflow(id, 'admin')
  revalidatePath('/admin/finance')
}
async function deriveInflowsAction() {
  'use server'
  await deriveExpectedInflows('admin', 21)
  revalidatePath('/admin/finance')
}
async function reservesAction(fd: FormData) {
  'use server'
  const { updateSetting } = await import('@/apps/settings/db')
  const toCents = (v: string) => Math.round((parseFloat(v) || 0) * 100)
  await updateSetting('payroll_reserve_cents', toCents(String(fd.get('payroll') ?? '0')), 'admin')
  await updateSetting('tax_reserve_cents', toCents(String(fd.get('tax') ?? '0')), 'admin')
  await updateSetting('min_operating_buffer_cents', toCents(String(fd.get('buffer') ?? '0')), 'admin')
  await updateSetting('reserves_configured', true, 'admin')
  revalidatePath('/admin/finance')
}
async function plaidStatusAction(fd: FormData) {
  'use server'
  const plaidAccountId = String(fd.get('plaidAccountId') ?? '')
  const status = String(fd.get('status') ?? '') as 'active' | 'ignored' | 'closed'
  const entityNote = String(fd.get('entityNote') ?? '') || undefined
  if (plaidAccountId && ['active', 'ignored', 'closed'].includes(status)) await setPlaidAccountStatus({ plaidAccountId, status, entityNote, actor: 'admin' })
  revalidatePath('/admin/finance')
}
async function accountStatusAction(fd: FormData) {
  'use server'
  const finAccountId = String(fd.get('finAccountId') ?? '')
  const status = String(fd.get('status') ?? '') as 'active' | 'ignored' | 'closed'
  if (finAccountId && ['active', 'ignored', 'closed'].includes(status)) await setAccountStatus({ finAccountId, status, actor: 'admin' })
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
  const [enabled, accounts, allAccounts, debts, payroll, documents, run, gaps, connections, operating, recentTx, txSummary, s2s, projection, oblByStatus, reserves, autoSales] = await Promise.all([
    financeEnabled(), getAccounts(), getAccounts({ includeInactive: true }), getDebts(), getLatestPayroll(), getDocuments(), getLatestSyncRun(), getDataGaps(), getPlaidConnections(), getOperatingCash(), getRecentTransactions(30), getClassificationSummary(120), computeSafeToSpend(21), projectCashLow(21), getObligationsByStatus(), getReservePolicy(), getAutoSalesLiquidity(),
  ])
  const [forecast, expectedInflows, pipeline, calendar] = await Promise.all([forecastWithInflows(21), getExpectedInflows(21), getPipelineContext(), getObligationCalendar(30)])
  const plaid = plaidDiagnostics()
  const s = (run?.summary ?? {}) as any
  const cash = accounts.filter((a) => a.kind === 'bank' && !a.clearingSuspect)
  const cards = accounts.filter((a) => a.kind === 'credit_card')
  const clearing = accounts.filter((a) => a.clearingSuspect)
  const inactiveAccounts = allAccounts.filter((a) => a.status !== 'active')
  const bankBookTotal = cash.reduce((t, a) => t + (a.balance?.cents ?? 0), 0)
  // Live operating available (verified *2649) is the trustworthy spendable-cash foundation.
  const opAvail = operating?.availableCents ?? null
  const opCurrent = operating?.currentCents ?? null

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-8 py-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-3xl font-bold text-white">Financial Command Center</h1>
        <form action={refreshAction}><button className="bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-xl active:opacity-80">Refresh from QuickBooks</button></form>
      </div>
      <p className="text-gray-500 text-sm mb-1">QuickBooks <b>book</b> data · last synced {run ? freshnessLabel(run.startedAt) : 'never'} · read-only · admin-only</p>
      {!enabled && <p className="text-amber-400 text-xs mb-4">⚠ finance_enabled is OFF — shipped dark; not linked anywhere. Admin preview only.</p>}

      {/* Honesty banner: live cash IS connected; Safe-to-Spend still needs reserves + obligations */}
      <div className="rounded-2xl border border-green-900/50 bg-green-950/15 px-5 py-3 mb-6">
        <p className="text-green-300 text-sm"><b>Live bank/card data is connected (Plaid, read-only).</b> Live institution balances are shown beside QuickBooks book — never substituted. <b>Safe-to-Spend is not yet fully trustworthy</b>: it needs verified payroll, dated obligations, and a chosen reserve policy (all still unset). Live cash below is real; the forecast is not built yet.</p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        {/* Operating available (live *2649) — the Safe-to-Spend foundation */}
        <div className={card}>
          <p className="text-gray-500 text-xs uppercase tracking-widest">Operating available (live)</p>
          <p className="text-2xl font-bold text-white mt-1">{money(opAvail)} {operating && <span className="align-middle"><Badge confidence="live" asOf={operating.asOf} /></span>}</p>
          <p className="text-gray-600 text-xs mt-1">{operating ? <>American Momentum *{operating.mask} · available now. Current {money(opCurrent)}.</> : 'No verified operating account.'}</p>
        </div>
        {/* Safe to Spend — core (after critical+contractual+reserves), honestly flagged */}
        <div className={card}>
          <p className="text-gray-500 text-xs uppercase tracking-widest">Core Safe-to-Spend {s2s.trustworthy ? '' : '(provisional)'}</p>
          <p className={`text-2xl font-bold mt-1 ${(s2s.coreSafeToSpendCents ?? 0) < 0 ? 'text-red-400' : s2s.trustworthy ? 'text-white' : 'text-amber-400'}`}>{money(s2s.coreSafeToSpendCents)}</p>
          <p className="text-gray-600 text-xs mt-1">After payroll, taxes, rent, debt &amp; reserves (next {s2s.horizonDays}d). After Darryl draw: <b>{money(s2s.afterPlannedCents)}</b>.</p>
        </div>
        {/* Bank cash (book) — reference only */}
        <div className={card}>
          <p className="text-gray-500 text-xs uppercase tracking-widest">Bank cash (book)</p>
          <p className="text-2xl font-bold text-gray-300 mt-1">{money(bankBookTotal)} <span className="align-middle"><Badge confidence="book" /></span></p>
          <p className="text-gray-600 text-xs mt-1">QuickBooks book · reference, not spendable cash.</p>
        </div>
      </div>

      {/* Data Gaps / Required Inputs — dynamic; each resolves automatically when verified */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-1">Data Gaps / Required Inputs</h2>
        <p className="text-gray-500 text-xs mb-3">Live audit — a gap disappears automatically once its requirement is verified. Each shows why it matters, the source, and what it blocks.</p>
        {gaps.length === 0 ? <p className="text-green-400 text-sm">✓ No gaps — all inputs verified.</p> : (
          <ul className="space-y-2.5">
            {gaps.map((g) => {
              const blockLabels: Record<string, string> = { safe_to_spend: 'Safe-to-Spend', forecast: 'Forecast', debt_optimization: 'Debt optimizer', confidence: 'Confidence only' }
              return (
                <li key={g.key} className="flex items-start gap-2 text-sm">
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${g.severity === 'high' ? 'bg-red-500' : g.severity === 'medium' ? 'bg-amber-500' : 'bg-gray-500'}`} />
                  <div>
                    <p className="text-gray-200">{g.label}</p>
                    <p className="text-gray-500 text-xs">{g.why} <span className="text-gray-600">· Source: {g.source}</span></p>
                    <div className="flex gap-1 mt-0.5">
                      {g.blocks.map((b) => <span key={b} className={`text-[10px] px-1.5 py-0.5 rounded-full border ${b === 'confidence' ? 'bg-gray-800 text-gray-400 border-gray-700' : 'bg-red-950/30 text-red-300/80 border-red-900/50'}`}>{b === 'confidence' ? 'improves confidence' : `blocks ${blockLabels[b]}`}</span>)}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Cash & Accounts — live beside book, never substituted */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-3">Cash &amp; Accounts <span className="text-gray-600 text-sm font-normal">(live institution cash · book for reference)</span></h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-600 text-xs uppercase tracking-wider">
              <th className="text-left font-normal py-1">Account</th>
              <th className="text-right font-normal py-1">Live current</th>
              <th className="text-right font-normal py-1">Live available</th>
              <th className="text-right font-normal py-1 pl-4">Book</th>
              <th className="py-1"></th>
            </tr>
          </thead>
          <tbody>
            {[...cash, ...cards].map((a) => (
              <tr key={a.id} className="border-b border-gray-800">
                <td className="py-2 text-gray-300">{a.name}{a.live?.mask ? ` ····${a.live.mask}` : ''}<span className="text-gray-600"> · {a.kind === 'credit_card' ? 'Credit card' : 'Bank'}</span></td>
                <td className="py-2 text-right tabular-nums text-white">{a.live ? money(a.live.currentCents) : <span className="text-gray-700">—</span>}</td>
                <td className="py-2 text-right tabular-nums text-green-300">{a.live ? money(a.live.availableCents) : <span className="text-gray-700">—</span>}</td>
                <td className="py-2 pl-4 text-right tabular-nums text-gray-500">{money(a.balance?.cents)}</td>
                <td className="py-2 pl-3 text-right">{a.live ? <Badge confidence="live" asOf={a.live.asOf} /> : <Badge confidence="book" />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-gray-600 text-xs mt-2">Live = Plaid institution balance (spendable). Book = QuickBooks (reference; often diverges). Auto-sales *5600 is real cash but is <b>not</b> operating Safe-to-Spend.</p>
        {inactiveAccounts.length > 0 && (
          <div className="mt-4 pt-3 border-t border-gray-800">
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Closed / ignored — excluded from cash &amp; calculations</p>
            {inactiveAccounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between text-sm py-1">
                <span className="text-gray-500 line-through">{a.name}</span>
                <span className="flex items-center gap-3">
                  <span className="text-[11px] px-2 py-0.5 rounded-full border bg-gray-800 text-gray-400 border-gray-700">{a.status}</span>
                  <form action={accountStatusAction}><input type="hidden" name="finAccountId" value={a.id} /><input type="hidden" name="status" value="active" /><button className="text-xs text-gray-500 underline">re-activate</button></form>
                </span>
              </div>
            ))}
          </div>
        )}
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
              {pas.map((a) => {
                const ignored = a.status !== 'active'
                return (
                <tr key={a.id} className={`border-b border-gray-800 align-top ${ignored ? 'opacity-45' : ''}`}>
                  <td className="py-2">
                    <p className="text-gray-200">{a.name}{a.mask ? ` ····${a.mask}` : ''}
                      {ignored && <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full border bg-gray-800 text-gray-400 border-gray-700">{a.status}</span>}
                      {a.entityNote && <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full border bg-purple-950/40 text-purple-300 border-purple-900/60">{a.entityNote}</span>}
                    </p>
                    <p className="text-gray-600 text-xs">{a.type}{a.subtype ? `/${a.subtype}` : ''} · {a.currency ?? 'USD'} · as of {a.balanceAsOf ? freshnessLabel(a.balanceAsOf) : '—'}</p>
                  </td>
                  <td className="py-2 text-right">
                    <p className="text-white tabular-nums">Current {money(a.currentBalanceCents)}</p>
                    <p className="text-gray-400 tabular-nums text-xs">Available {money(a.availableBalanceCents)}</p>
                    {!ignored && <span className="text-[11px] px-2 py-0.5 rounded-full border bg-green-950/40 text-green-300 border-green-900/60">live · institution</span>}
                  </td>
                  <td className="py-2 pl-4 text-right w-72">
                    {ignored ? (
                      <form action={plaidStatusAction}><input type="hidden" name="plaidAccountId" value={a.plaidAccountId} /><input type="hidden" name="status" value="active" /><button className="text-xs text-gray-400 underline">un-ignore</button></form>
                    ) : (<>
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
                      <form action={plaidStatusAction} className="mt-1"><input type="hidden" name="plaidAccountId" value={a.plaidAccountId} /><input type="hidden" name="status" value="ignored" /><button className="text-[11px] text-gray-600 underline">exclude from CFO</button></form>
                    </>)}
                  </td>
                </tr>
                )
              })}
            </tbody></table>
            <p className="text-gray-600 text-xs mt-2">A discovered account is untrusted until you verify which QuickBooks account (e.g. *2649) it is. Verifying writes a <b>live</b> balance snapshot to that account. “Exclude from CFO” keeps an account connected upstream but out of all cash/Safe-to-Spend math.</p>
          </div>
        ))}
      </div>

      {/* Transactions (live, classified) */}
      <div className={`${card} mb-6`}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-white font-bold text-lg">Transactions <span className="text-gray-600 text-sm font-normal">(Plaid · classified for cash integrity)</span></h2>
          <form action={syncTransactionsAction}><button className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Sync now</button></form>
        </div>
        <p className="text-gray-500 text-xs mb-3">Transfers, card payments, debt payments and payroll are flagged as <b>cash movement, not expenses</b> — so a transfer or an Amex payment is never double-counted as spend. Classification is advisory (evidence-backed); it never rewrites a balance.</p>
        {txSummary.total === 0 ? (
          <p className="text-gray-500 text-sm">No transactions ingested yet. Click <b>Sync now</b> (or the daily cron will populate them).</p>
        ) : (<>
          <div className="flex flex-wrap gap-2 mb-4">
            {txSummary.rows.map((r) => (
              <div key={r.txnClass} className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-1.5">
                <span className="text-gray-300 text-xs font-medium">{r.txnClass}</span>
                <span className="text-gray-600 text-xs"> · {r.n}</span>
                {r.outCents > 0 && <span className="text-red-300/80 text-xs tabular-nums"> · out {money(r.outCents)}</span>}
                {r.inCents > 0 && <span className="text-green-300/80 text-xs tabular-nums"> · in {money(r.inCents)}</span>}
              </div>
            ))}
          </div>
          <p className="text-gray-600 text-xs mb-2">Last {txSummary.total} transactions · {txSummary.pending} pending · window since {txSummary.since}</p>
          <table className="w-full text-sm">
            <tbody>
              {recentTx.map((t) => (
                <tr key={t.id} className="border-b border-gray-800/60">
                  <td className="py-1.5 text-gray-500 text-xs whitespace-nowrap">{t.txnDate}{t.pending && <span className="ml-1 text-amber-500">pending</span>}</td>
                  <td className="py-1.5 text-gray-300">{(t.merchantName || t.name || '').slice(0, 48)}</td>
                  <td className="py-1.5"><span className="text-[11px] px-2 py-0.5 rounded-full border bg-gray-800 text-gray-400 border-gray-700">{t.txnClass}</span></td>
                  <td className="py-1.5 text-right tabular-nums text-gray-300">{t.direction === 'out' ? '-' : '+'}{money(Math.abs(t.amountCents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>)}
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

      {/* Upcoming-obligations CALENDAR (per account, 7/14/30-day) */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-1">Upcoming obligations calendar <span className="text-gray-600 text-sm font-normal">(what leaves each account · next 30 days)</span></h2>
        <div className="grid grid-cols-3 gap-4 my-3">
          <div><p className="text-gray-500 text-xs uppercase tracking-widest">Next 7 days</p><p className="text-2xl font-bold text-red-300 mt-1">{money(calendar.window7Cents)}</p></div>
          <div><p className="text-gray-500 text-xs uppercase tracking-widest">Next 14 days</p><p className="text-2xl font-bold text-red-300 mt-1">{money(calendar.window14Cents)}</p></div>
          <div><p className="text-gray-500 text-xs uppercase tracking-widest">Next 30 days</p><p className="text-2xl font-bold text-red-300 mt-1">{money(calendar.window30Cents)}</p></div>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {calendar.byAccount.map((a) => (
            <div key={a.account} className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-1.5 text-xs">
              <span className="text-gray-300 font-medium">{a.account}</span>
              <span className="text-gray-600"> · 7d </span><span className="text-red-300/80 tabular-nums">{money(a.window7)}</span>
              <span className="text-gray-600"> · 30d </span><span className="text-red-300/80 tabular-nums">{money(a.window30)}</span>
            </div>
          ))}
        </div>
        <table className="w-full text-sm">
          <tbody>
            {calendar.events.map((e, i) => {
              const dt = new Date(e.due + 'T00:00:00Z'); const dow = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
              const pc = e.priority === 'critical' ? 'text-red-400' : e.priority === 'contractual' ? 'text-amber-400' : 'text-gray-500'
              return (
                <tr key={i} className="border-b border-gray-800/50">
                  <td className="py-1 text-gray-500 text-xs whitespace-nowrap">{e.due} <span className="text-gray-600">{dow}</span></td>
                  <td className="py-1 text-gray-300">{e.label}</td>
                  <td className="py-1"><span className={`text-[10px] ${pc}`}>● {e.priority}</span></td>
                  <td className="py-1 text-gray-600 text-xs">{e.account.replace('Pitt Stop ', '')}</td>
                  <td className="py-1 text-right tabular-nums text-red-300">−{money(e.cents)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="text-gray-600 text-xs mt-2">Per-account: obligations paid from *5600 (auto-sales — F250, floor-plan, RLOC) do <b>not</b> reduce *2649 operating Safe-to-Spend. QB Capital + payroll + rent + owner draw pay from *2649.</p>
      </div>

      {/* STRICT: how much can I spend today from VERIFIED cash */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-1">How much can I spend today? <span className="text-gray-600 text-sm font-normal">(STRICT · verified cash only · operating *2649 · {projection.horizonDays}d)</span></h2>
        <p className="text-gray-500 text-xs mb-2">Verified bank cash − confirmed obligations. Expected customer/dealer money is <b>not</b> counted here — see the forecast below.</p>
        {s2s.disclosures.length > 0 && (
          <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 mb-3">
            {s2s.disclosures.map((dsc, i) => <p key={i} className="text-amber-300/90 text-xs">⚠ {dsc}</p>)}
          </div>
        )}
        <div className="grid grid-cols-2 gap-6">
          <div>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b border-gray-700"><td className="py-1.5 text-gray-200 font-medium">Operating available (live)</td><td className="py-1.5 text-right tabular-nums text-white">{money(s2s.availableCents)}</td></tr>
                {s2s.critical.length > 0 && <tr><td colSpan={2} className="pt-2 text-gray-500 text-[11px] uppercase tracking-widest">Critical (non-discretionary)</td></tr>}
                {s2s.critical.map((d, i) => (
                  <tr key={'c' + i} className="border-b border-gray-800/50"><td className="py-1 text-gray-400">− {d.label} <span className="text-gray-600 text-xs">due {d.due}</span></td><td className="py-1 text-right tabular-nums text-red-300">{money(d.cents)}</td></tr>
                ))}
                {s2s.contractual.length > 0 && <tr><td colSpan={2} className="pt-2 text-gray-500 text-[11px] uppercase tracking-widest">Contractual</td></tr>}
                {s2s.contractual.map((d, i) => (
                  <tr key={'k' + i} className="border-b border-gray-800/50"><td className="py-1 text-gray-400">− {d.label} <span className="text-gray-600 text-xs">due {d.due}</span></td><td className="py-1 text-right tabular-nums text-red-300">{money(d.cents)}</td></tr>
                ))}
                <tr className="border-b border-gray-800/50"><td className="py-1 text-gray-400">− Reserves {reserves.configured ? '' : '(unconfigured)'}</td><td className="py-1 text-right tabular-nums text-red-300">{money(s2s.reservesCents)}</td></tr>
                <tr className="border-t border-gray-700"><td className="py-2 text-gray-100 font-bold">Core Safe-to-Spend</td><td className={`py-2 text-right tabular-nums font-bold ${(s2s.coreSafeToSpendCents ?? 0) < 0 ? 'text-red-400' : 'text-white'}`}>{money(s2s.coreSafeToSpendCents)}</td></tr>
                {s2s.planned.map((d, i) => (
                  <tr key={'p' + i}><td className="py-1 text-gray-500">− {d.label} <span className="text-gray-600 text-xs">planned · deferrable · due {d.due}</span></td><td className="py-1 text-right tabular-nums text-gray-400">{money(d.cents)}</td></tr>
                ))}
                <tr className="border-t border-gray-800"><td className="py-2 text-gray-300 font-semibold">After planned owner draw</td><td className={`py-2 text-right tabular-nums font-semibold ${(s2s.afterPlannedCents ?? 0) < 0 ? 'text-red-400' : 'text-gray-200'}`}>{money(s2s.afterPlannedCents)}</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Near-term projection</p>
            {projection.startCents == null ? <p className="text-gray-500 text-sm">No verified operating balance.</p> : (<>
              <p className="text-sm text-gray-300">Start available <b className="text-white">{money(projection.startCents)}</b></p>
              <p className={`text-sm ${projection.overdraftRisk ? 'text-red-400' : 'text-gray-300'}`}>Projected low <b>{money(projection.lowCents)}</b> on {projection.lowDate}
                {projection.overdraftRisk && <> — ⚠ overdraft risk on {projection.overdraftDate} ({projection.overdraftCause})</>}</p>
              {projection.payrollDate && (
                <p className={`text-sm ${projection.payrollCovered ? 'text-green-400' : 'text-amber-400'}`}>
                  First payroll {projection.payrollDate}: from <b>verified cash alone</b>, projected {money(projection.payrollBalanceAfter)}{projection.payrollCovered ? ' — covered' : ' — not covered by current verified cash alone (expected inflows below may cover it)'}
                </p>
              )}
              <table className="w-full text-xs mt-2"><tbody>
                {projection.points.map((p, i) => (
                  <tr key={i} className={p.balanceCents < 0 ? 'text-red-300' : ''}>
                    <td className="py-0.5 text-gray-500">{p.date}</td>
                    <td className="py-0.5 text-gray-400">{p.priority === 'planned' ? '○' : '●'} {p.label.slice(0, 26)}</td>
                    <td className="py-0.5 text-right tabular-nums text-red-300/80">{money(p.deltaCents)}</td>
                    <td className={`py-0.5 text-right tabular-nums ${p.balanceCents < 0 ? 'text-red-400 font-semibold' : 'text-gray-300'}`}>{money(p.balanceCents)}</td>
                  </tr>
                ))}
              </tbody></table>
              <p className="text-gray-600 text-[11px] mt-1">● committed · ○ planned/deferrable. Projection applies only dated obligations — no assumed new deposits.</p>
            </>)}
          </div>
        </div>
      </div>

      {/* FORECAST: are we EXPECTED to meet obligations? (expected inflows by confidence) */}
      <div className={`${card} mb-6 border-green-900/40`}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-white font-bold text-lg">Are we expected to meet obligations? <span className="text-gray-600 text-sm font-normal">(FORECAST · adds expected inflows by confidence)</span></h2>
          <form action={deriveInflowsAction}><button className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Re-derive inflows</button></form>
        </div>
        <p className="text-gray-500 text-xs mb-3">Expected inflows are modeled here <b>only</b> — they never inflate strict Safe-to-Spend. Scenarios layer inflows by confidence so you see risk vs reality.</p>
        {/* Scenario cards */}
        <div className="grid grid-cols-3 gap-4 mb-4">
          {forecast.scenarios.map((s) => {
            const label = s.scenario === 'verified_only' ? 'Verified cash only' : s.scenario === 'high_confidence' ? '+ High-confidence inflows' : '+ All probable inflows'
            return (
              <div key={s.scenario} className={`rounded-xl border p-3 ${s.overdraftRisk ? 'border-red-900/50 bg-red-950/15' : 'border-green-900/50 bg-green-950/10'}`}>
                <p className="text-gray-400 text-xs font-medium">{label}</p>
                <p className={`text-lg font-bold mt-1 ${s.overdraftRisk ? 'text-red-400' : 'text-green-300'}`}>Low {money(s.lowCents)}</p>
                <p className="text-gray-600 text-[11px]">on {s.lowDate} · ending {money(s.endingCents)}</p>
                {s.firstPayrollDate && (
                  <p className={`text-[11px] mt-1 ${s.firstPayrollCovered ? 'text-green-400' : 'text-red-400'}`}>
                    {s.firstPayrollCovered ? '✓' : '✗'} Payroll {s.firstPayrollDate}: {money(s.firstPayrollBalance)}
                  </p>
                )}
              </div>
            )
          })}
        </div>
        <p className="text-gray-500 text-xs mb-2">
          Critical obligations (21d): <b className="text-red-300">{money(-forecast.criticalBeforeInflowCents)}</b> ·
          High-confidence expected in: <b className="text-green-300">{money(forecast.expectedHighCents)}</b> ·
          Probable: <b className="text-green-300/80">{money(forecast.expectedProbableCents)}</b>
        </p>
        {/* Expected inflow list */}
        <table className="w-full text-sm mb-3"><tbody>
          {expectedInflows.slice(0, 14).map((inf) => (
            <tr key={inf.id} className="border-b border-gray-800/50">
              <td className="py-1 text-gray-500 text-xs whitespace-nowrap">{inf.expectedDate}</td>
              <td className="py-1 text-gray-300">{inf.label}</td>
              <td className="py-1"><span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${inf.confidence === 'high' ? 'bg-green-950/40 text-green-300 border-green-900/60' : inf.confidence === 'probable' ? 'bg-amber-950/40 text-amber-300 border-amber-900/60' : 'bg-gray-800 text-gray-400 border-gray-700'}`}>{inf.confidence}</span>{!inf.derived && <span className="text-gray-600 text-[10px] ml-1">manual</span>}</td>
              <td className="py-1 text-right tabular-nums text-green-300">+{money(inf.amountCents)}</td>
              <td className="py-1 pl-2 text-right">{!inf.derived && <form action={inflowDismissAction}><input type="hidden" name="id" value={inf.id} /><button className="text-gray-600 text-[11px] underline">dismiss</button></form>}</td>
            </tr>
          ))}
        </tbody></table>
        <p className="text-gray-600 text-xs mb-2">Pipeline context (real work, amounts not always priced on the order): <b>{pipeline.dealerThisWeek}</b> dealer jobs this week · <b>{pipeline.readyRetail}</b> retail ready for pickup · <b>{pipeline.activeDealer}</b> active dealer jobs. Add specific known jobs (e.g. a ceramic coating) as manual inflows:</p>
        <form action={inflowAddAction} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-gray-500">What<br /><input name="label" placeholder="Ceramic coating — J. Smith" className={input} required /></label>
          <label className="text-xs text-gray-500">Amount ($)<br /><input name="amount" type="number" step="0.01" className={input} required /></label>
          <label className="text-xs text-gray-500">Expected date<br /><input name="expectedDate" type="date" className={input} required /></label>
          <label className="text-xs text-gray-500">Confidence<br /><select name="confidence" className={input} defaultValue="probable"><option value="high">high</option><option value="probable">probable</option><option value="pipeline">pipeline</option></select></label>
          <button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Add expected inflow</button>
        </form>
      </div>

      {/* Auto-Sales liquidity (*5600) — separate; encumbrance-aware */}
      <div className={`${card} mb-6 border-blue-900/40`}>
        <h2 className="text-white font-bold text-lg mb-1">Auto-Sales liquidity <span className="text-gray-600 text-sm font-normal">(Extraco *5600 · separate from operating)</span></h2>
        <div className="grid grid-cols-3 gap-4">
          <div><p className="text-gray-500 text-xs uppercase tracking-widest">Bank cash</p><p className="text-xl font-bold text-white mt-1">{money(autoSales.bankAvailableCents)}</p></div>
          <div><p className="text-gray-500 text-xs uppercase tracking-widest">Floor-plan owed (inventory)</p><p className="text-xl font-bold text-gray-400 mt-1">{autoSales.floorPlanBalanceCents == null ? '—' : money(autoSales.floorPlanBalanceCents)}</p></div>
          <div><p className="text-gray-500 text-xs uppercase tracking-widest">Unencumbered</p><p className="text-xl font-bold text-amber-400 mt-1">{autoSales.unencumberedCents == null ? 'Unknown' : money(autoSales.unencumberedCents)}</p></div>
        </div>
        <p className="text-amber-300/80 text-xs mt-2">⚠ {autoSales.note} Do NOT treat this as available operating cash; transfers *5600↔*2649 are inter-account liquidity, not income/expense.</p>
      </div>

      {/* Reserve policy */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-1">Reserve policy <span className="text-gray-600 text-sm font-normal">{reserves.configured ? '(configured)' : '(UNCONFIGURED — $0 assumed, not a decision that none are needed)'}</span></h2>
        <p className="text-gray-500 text-xs mb-3">Until set, Safe-to-Spend can’t be fully trusted. Later the CFO will recommend targets from cash-flow history.</p>
        <form action={reservesAction} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-gray-500">Payroll reserve ($)<br /><input name="payroll" type="number" step="0.01" defaultValue={(reserves.payrollReserveCents / 100) || ''} className={input} /></label>
          <label className="text-xs text-gray-500">Tax reserve ($)<br /><input name="tax" type="number" step="0.01" defaultValue={(reserves.taxReserveCents / 100) || ''} className={input} /></label>
          <label className="text-xs text-gray-500">Min operating buffer ($)<br /><input name="buffer" type="number" step="0.01" defaultValue={(reserves.minBufferCents / 100) || ''} className={input} /></label>
          <button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Save reserve policy</button>
        </form>
      </div>

      {/* Recurring obligations — discovered proposals + confirmed */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold text-lg mb-1">Recurring obligations <span className="text-gray-600 text-sm font-normal">(auto-discovered from *2649 · Confirm / Ignore)</span></h2>
        <p className="text-gray-500 text-xs mb-3">Proposals are evidence-backed and <b>never</b> authoritative until you confirm. Critical (payroll/rent/debt) drive Safe-to-Spend + the projection.</p>
        {oblByStatus.confirmed.length > 0 && (
          <table className="w-full text-sm mb-3"><tbody>
            {oblByStatus.confirmed.map((o) => (
              <tr key={o.id} className="border-b border-gray-800">
                <td className="py-1.5 text-gray-200">{o.critical && <span className="text-amber-400">★ </span>}{o.vendor}</td>
                <td className="py-1.5 text-gray-600">{o.category ?? '—'} · {o.frequency ?? '—'}</td>
                <td className="py-1.5 text-right tabular-nums text-white">{money(o.amountCents)}</td>
                <td className="py-1.5 pl-2 text-green-400 text-xs">✓ confirmed</td>
                <td className="py-1.5 pl-2 text-right"><form action={obligationStatusAction}><input type="hidden" name="id" value={o.id} /><input type="hidden" name="status" value="ignored" /><button className="text-gray-600 text-xs underline">ignore</button></form></td>
              </tr>
            ))}
          </tbody></table>
        )}
        <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Proposed ({oblByStatus.proposed.length})</p>
        <table className="w-full text-sm"><tbody>
          {oblByStatus.proposed.slice(0, 30).map((o) => {
            const ev = (o.evidence ?? {}) as any
            return (
              <tr key={o.id} className="border-b border-gray-800/60 align-top">
                <td className="py-1.5 text-gray-300">{o.critical && <span className="text-amber-400">★ </span>}{o.vendor}
                  <span className="block text-gray-600 text-xs">{o.occurrences}× · {o.frequency} · avg {money(o.avgAmountCents)} · range {money(o.amountMinCents)}–{money(o.amountMaxCents)} · last {o.lastSeen}</span>
                </td>
                <td className="py-1.5 text-gray-600 text-xs">{o.category}</td>
                <td className="py-1.5 text-right tabular-nums text-gray-300">{money(o.amountCents)}</td>
                <td className="py-1.5 pl-2 text-right whitespace-nowrap">
                  <form action={obligationStatusAction} className="inline"><input type="hidden" name="id" value={o.id} /><input type="hidden" name="status" value="confirmed" /><button className="bg-green-700 text-white text-xs px-2 py-1 rounded">Confirm</button></form>
                  <form action={obligationStatusAction} className="inline ml-1"><input type="hidden" name="id" value={o.id} /><input type="hidden" name="status" value="ignored" /><button className="text-gray-500 text-xs underline">ignore</button></form>
                </td>
              </tr>
            )
          })}
        </tbody></table>
        {oblByStatus.proposed.length === 0 && <p className="text-gray-500 text-sm">No proposals yet — run <b>Sync now</b> to discover recurring streams.</p>}
      </div>

      {/* Why book ≠ bank */}
      <div className={`${card} mb-6 border-amber-900/40`}>
        <h2 className="text-amber-300 font-bold text-lg mb-1">Why QuickBooks book ≠ bank</h2>
        <p className="text-gray-400 text-sm">QuickBooks book *2649 shows <b>{money(cash.find((a) => /2649/.test(a.name))?.balance?.cents)}</b> but the live bank available is <b>{money(operating?.availableCents)}</b>. Evidence so far: QBO carries <b>{money(clearing.reduce((t, a) => t + (a.balance?.cents ?? 0), 0))}</b> stuck in Undeposited Funds + Clover clearing (income recorded but never reconciled/deposited), and the QBO P&amp;L shows only a few thousand dollars of activity with template categories (Landscaping / Pest Control) — i.e. <b>real operations, payroll and purchases are largely not booked in QuickBooks</b>. The bank (Plaid) is the source of truth for cash; QuickBooks needs reconciliation. The CFO will keep itemizing the specific unreconciled entries.</p>
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
