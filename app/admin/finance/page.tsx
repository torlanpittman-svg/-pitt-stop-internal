/**
 * Financial Command Center — CFO decision dashboard (admin-only, desktop-first, READ-ONLY toward
 * QuickBooks). Conclusions first, accounting detail second. The top of the page answers the owner's
 * real questions — where do we stand, are we okay, what's safe to spend, what's coming, where's the
 * next danger, what should I do — in plain English generated from the model (apps/finance/cfo.ts).
 * All raw controls (connections, transactions, obligation confirm, reserve policy, documents) are kept
 * but demoted into expandable sections lower down. No money movement anywhere.
 */
import { revalidatePath } from 'next/cache'
import { financeEnabled } from '@/apps/settings/db'
import { getAccounts, getDebts, getLatestPayroll, getDocuments, getLatestSyncRun, getDataGaps, setNextPayroll, addDocumentMeta, getPlaidConnections, verifyPlaidMapping, refreshPlaidBalances, getOperatingCash, getAutoSalesLiquidity, setPlaidAccountStatus, setAccountStatus } from '@/apps/finance/db'
import { plaidDiagnostics } from '@/apps/finance/plaid'
import { ingestTransactions, getRecentTransactions, getClassificationSummary } from '@/apps/finance/transactions'
import { discoverObligations, getObligationsByStatus, setObligationStatus } from '@/apps/finance/obligations-discovery'
import { computeSafeToSpend, forecastWithInflows, getObligationCalendar } from '@/apps/finance/safe-to-spend'
import { getExpectedInflows, getPipelineContext, addManualInflow, dismissInflow, deriveExpectedInflows } from '@/apps/finance/expected-inflows'
import { getCfoHeadline, getNextDanger, getRecommendations, getReserveStatus, getDebtSummary, getCashRunway, getMoneyFlow, getCfoConfidence, getNeedsVerification, type Health } from '@/apps/finance/cfo'
import { getReservePolicy } from '@/apps/settings/db'
import { getSyncHealth, type FreshnessStatus } from '@/apps/finance/sync-health'
import { freshnessLabel } from '@/apps/finance/sources'
import PlaidLinkButton from './PlaidLinkButton'

export const dynamic = 'force-dynamic'

const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const big = (c: number | null | undefined) => c == null ? '—' : `${c < 0 ? '−' : ''}$${Math.abs(Math.round(c / 100)).toLocaleString('en-US')}`
const dollars = (n: number | null | undefined) => n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const HEALTH: Record<Health, { c: string; bg: string; ring: string; word: string }> = {
  HEALTHY: { c: 'text-emerald-300', bg: 'bg-emerald-950/30', ring: 'border-emerald-800/60', word: 'HEALTHY' },
  WATCH: { c: 'text-amber-300', bg: 'bg-amber-950/25', ring: 'border-amber-800/60', word: 'WATCH' },
  TIGHT: { c: 'text-orange-300', bg: 'bg-orange-950/25', ring: 'border-orange-800/60', word: 'TIGHT' },
  CRITICAL: { c: 'text-red-300', bg: 'bg-red-950/30', ring: 'border-red-800/60', word: 'CRITICAL' },
}
const RISK: Record<string, string> = { LOW: 'text-emerald-300', MODERATE: 'text-amber-300', HIGH: 'text-orange-300', CRITICAL: 'text-red-300' }

function Badge({ confidence, asOf }: { confidence: string; asOf?: string }) {
  const map: Record<string, string> = {
    book: 'bg-amber-950/40 text-amber-300 border-amber-900/60', live: 'bg-green-950/40 text-green-300 border-green-900/60',
    manual: 'bg-blue-950/40 text-blue-300 border-blue-900/60', manual_verified: 'bg-green-950/40 text-green-300 border-green-900/60',
    estimated: 'bg-gray-800 text-gray-300 border-gray-700',
  }
  const label = confidence === 'book' ? 'book · not live' : confidence === 'live' ? 'live' : confidence.replace('_', ' ')
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border ${map[confidence] ?? map.estimated}`}>{label}{asOf ? ` · ${freshnessLabel(asOf)}` : ''}</span>
}

// ── Server actions (manual inputs + read-only refresh) — unchanged behavior ──
async function refreshAction() { 'use server'; const { syncFromQbo } = await import('@/apps/finance/qbo-sync'); await syncFromQbo('admin'); revalidatePath('/admin/finance') }
async function payrollAction(fd: FormData) { 'use server'; const date = String(fd.get('nextPayDate') ?? ''); const amt = Math.round(parseFloat(String(fd.get('amount') ?? '')) * 100); if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(amt) && amt >= 0) { await setNextPayroll({ nextPayDate: date, expectedCashCents: amt, notes: String(fd.get('notes') ?? '') || undefined }, 'admin') } revalidatePath('/admin/finance') }
async function verifyMappingAction(fd: FormData) { 'use server'; const plaidAccountId = String(fd.get('plaidAccountId') ?? ''); const finAccountId = String(fd.get('finAccountId') ?? ''); if (plaidAccountId && finAccountId) await verifyPlaidMapping({ plaidAccountId, finAccountId, actor: 'admin' }); revalidatePath('/admin/finance') }
async function refreshPlaidAction() { 'use server'; await refreshPlaidBalances('admin'); revalidatePath('/admin/finance') }
async function syncTransactionsAction() { 'use server'; const { refreshPlaidBalances } = await import('@/apps/finance/db'); await refreshPlaidBalances('admin'); await ingestTransactions('admin'); await discoverObligations('admin'); revalidatePath('/admin/finance') }
async function obligationStatusAction(fd: FormData) { 'use server'; const id = String(fd.get('id') ?? ''); const status = String(fd.get('status') ?? '') as any; if (id && ['confirmed', 'ignored', 'proposed', 'paused'].includes(status)) await setObligationStatus(id, status, 'admin'); revalidatePath('/admin/finance') }
async function inflowAddAction(fd: FormData) { 'use server'; const label = String(fd.get('label') ?? '').trim(); const amt = Math.round(parseFloat(String(fd.get('amount') ?? '')) * 100); const date = String(fd.get('expectedDate') ?? ''); const confidence = String(fd.get('confidence') ?? 'probable') as any; if (label && Number.isFinite(amt) && amt > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)) { await addManualInflow({ label, amountCents: amt, expectedDate: date, confidence }, 'admin') } revalidatePath('/admin/finance') }
async function inflowDismissAction(fd: FormData) { 'use server'; const id = String(fd.get('id') ?? ''); if (id) await dismissInflow(id, 'admin'); revalidatePath('/admin/finance') }
async function deriveInflowsAction() { 'use server'; await deriveExpectedInflows('admin', 30); revalidatePath('/admin/finance') }
async function reservesAction(fd: FormData) { 'use server'; const { updateSetting } = await import('@/apps/settings/db'); const toCents = (v: string) => Math.round((parseFloat(v) || 0) * 100); await updateSetting('payroll_reserve_cents', toCents(String(fd.get('payroll') ?? '0')), 'admin'); await updateSetting('tax_reserve_cents', toCents(String(fd.get('tax') ?? '0')), 'admin'); await updateSetting('min_operating_buffer_cents', toCents(String(fd.get('buffer') ?? '0')), 'admin'); await updateSetting('reserves_configured', true, 'admin'); revalidatePath('/admin/finance') }
async function plaidStatusAction(fd: FormData) { 'use server'; const plaidAccountId = String(fd.get('plaidAccountId') ?? ''); const status = String(fd.get('status') ?? '') as any; const entityNote = String(fd.get('entityNote') ?? '') || undefined; if (plaidAccountId && ['active', 'ignored', 'closed'].includes(status)) await setPlaidAccountStatus({ plaidAccountId, status, entityNote, actor: 'admin' }); revalidatePath('/admin/finance') }
async function accountStatusAction(fd: FormData) { 'use server'; const finAccountId = String(fd.get('finAccountId') ?? ''); const status = String(fd.get('status') ?? '') as any; if (finAccountId && ['active', 'ignored', 'closed'].includes(status)) await setAccountStatus({ finAccountId, status, actor: 'admin' }); revalidatePath('/admin/finance') }
async function documentAction(fd: FormData) { 'use server'; const type = String(fd.get('type') ?? '').trim(); const filename = String(fd.get('filename') ?? '').trim(); if (type && filename) { await addDocumentMeta({ type, blobUrl: 'pending-secure-storage-phase2', filename, periodEnd: /^\d{4}-\d{2}-\d{2}$/.test(String(fd.get('asOf') ?? '')) ? String(fd.get('asOf')) : undefined, asOf: /^\d{4}-\d{2}-\d{2}$/.test(String(fd.get('asOf') ?? '')) ? String(fd.get('asOf')) : undefined, notes: String(fd.get('notes') ?? '') || undefined }, 'admin') } revalidatePath('/admin/finance') }

const input = 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white'
const card = 'rounded-2xl bg-gray-900 border border-gray-800 p-5'
const kicker = 'text-gray-500 text-[11px] uppercase tracking-widest'

// ── 30-day cash runway chart (server-rendered SVG; no client JS) ──
function RunwayChart({ points, low, lowDate, startCents }: { points: { date: string; balanceCents: number; events: { label: string; cents: number; kind: 'in' | 'out' }[] }[]; low: number | null; lowDate: string | null; startCents: number | null }) {
  if (points.length === 0 || startCents == null) return <p className="text-gray-500 text-sm">No verified operating balance to project.</p>
  const W = 1080, H = 220, padL = 8, padR = 8, padT = 16, padB = 26
  const vals = points.map((p) => p.balanceCents)
  const maxV = Math.max(...vals, 0), minV = Math.min(...vals, 0)
  const span = Math.max(maxV - minV, 1)
  const x = (i: number) => padL + (i / (points.length - 1)) * (W - padL - padR)
  const y = (v: number) => padT + (1 - (v - minV) / span) * (H - padT - padB)
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.balanceCents).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(minV).toFixed(1)} L${x(0).toFixed(1)},${y(minV).toFixed(1)} Z`
  const zeroY = y(0)
  const lowIdx = points.findIndex((p) => p.date === lowDate)
  // Event markers where cash steps down materially (payroll/rent/taxes) or a big inflow.
  const marks = points.map((p, i) => ({ p, i })).filter(({ p }) => p.events.some((e) => Math.abs(e.cents) >= 90000))
  const overdraft = (low ?? 0) < 0
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }}>
      <defs>
        <linearGradient id="cashfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={overdraft ? '#f8717133' : '#34d39933'} />
          <stop offset="100%" stopColor="#0000" />
        </linearGradient>
      </defs>
      {minV < 0 && <rect x={padL} y={zeroY} width={W - padL - padR} height={H - padB - zeroY} fill="#7f1d1d18" />}
      <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke="#4b5563" strokeWidth="1" strokeDasharray="3 3" />
      <text x={padL + 2} y={zeroY - 3} className="fill-gray-600" fontSize="9">$0</text>
      <path d={area} fill="url(#cashfill)" />
      <path d={line} fill="none" stroke={overdraft ? '#f87171' : '#34d399'} strokeWidth="2" />
      {marks.map(({ p, i }, k) => (
        <g key={k}>
          <line x1={x(i)} y1={padT} x2={x(i)} y2={H - padB} stroke="#374151" strokeWidth="1" />
          <text x={x(i)} y={H - padB + 11} textAnchor="middle" className="fill-gray-500" fontSize="8">{p.date.slice(5)}</text>
          <text x={x(i)} y={H - padB + 20} textAnchor="middle" className="fill-gray-600" fontSize="7">{p.events[0]?.label.replace(/Payroll —/, '').replace(/ \(.*\)/, '').slice(0, 12)}</text>
        </g>
      ))}
      {lowIdx >= 0 && (
        <g>
          <circle cx={x(lowIdx)} cy={y(low ?? 0)} r="4" fill={overdraft ? '#f87171' : '#fbbf24'} />
          <text x={x(lowIdx)} y={y(low ?? 0) - 8} textAnchor="middle" className={overdraft ? 'fill-red-300' : 'fill-amber-300'} fontSize="11" fontWeight="bold">{big(low)}</text>
        </g>
      )}
      <circle cx={x(0)} cy={y(startCents)} r="3" fill="#9ca3af" />
    </svg>
  )
}

export default async function FinancePage() {
  const [enabled, headline, reserve, danger, recs, debt, runway, flow, confidence, needsVerify, s2s, forecast, calendar, expectedInflows, pipeline, operating, autoSales, reserves] = await Promise.all([
    financeEnabled(), getCfoHeadline(), getReserveStatus(), getNextDanger(), getRecommendations(), getDebtSummary(), getCashRunway(30), getMoneyFlow(), getCfoConfidence(), getNeedsVerification(),
    computeSafeToSpend(30), forecastWithInflows(30), getObligationCalendar(30), getExpectedInflows(30), getPipelineContext(), getOperatingCash(), getAutoSalesLiquidity(), getReservePolicy(),
  ])
  // Detail/admin data (lower on page)
  const [accounts, allAccounts, debtsRaw, payroll, documents, run, gaps, connections, recentTx, txSummary, oblByStatus, syncHealth] = await Promise.all([
    getAccounts(), getAccounts({ includeInactive: true }), getDebts(), getLatestPayroll(), getDocuments(), getLatestSyncRun(), getDataGaps(), getPlaidConnections(), getRecentTransactions(30), getClassificationSummary(120), getObligationsByStatus(), getSyncHealth(),
  ])
  const plaid = plaidDiagnostics()
  const s = (run?.summary ?? {}) as any
  const cash = accounts.filter((a) => a.kind === 'bank' && !a.clearingSuspect)
  const cards = accounts.filter((a) => a.kind === 'credit_card')
  const clearing = accounts.filter((a) => a.clearingSuspect)
  const inactiveAccounts = allAccounts.filter((a) => a.status !== 'active')
  const hl = HEALTH[headline.status]
  // Per-account obligation windows — operating (*2649) is primary; auto-sales (*5600) is shown
  // separately and NEVER folded into operating totals.
  const opWin = calendar.byAccount.find((a) => /2649|Detail/.test(a.account)) ?? { window7: 0, window14: 0, window30: 0 }
  const asWin = calendar.byAccount.find((a) => /5600|Auto/.test(a.account))
  const opEvents = calendar.events.filter((e) => /2649|Detail/.test(e.account))
  const asEvents = calendar.events.filter((e) => !/2649|Detail/.test(e.account))

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-8 py-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <div>
          <h1 className="text-2xl font-bold text-white">Operating CFO <span className="text-gray-500 font-semibold text-lg">· American Momentum *2649</span></h1>
          <p className="text-gray-600 text-xs mt-0.5">This dashboard answers ONE question: how much can I safely spend from *2649? Auto-sales *5600 is shown separately and never added to operating cash.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-600 text-xs">*2649 {operating ? freshnessLabel(operating.asOf) : 'not connected'}</span>
          <form action={refreshPlaidAction}><button className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Refresh cash</button></form>
        </div>
      </div>
      <p className="text-gray-600 text-xs mb-5">Live *2649 bank cash (Plaid, read-only) · CFO decision view · admin-only · no money movement{!enabled && ' · finance_enabled OFF (preview)'}</p>

      {/* ═══ Data freshness — a stale bank balance must never look current ═══ */}
      {(() => {
        const FRESH: Record<FreshnessStatus, { ring: string; bg: string; dot: string; label: string }> = {
          fresh:   { ring: 'border-emerald-800/60', bg: 'bg-emerald-950/25', dot: 'bg-emerald-400', label: 'DATA FRESH' },
          stale:   { ring: 'border-amber-800/70',   bg: 'bg-amber-950/30',   dot: 'bg-amber-400',   label: 'DATA STALE' },
          failed:  { ring: 'border-red-800/70',     bg: 'bg-red-950/30',     dot: 'bg-red-400',     label: 'SYNC FAILED' },
          unknown: { ring: 'border-gray-700',       bg: 'bg-gray-900',       dot: 'bg-gray-500',    label: 'NO SYNC' },
        }
        const f = FRESH[syncHealth.status]
        return (
          <section className={`rounded-xl border ${f.ring} ${f.bg} px-4 py-2.5 mb-4 flex items-center justify-between gap-4`}>
            <div className="flex items-center gap-2.5">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${f.dot} ${syncHealth.status !== 'fresh' ? 'animate-pulse' : ''}`} />
              <span className="text-xs font-bold tracking-wider text-gray-200">{f.label}</span>
              <span className="text-xs text-gray-400">{syncHealth.message}</span>
            </div>
            <form action={syncTransactionsAction}><button className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-600 text-gray-200 hover:bg-gray-800">Sync now</button></form>
          </section>
        )
      })()}

      {/* ═══ A. CFO ANSWER ═══ */}
      <section className={`rounded-2xl border ${hl.ring} ${hl.bg} p-6 mb-4`}>
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className={kicker}>Today</p>
            <div className="flex items-baseline gap-3 mt-1">
              <span className={`text-3xl font-black tracking-tight ${hl.c}`}>{hl.word}</span>
              <span className="text-gray-500 text-sm">financial status</span>
            </div>
            <p className="text-gray-200 text-[15px] leading-relaxed mt-3 max-w-3xl">{headline.statement}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 shrink-0">
            <div><p className={kicker}>*2649 available cash</p><p className="text-xl font-bold text-white tabular-nums">{big(headline.operatingAvailableCents)}</p></div>
            <div>
              <p className={kicker}>Safe-to-Spend today</p>
              <p className={`text-xl font-bold tabular-nums ${(headline.safeToSpendTodayCents ?? 0) > 0 ? 'text-white' : 'text-gray-400'}`}>{big(headline.safeToSpendTodayCents)}</p>
              {headline.liquidityShortfallCents > 0 && <p className="text-[11px] text-red-400">liquidity shortfall −{big(headline.liquidityShortfallCents)}</p>}
            </div>
            <div><p className={kicker}>Forecast cash (with expected in)</p><p className={`text-xl font-bold tabular-nums ${(headline.forecastSafeToSpendCents ?? 0) < 0 ? 'text-amber-400' : 'text-emerald-300'}`}>{big(headline.forecastSafeToSpendCents)}</p></div>
            <div><p className={kicker}>Next 7 days (*2649)</p><p className="text-sm text-gray-300 tabular-nums mt-1"><span className="text-emerald-300">+{big(headline.next7InCents)}</span> in · <span className="text-red-300">−{big(headline.next7OutCents)}</span> out</p><p className="text-xs text-gray-500">projected ≈ <b className={`${(headline.next7ProjectedEndingCents ?? 0) < 0 ? 'text-red-400' : 'text-gray-300'}`}>{big(headline.next7ProjectedEndingCents)}</b></p></div>
          </div>
        </div>
      </section>

      {/* ═══ B. SAFE-TO-SPEND HERO ═══ */}
      <section className={`${card} mb-4`}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <p className={kicker}>How much can I actually spend from *2649? · verified cash only</p>
            <div className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-gray-300">Available now <span className="text-gray-600">(*2649 live, nets pending)</span></span><span className="tabular-nums text-white">{money(s2s.availableCents)}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">− Already committed <span className="text-gray-600">(30d *2649 payroll, tax, rent, debt, reserves)</span></span><span className="tabular-nums text-red-300">−{money((s2s.criticalCents) + (s2s.contractualCents) + (s2s.reservesCents))}</span></div>
              <div className="flex justify-between border-t border-gray-700 pt-2 mt-1"><span className="text-white font-bold text-base">Safe-to-Spend today</span><span className={`tabular-nums font-black text-2xl ${(headline.safeToSpendTodayCents ?? 0) > 0 ? 'text-white' : 'text-gray-400'}`}>{big(headline.safeToSpendTodayCents)}</span></div>
              {headline.liquidityShortfallCents > 0 && <div className="flex justify-between"><span className="text-red-300 text-xs">Liquidity shortfall <span className="text-gray-600">(committed exceeds current cash — needs expected receipts)</span></span><span className="tabular-nums text-red-400 font-bold">−{big(headline.liquidityShortfallCents)}</span></div>}
            </div>
            <div className="mt-4 space-y-1.5 text-sm border-t border-gray-800 pt-3">
              <div className="flex justify-between"><span className="text-gray-400">+ Expected money coming in <span className="text-gray-600">(high-confidence)</span></span><span className="tabular-nums text-emerald-300">+{money(forecast.expectedHighCents)}</span></div>
              <div className="flex justify-between"><span className="text-emerald-200 font-semibold">Forecast cash available</span><span className={`tabular-nums font-bold text-lg ${(headline.forecastSafeToSpendCents ?? 0) < 0 ? 'text-amber-400' : 'text-emerald-300'}`}>{big(headline.forecastSafeToSpendCents)}</span></div>
            </div>
          </div>
          <div className="lg:border-l lg:border-gray-800 lg:pl-6">
            <p className={kicker}>Money I have vs money I expect</p>
            {(s2s.coreSafeToSpendCents ?? 0) < 0 && (headline.forecastSafeToSpendCents ?? 0) >= 0 ? (
              <div className="mt-3 rounded-xl border border-amber-900/50 bg-amber-950/15 p-3">
                <p className="text-amber-200 text-sm font-semibold">Strict today: {big(s2s.coreSafeToSpendCents)} · Forecast: +{big(headline.forecastSafeToSpendCents)}</p>
                <p className="text-gray-400 text-xs mt-1.5">Current verified cash alone does not cover this month's committed obligations, but normal Sterling/dealer payments and card settlements are expected to arrive before the tightest point. That's why the honest "money I have" number is negative while "money I expect to have" is positive.</p>
              </div>
            ) : (
              <p className="text-gray-400 text-sm mt-3">Strict = only cash you can see in the bank, minus what's committed. Forecast layers in expected receipts by confidence. They are never combined into one number — {(s2s.coreSafeToSpendCents ?? 0) >= 0 ? 'both are positive here.' : 'watch the gap between them.'}</p>
            )}
            {s2s.disclosures.slice(0, 2).map((d, i) => <p key={i} className="text-gray-600 text-[11px] mt-2">⚠ {d}</p>)}
          </div>
        </div>
      </section>

      {/* ═══ C. 30-DAY CASH FORECAST ═══ */}
      <section className={`${card} mb-4`}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-white font-bold">30-day cash runway <span className="text-gray-600 text-sm font-normal">· *2649 · verified cash + high-confidence inflows</span></h2>
          <div className="text-right">
            <p className={kicker}>Projected low</p>
            <p className={`text-lg font-bold tabular-nums ${runway.overdraft ? 'text-red-400' : 'text-amber-300'}`}>{big(runway.lowCents)} <span className="text-gray-500 text-xs font-normal">on {runway.lowDate}</span></p>
          </div>
        </div>
        <RunwayChart points={runway.points} low={runway.lowCents} lowDate={runway.lowDate} startCents={runway.startCents} />
        {/* Scenarios — KNOWN / EXPECTED / PROBABLE */}
        <div className="grid grid-cols-3 gap-3 mt-3">
          {forecast.scenarios.map((sc) => {
            const label = sc.scenario === 'verified_only' ? 'KNOWN' : sc.scenario === 'high_confidence' ? 'EXPECTED' : 'PROBABLE'
            const sub = sc.scenario === 'verified_only' ? 'cash in hand only' : sc.scenario === 'high_confidence' ? '+ high-confidence receipts' : '+ probable jobs'
            return (
              <div key={sc.scenario} className={`rounded-xl border p-3 ${(sc.endingCents ?? 0) < 0 ? 'border-red-900/50 bg-red-950/15' : 'border-emerald-900/40 bg-emerald-950/10'}`}>
                <p className={`text-[11px] font-bold tracking-widest ${(sc.endingCents ?? 0) < 0 ? 'text-red-300' : 'text-emerald-300'}`}>{label}</p>
                <p className="text-gray-600 text-[10px]">{sub}</p>
                <p className={`text-lg font-bold mt-1 tabular-nums ${(sc.endingCents ?? 0) < 0 ? 'text-red-400' : 'text-emerald-300'}`}>{big(sc.endingCents)}</p>
                <p className="text-gray-600 text-[11px]">30-day ending cash{sc.overdraftRisk ? ' · dips negative en route' : ''}</p>
              </div>
            )
          })}
        </div>
        <p className="text-gray-600 text-[11px] mt-2">Probable money is never treated as guaranteed. The chart line is the EXPECTED (high-confidence) scenario.</p>
      </section>

      {/* ═══ D. MONEY IN / MONEY OUT ═══ */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className={`${card} border-emerald-900/30`}>
          <div className="flex items-baseline justify-between"><h2 className="text-white font-bold">Money coming in</h2><span className="text-emerald-300 text-sm tabular-nums">7d +{big(flow.in7Cents)} · 30d +{big(flow.in30Cents)}</span></div>
          <table className="w-full text-sm mt-3"><tbody>
            {flow.inByCat.slice(0, 6).map((r, i) => (
              <tr key={i} className="border-b border-gray-800/50"><td className="py-1.5 text-gray-300">{r.label}</td><td className="py-1.5"><span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${r.confidence === 'high' ? 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60' : 'bg-amber-950/40 text-amber-300 border-amber-900/60'}`}>{r.confidence}</span></td><td className="py-1.5 text-right tabular-nums text-emerald-300">+{money(r.cents)}</td></tr>
            ))}
            {flow.inByCat.length === 0 && <tr><td className="py-2 text-gray-500 text-sm">No expected inflows derived — run “Re-derive” below.</td></tr>}
          </tbody></table>
          <p className="text-gray-600 text-[11px] mt-2">Pipeline: {pipeline.dealerThisWeek} dealer jobs this week · {pipeline.readyRetail} retail ready · {pipeline.activeDealer} active dealer jobs.</p>
        </div>
        <div className={`${card} border-red-900/20`}>
          <div className="flex items-baseline justify-between"><h2 className="text-white font-bold">Money going out</h2><span className="text-red-300 text-sm tabular-nums">7d −{big(flow.out7Cents)} · 30d −{big(flow.out30Cents)}</span></div>
          <table className="w-full text-sm mt-3"><tbody>
            {flow.outByCat.slice(0, 8).map((r, i) => (
              <tr key={i} className="border-b border-gray-800/50"><td className="py-1.5 text-gray-300 capitalize">{r.category.replace('_', ' ')}</td><td className="py-1.5"><span className={`text-[10px] ${r.priority === 'critical' ? 'text-red-400' : r.priority === 'contractual' ? 'text-amber-400' : 'text-gray-500'}`}>● {r.priority}</span></td><td className="py-1.5 text-right tabular-nums text-red-300">−{money(r.cents)}</td></tr>
            ))}
          </tbody></table>
          <p className="text-gray-600 text-[11px] mt-2">Operating (*2649) obligations only. Auto-sales (*5600) debts don't reduce operating cash.</p>
        </div>
      </section>

      {/* ═══ E. NEXT CASH-FLOW RISK ═══ */}
      <section className={`${card} mb-4 border ${danger.risk === 'HIGH' || danger.risk === 'CRITICAL' ? 'border-red-900/50' : danger.risk === 'MODERATE' ? 'border-amber-900/40' : 'border-gray-800'}`}>
        <div className="flex items-start justify-between">
          <div>
            <p className={kicker}>Next cash-flow risk</p>
            <p className="text-white text-xl font-bold mt-1">{danger.date ?? '—'} <span className={`text-sm font-semibold ${RISK[danger.risk]}`}>· {danger.risk} risk</span></p>
          </div>
          <div className="text-right"><p className={kicker}>Projected low</p><p className={`text-2xl font-black tabular-nums ${danger.overdraft ? 'text-red-400' : 'text-amber-300'}`}>{big(danger.lowCents)}</p></div>
        </div>
        {danger.items.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {danger.items.map((it, i) => <span key={i} className="text-xs rounded-lg border border-gray-800 bg-gray-900/60 px-2.5 py-1 text-gray-300">{it.label} <span className="tabular-nums text-red-300">−{big(it.cents)}</span></span>)}
          </div>
        )}
        <p className="text-gray-400 text-sm mt-3 max-w-3xl">{danger.explanation}</p>
      </section>

      {/* ═══ F. CFO RECOMMENDED ACTIONS ═══ */}
      <section className={`${card} mb-4`}>
        <h2 className="text-white font-bold mb-1">What should I do next?</h2>
        <p className="text-gray-600 text-xs mb-3">Ranked by impact on liquidity, cost, and reserve-building. Each explains the why — never just “pay debt.”</p>
        <div className="space-y-2">
          {recs.map((r) => {
            const tagc: Record<string, string> = { liquidity: 'text-sky-300 border-sky-900/50 bg-sky-950/20', debt: 'text-orange-300 border-orange-900/50 bg-orange-950/20', reserve: 'text-emerald-300 border-emerald-900/50 bg-emerald-950/20', caution: 'text-amber-300 border-amber-900/50 bg-amber-950/20' }
            return (
              <details key={r.rank} className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 group">
                <summary className="flex items-center gap-3 cursor-pointer list-none">
                  <span className="w-6 h-6 rounded-full bg-gray-800 text-gray-300 text-xs font-bold flex items-center justify-center shrink-0">{r.rank}</span>
                  <span className="text-gray-100 font-semibold text-sm flex-1">{r.title}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${tagc[r.tag]}`}>{r.tag}</span>
                  <span className="text-gray-600 text-xs group-open:hidden">why ▾</span>
                </summary>
                <p className="text-gray-400 text-sm mt-2 pl-9">{r.why}</p>
              </details>
            )
          })}
        </div>
      </section>

      {/* ═══ G. RESERVE BUILDER ═══ */}
      <section className={`${card} mb-4`}>
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="text-white font-bold">Cash reserve builder</h2>
          <span className="text-gray-500 text-xs">first milestone {big(reserve.targetCents)} · long-term {big(reserve.nextTargetCents)}</span>
        </div>
        <div className="flex items-baseline gap-3 mt-2">
          <span className="text-3xl font-black text-white tabular-nums">{big(reserve.trueReserveCents)}</span>
          <span className="text-gray-500">/ {big(reserve.targetCents)}</span>
          <span className="text-emerald-300 font-semibold">{reserve.pct}% funded</span>
        </div>
        <div className="h-3 rounded-full bg-gray-800 mt-3 overflow-hidden"><div className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400" style={{ width: `${Math.max(1, Math.min(100, reserve.pct))}%` }} /></div>
        <p className="text-gray-400 text-xs mt-3">{reserve.note}</p>
        <div className="grid grid-cols-3 gap-4 mt-3 text-sm">
          <div><p className={kicker}>Raw operating cash</p><p className="text-gray-200 tabular-nums">{money(reserve.rawCashCents)}</p></div>
          <div><p className={kicker}>Claimed by 30d obligations</p><p className="text-red-300 tabular-nums">−{money(reserve.obligations30Cents)}</p></div>
          <div><p className={kicker}>True free reserve</p><p className="text-emerald-300 tabular-nums">{money(reserve.trueReserveCents)}</p></div>
        </div>
      </section>

      {/* ═══ H. UPCOMING OBLIGATIONS ═══ */}
      <section className={`${card} mb-4`}>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-white font-bold">Upcoming obligations <span className="text-gray-600 text-sm font-normal">· *2649 operating</span></h2>
          <span className="text-sm tabular-nums text-gray-400">7d <b className="text-red-300">−{big(opWin.window7)}</b> · 14d <b className="text-red-300">−{big(opWin.window14)}</b> · 30d <b className="text-red-300">−{big(opWin.window30)}</b></span>
        </div>
        {needsVerify.length > 0 && (
          <div className="rounded-xl border border-purple-900/40 bg-purple-950/15 p-3 mb-3">
            <p className="text-purple-300 text-xs font-bold uppercase tracking-widest mb-1">Needs verification — not counted as a bill</p>
            {needsVerify.map((n, i) => <p key={i} className="text-gray-300 text-sm">{n.vendor} <span className="text-gray-500">~{money(n.amountCents)}/{n.frequency}</span> <span className="text-purple-300/80 text-xs">· status UNKNOWN</span></p>)}
            <p className="text-gray-500 text-[11px] mt-1">{needsVerify[0]?.notes?.slice(0, 180)}…</p>
          </div>
        )}
        <table className="w-full text-sm"><tbody>
          {opEvents.slice(0, 16).map((e, i) => {
            const dt = new Date(e.due + 'T00:00:00Z'); const dow = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
            const pc = e.priority === 'critical' ? 'text-red-400' : e.priority === 'contractual' ? 'text-amber-400' : 'text-gray-500'
            return (
              <tr key={i} className="border-b border-gray-800/50">
                <td className="py-1.5 text-gray-500 text-xs whitespace-nowrap w-24">{dow} {e.due.slice(5)}</td>
                <td className="py-1.5 text-gray-300">{e.label}</td>
                <td className="py-1.5"><span className={`text-[10px] ${pc}`}>● {e.priority}</span></td>
                <td className="py-1.5 text-right tabular-nums text-red-300">−{money(e.cents)}</td>
              </tr>
            )
          })}
        </tbody></table>
        {asWin && (asWin.window30 > 0) && (
          <details className="mt-3">
            <summary className="text-gray-500 text-xs cursor-pointer">Auto-sales *5600 obligations (separate — paid from *5600, NOT operating): 30d −{big(asWin.window30)} ▾</summary>
            <table className="w-full text-sm mt-2"><tbody>
              {asEvents.slice(0, 8).map((e, i) => { const dt = new Date(e.due + 'T00:00:00Z'); const dow = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
                return <tr key={i} className="border-b border-gray-800/40"><td className="py-1 text-gray-600 text-xs w-24">{dow} {e.due.slice(5)}</td><td className="py-1 text-gray-500">{e.label}</td><td className="py-1 text-right tabular-nums text-gray-500">−{money(e.cents)}</td></tr>
              })}
            </tbody></table>
          </details>
        )}
      </section>

      {/* ═══ I. DEBT COMMAND CENTER ═══ */}
      <section className={`${card} mb-4`}>
        <h2 className="text-white font-bold mb-3">Debt</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div><p className={kicker}>Total debt</p><p className="text-xl font-bold text-white tabular-nums">{big(debt.totalCents)}</p></div>
          <div><p className={kicker}>High-interest (≥20%)</p><p className="text-xl font-bold text-orange-300 tabular-nums">{big(debt.highInterestCents)}</p></div>
          <div><p className={kicker}>Monthly service</p><p className="text-xl font-bold text-white tabular-nums">{big(debt.monthlyServiceCents)}</p><p className="text-[11px] text-gray-500">*2649 {big(debt.operatingMonthlyServiceCents)} · *5600 {big(debt.autoSalesMonthlyServiceCents)}</p></div>
          <div><p className={kicker}>Weighted APR</p><p className="text-xl font-bold text-white tabular-nums">{debt.weightedAprPct == null ? '—' : `${debt.weightedAprPct.toFixed(1)}%`}</p></div>
        </div>
        {debt.mostExpensive && (
          <div className="rounded-xl border border-orange-900/40 bg-orange-950/15 p-3 mb-3">
            <p className="text-orange-300 text-xs uppercase tracking-widest">Most expensive debt</p>
            <p className="text-white text-sm mt-1"><b>{debt.mostExpensive.name}</b> · balance {money(debt.mostExpensive.balanceCents)} · <span className="text-orange-300">{debt.mostExpensive.aprPct?.toFixed(2)}% APR</span> · payment {money(debt.mostExpensive.paymentCents)}/mo</p>
            <p className="text-gray-400 text-xs mt-1">Once minimum operating liquidity is protected, this is the highest-value payoff target.</p>
          </div>
        )}
        <details>
          <summary className="text-gray-400 text-sm cursor-pointer">Show all {debt.lines.length} debts ▾</summary>
          <table className="w-full text-sm mt-2"><tbody>
            {debt.lines.map((d, i) => (
              <tr key={i} className="border-b border-gray-800/50">
                <td className="py-1.5 text-gray-300">{d.highInterest && <span className="text-orange-400">▲ </span>}{d.name}</td>
                <td className="py-1.5 text-gray-600 text-xs capitalize">{d.kind.replace('_', ' ')}</td>
                <td className="py-1.5 text-right tabular-nums text-white">{money(d.balanceCents)}</td>
                <td className="py-1.5 text-right tabular-nums text-gray-400">{d.aprPct == null ? '—' : `${d.aprPct.toFixed(2)}%`}</td>
                <td className="py-1.5 text-right tabular-nums text-gray-400">{money(d.paymentCents)}/mo</td>
                <td className="py-1.5 pl-2 text-xs text-gray-500">{d.account === 'operating' ? 'pays *2649' : d.account === 'auto_sales' ? 'pays *5600' : '—'}</td>
                <td className="py-1.5 pl-2"><Badge confidence={d.verified ? 'manual_verified' : 'book'} /></td>
              </tr>
            ))}
          </tbody></table>
        </details>
      </section>

      {/* ═══ J. OPERATING VS AUTO SALES ═══ */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className={card}>
          <p className={kicker}>Detail / Operating</p>
          <p className="text-gray-300 text-sm mt-1">American Momentum *2649</p>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div><p className={kicker}>Bank cash</p><p className="text-lg font-bold text-white tabular-nums">{money(operating?.availableCents)}</p></div>
            <div><p className={kicker}>Safe-to-Spend today</p><p className={`text-lg font-bold tabular-nums ${(headline.safeToSpendTodayCents ?? 0) > 0 ? 'text-white' : 'text-gray-400'}`}>{big(headline.safeToSpendTodayCents)}</p>{headline.liquidityShortfallCents > 0 && <p className="text-[10px] text-red-400">shortfall −{big(headline.liquidityShortfallCents)}</p>}</div>
            <div><p className={kicker}>30-day projected low</p><p className={`text-lg font-bold tabular-nums ${runway.overdraft ? 'text-red-400' : 'text-amber-300'}`}>{big(runway.lowCents)}</p></div>
          </div>
        </div>
        <div className={`${card} border-blue-900/30`}>
          <p className={kicker}>Auto Sales · separate entity · financial modeling incomplete</p>
          <p className="text-gray-300 text-sm mt-1">Extraco *5600</p>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div><p className={kicker}>Bank cash</p><p className="text-lg font-bold text-white tabular-nums">{money(autoSales.bankAvailableCents)}</p></div>
            <div><p className={kicker}>Verified unencumbered</p><p className="text-lg font-bold text-amber-400">{autoSales.unencumberedCents == null ? 'UNKNOWN' : money(autoSales.unencumberedCents)}</p></div>
            <div><p className={kicker}>Floor-plan exposure</p><p className="text-lg font-bold text-gray-400 tabular-nums">{big(autoSales.floorPlanBalanceCents)}</p></div>
            <div><p className={kicker}>Status</p><p className="text-sm font-semibold text-amber-400">Potentially encumbered</p></div>
          </div>
          <p className="text-emerald-300/80 text-[11px] mt-2 font-semibold">✓ Contributes $0 to *2649 Safe-to-Spend — no auto-sales cash is counted as operating liquidity unless an actual *5600→*2649 transfer occurs.</p>
          <p className="text-gray-600 text-[11px] mt-1">True unencumbered cash needs the auto-sales VIN/floor-plan ledger (Phase B) — not built yet.</p>
        </div>
      </section>

      {/* Company-wide liquidity — explicitly NOT combined until auto-sales is modeled */}
      <section className={`${card} mb-4 border-gray-800`}>
        <div className="flex items-center justify-between">
          <div>
            <p className={kicker}>Company-wide Safe-to-Spend</p>
            <p className="text-xl font-bold text-gray-400 mt-1">NOT YET CALCULATED</p>
          </div>
          <p className="text-gray-500 text-xs max-w-md text-right">Adding *2649 + *5600 would overstate real liquidity. A company-wide number waits until auto-sales vehicle/floor-plan encumbrances are modeled (Phase B). Until then: <b className="text-gray-300">Operating *2649 = {big(headline.safeToSpendTodayCents)}</b> safe today; <b className="text-gray-300">Auto-sales *5600 unencumbered = UNKNOWN</b>.</p>
        </div>
      </section>

      {/* ═══ K. PROFIT-TO-CASH (structure ready; honest incomplete) ═══ */}
      <section className={`${card} mb-4`}>
        <h2 className="text-white font-bold mb-1">Why is cash tight even when we're busy?</h2>
        <p className="text-gray-400 text-sm max-w-3xl">On *2649, profit and cash differ because cash is consumed by things the P&amp;L doesn't show: <b>debt principal</b> (~{big(debt.operatingMonthlyServiceCents)}/mo operating service), <b>owner distributions</b> (~{big(s2s.plannedCents)}/mo planned), <b>uncollected receivables</b>, and <b>timing</b> between doing the work and getting paid. Some *2649 outflows are actually auto-sales expenses (historically commingled) — those are a segment-attribution question for later, not operating cash. A full profit-to-cash bridge needs mature segment + per-vehicle attribution — shown as structure, not fabricated numbers.</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm">
          <div><p className={kicker}>Operating debt /mo</p><p className="text-red-300 tabular-nums">−{big(debt.operatingMonthlyServiceCents)}</p></div>
          <div><p className={kicker}>Planned / owner /mo</p><p className="text-red-300 tabular-nums">−{big(s2s.plannedCents)}</p></div>
          <div><p className={kicker}>Vehicle inventory</p><p className="text-gray-500">not attributed</p></div>
          <div><p className={kicker}>Receivable timing</p><p className="text-gray-500">not attributed</p></div>
        </div>
      </section>

      {/* ═══ L. DATA QUALITY / CFO CONFIDENCE ═══ */}
      <section className={`${card} mb-4`}>
        <div className="flex items-center justify-between">
          <h2 className="text-white font-bold">CFO confidence</h2>
          <span className="text-2xl font-black text-white tabular-nums">{confidence.pct}% <span className={`text-sm font-semibold ${confidence.pct >= 85 ? 'text-emerald-300' : confidence.pct >= 70 ? 'text-amber-300' : 'text-orange-300'}`}>{confidence.label}</span></span>
        </div>
        <div className="h-2 rounded-full bg-gray-800 mt-3 overflow-hidden"><div className={`h-full ${confidence.pct >= 85 ? 'bg-emerald-500' : confidence.pct >= 70 ? 'bg-amber-500' : 'bg-orange-500'}`} style={{ width: `${confidence.pct}%` }} /></div>
        <details className="mt-3">
          <summary className="text-gray-400 text-sm cursor-pointer">Known gaps ({confidence.gaps.length}) ▾</summary>
          <ul className="space-y-1.5 mt-2">
            {confidence.gaps.map((g) => (
              <li key={g.key} className="flex items-start gap-2 text-sm">
                <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${g.severity === 'high' ? 'bg-red-500' : g.severity === 'medium' ? 'bg-amber-500' : 'bg-gray-500'}`} />
                <div><p className="text-gray-300">{g.label}</p><p className="text-gray-600 text-xs">{g.why} · Source: {g.source}</p></div>
              </li>
            ))}
          </ul>
        </details>
      </section>

      {/* ═══ M. ACCOUNTING & ADMIN DETAIL (demoted) ═══ */}
      <details className={`${card} mb-4`}>
        <summary className="text-white font-bold cursor-pointer">Accounts, connections & controls <span className="text-gray-600 text-sm font-normal">— accounting detail + admin</span></summary>

        {/* Cash & Accounts */}
        <div className="mt-4">
          <h3 className="text-gray-300 font-semibold text-sm mb-2">Cash &amp; Accounts <span className="text-gray-600">(live beside book)</span></h3>
          <table className="w-full text-sm"><thead><tr className="text-gray-600 text-xs uppercase tracking-wider"><th className="text-left font-normal py-1">Account</th><th className="text-right font-normal py-1">Live current</th><th className="text-right font-normal py-1">Live available</th><th className="text-right font-normal py-1 pl-4">Book</th><th className="py-1"></th></tr></thead>
            <tbody>{[...cash, ...cards].map((a) => (
              <tr key={a.id} className="border-b border-gray-800">
                <td className="py-2 text-gray-300">{a.name}{a.live?.mask ? ` ····${a.live.mask}` : ''}<span className="text-gray-600"> · {a.kind === 'credit_card' ? 'Card' : 'Bank'}</span></td>
                <td className="py-2 text-right tabular-nums text-white">{a.live ? money(a.live.currentCents) : <span className="text-gray-700">—</span>}</td>
                <td className="py-2 text-right tabular-nums text-green-300">{a.live ? money(a.live.availableCents) : <span className="text-gray-700">—</span>}</td>
                <td className="py-2 pl-4 text-right tabular-nums text-gray-500">{money(a.balance?.cents)}</td>
                <td className="py-2 pl-3 text-right">{a.live ? <Badge confidence="live" asOf={a.live.asOf} /> : <Badge confidence="book" />}</td>
              </tr>
            ))}</tbody></table>
          {inactiveAccounts.length > 0 && <p className="text-gray-600 text-xs mt-2">Excluded: {inactiveAccounts.map((a) => a.name).join(', ')}</p>}
        </div>

        {/* Bank Connections */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1"><h3 className="text-gray-300 font-semibold text-sm">Bank Connections <span className="text-gray-600">(Plaid · read-only)</span></h3>{connections.length > 0 && <form action={refreshPlaidAction}><button className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Refresh balances</button></form>}</div>
          <div className="mb-3"><PlaidLinkButton /></div>
          {connections.length === 0 ? <p className="text-gray-500 text-sm">No banks connected yet.</p> : connections.map(({ item, accounts: pas }) => (
            <div key={item.id} className="mb-3 rounded-xl border border-gray-800 p-3">
              <p className="text-white font-semibold text-sm">{item.institutionName ?? 'Institution'} <span className="text-gray-600 font-normal">· {item.environment} · {item.status}</span></p>
              <table className="w-full text-sm mt-2"><tbody>{pas.map((a) => { const ignored = a.status !== 'active'; return (
                <tr key={a.id} className={`border-b border-gray-800 align-top ${ignored ? 'opacity-45' : ''}`}>
                  <td className="py-2"><p className="text-gray-200">{a.name}{a.mask ? ` ····${a.mask}` : ''}{a.entityNote && <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full border bg-purple-950/40 text-purple-300 border-purple-900/60">{a.entityNote}</span>}</p><p className="text-gray-600 text-xs">{a.type}{a.subtype ? `/${a.subtype}` : ''} · as of {a.balanceAsOf ? freshnessLabel(a.balanceAsOf) : '—'}</p></td>
                  <td className="py-2 text-right"><p className="text-white tabular-nums">Current {money(a.currentBalanceCents)}</p><p className="text-gray-400 tabular-nums text-xs">Available {money(a.availableBalanceCents)}</p></td>
                  <td className="py-2 pl-4 text-right w-72">{ignored ? (
                    <form action={plaidStatusAction}><input type="hidden" name="plaidAccountId" value={a.plaidAccountId} /><input type="hidden" name="status" value="active" /><button className="text-xs text-gray-400 underline">un-ignore</button></form>
                  ) : a.mappingVerified ? <span className="text-green-400 text-xs">✓ Verified</span> : (
                    <form action={verifyMappingAction} className="flex items-center gap-1 justify-end"><input type="hidden" name="plaidAccountId" value={a.plaidAccountId} /><select name="finAccountId" className={input} defaultValue=""><option value="" disabled>Verify this is…</option>{accounts.filter((f) => f.kind === 'bank' || f.kind === 'credit_card').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select><button className="bg-green-600 text-white text-xs font-semibold px-3 py-2 rounded-lg">Verify</button></form>
                  )}</td>
                </tr>
              )})}</tbody></table>
            </div>
          ))}
        </div>

        {/* Transactions */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1"><h3 className="text-gray-300 font-semibold text-sm">Transactions <span className="text-gray-600">(classified)</span></h3><form action={syncTransactionsAction}><button className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Sync now</button></form></div>
          <div className="flex flex-wrap gap-2 mb-3">{txSummary.rows.map((r) => (<div key={r.txnClass} className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-1.5"><span className="text-gray-300 text-xs font-medium">{r.txnClass}</span><span className="text-gray-600 text-xs"> · {r.n}</span></div>))}</div>
          <table className="w-full text-sm"><tbody>{recentTx.slice(0, 20).map((t) => (
            <tr key={t.id} className="border-b border-gray-800/60"><td className="py-1.5 text-gray-500 text-xs whitespace-nowrap">{t.txnDate}</td><td className="py-1.5 text-gray-300">{(t.merchantName || t.name || '').slice(0, 44)}</td><td className="py-1.5"><span className="text-[11px] px-2 py-0.5 rounded-full border bg-gray-800 text-gray-400 border-gray-700">{t.txnClass}</span></td><td className="py-1.5 text-right tabular-nums text-gray-300">{t.direction === 'out' ? '-' : '+'}{money(Math.abs(t.amountCents))}</td></tr>
          ))}</tbody></table>
        </div>

        {/* Obligations confirm/ignore */}
        <div className="mt-6">
          <h3 className="text-gray-300 font-semibold text-sm mb-1">Recurring obligations <span className="text-gray-600">(confirm / ignore)</span></h3>
          {oblByStatus.confirmed.length > 0 && <table className="w-full text-sm mb-2"><tbody>{oblByStatus.confirmed.map((o) => (
            <tr key={o.id} className="border-b border-gray-800"><td className="py-1.5 text-gray-200">{o.critical && <span className="text-amber-400">★ </span>}{o.vendor}</td><td className="py-1.5 text-gray-600 text-xs">{o.category ?? '—'} · {o.frequency ?? '—'}</td><td className="py-1.5 text-right tabular-nums text-white">{money(o.amountCents)}</td><td className="py-1.5 pl-2 text-right"><form action={obligationStatusAction}><input type="hidden" name="id" value={o.id} /><input type="hidden" name="status" value="ignored" /><button className="text-gray-600 text-xs underline">ignore</button></form></td></tr>
          ))}</tbody></table>}
          {oblByStatus.proposed.length > 0 && <><p className="text-gray-600 text-xs mb-1">Proposed ({oblByStatus.proposed.length})</p><table className="w-full text-sm"><tbody>{oblByStatus.proposed.slice(0, 20).map((o) => (
            <tr key={o.id} className="border-b border-gray-800/60"><td className="py-1.5 text-gray-300">{o.vendor}<span className="block text-gray-600 text-xs">{o.occurrences}× · {o.frequency} · avg {money(o.avgAmountCents)}</span></td><td className="py-1.5 text-right tabular-nums text-gray-300">{money(o.amountCents)}</td><td className="py-1.5 pl-2 text-right whitespace-nowrap"><form action={obligationStatusAction} className="inline"><input type="hidden" name="id" value={o.id} /><input type="hidden" name="status" value="confirmed" /><button className="bg-green-700 text-white text-xs px-2 py-1 rounded">Confirm</button></form><form action={obligationStatusAction} className="inline ml-1"><input type="hidden" name="id" value={o.id} /><input type="hidden" name="status" value="ignored" /><button className="text-gray-500 text-xs underline">ignore</button></form></td></tr>
          ))}</tbody></table></>}
        </div>

        {/* Expected inflows admin */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-1"><h3 className="text-gray-300 font-semibold text-sm">Expected inflows</h3><form action={deriveInflowsAction}><button className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Re-derive</button></form></div>
          <table className="w-full text-sm mb-2"><tbody>{expectedInflows.slice(0, 12).map((inf) => (
            <tr key={inf.id} className="border-b border-gray-800/50"><td className="py-1 text-gray-500 text-xs whitespace-nowrap">{inf.expectedDate}</td><td className="py-1 text-gray-300">{inf.label}</td><td className="py-1"><span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${inf.confidence === 'high' ? 'bg-green-950/40 text-green-300 border-green-900/60' : inf.confidence === 'probable' ? 'bg-amber-950/40 text-amber-300 border-amber-900/60' : 'bg-gray-800 text-gray-400 border-gray-700'}`}>{inf.confidence}</span></td><td className="py-1 text-right tabular-nums text-green-300">+{money(inf.amountCents)}</td><td className="py-1 pl-2 text-right">{!inf.derived && <form action={inflowDismissAction}><input type="hidden" name="id" value={inf.id} /><button className="text-gray-600 text-[11px] underline">dismiss</button></form>}</td></tr>
          ))}</tbody></table>
          <form action={inflowAddAction} className="flex flex-wrap items-end gap-2"><label className="text-xs text-gray-500">What<br /><input name="label" placeholder="Ceramic coating — J. Smith" className={input} required /></label><label className="text-xs text-gray-500">Amount ($)<br /><input name="amount" type="number" step="0.01" className={input} required /></label><label className="text-xs text-gray-500">Expected date<br /><input name="expectedDate" type="date" className={input} required /></label><label className="text-xs text-gray-500">Confidence<br /><select name="confidence" className={input} defaultValue="probable"><option value="high">high</option><option value="probable">probable</option><option value="pipeline">pipeline</option></select></label><button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Add</button></form>
        </div>

        {/* Reserve policy */}
        <div className="mt-6">
          <h3 className="text-gray-300 font-semibold text-sm mb-1">Reserve policy <span className="text-gray-600">{reserves.configured ? '(configured)' : '(unconfigured — $0 assumed)'}</span></h3>
          <form action={reservesAction} className="flex flex-wrap items-end gap-2"><label className="text-xs text-gray-500">Payroll reserve ($)<br /><input name="payroll" type="number" step="0.01" defaultValue={(reserves.payrollReserveCents / 100) || ''} className={input} /></label><label className="text-xs text-gray-500">Tax reserve ($)<br /><input name="tax" type="number" step="0.01" defaultValue={(reserves.taxReserveCents / 100) || ''} className={input} /></label><label className="text-xs text-gray-500">Min operating buffer ($)<br /><input name="buffer" type="number" step="0.01" defaultValue={(reserves.minBufferCents / 100) || ''} className={input} /></label><button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Save</button></form>
        </div>

        {/* Payroll + Accounting book */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h3 className="text-gray-300 font-semibold text-sm mb-1">Payroll</h3>
            {payroll ? <p className="text-white text-sm mb-2">Next <b>{payroll.nextPayDate}</b> · expected cash <b>{money(payroll.expectedCashCents)}</b></p> : <p className="text-amber-400 text-sm mb-2">No next payroll entered.</p>}
            <form action={payrollAction} className="flex flex-wrap items-end gap-2"><label className="text-xs text-gray-500">Next pay date<br /><input name="nextPayDate" type="date" className={input} required /></label><label className="text-xs text-gray-500">Expected cash ($)<br /><input name="amount" type="number" step="0.01" min="0" className={input} required /></label><button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Save</button></form>
          </div>
          <div>
            <h3 className="text-gray-300 font-semibold text-sm mb-1">Accounting <span className="text-gray-600">(book — not cash)</span></h3>
            <p className="text-sm text-gray-300">P&amp;L this month: Income {dollars(s.plThisMonth?.income)} · Net {dollars(s.plThisMonth?.net)}</p>
            <p className="text-sm text-gray-300">Balance sheet: Assets {dollars(s.balanceSheet?.totalAssets)} · Liab {dollars(s.balanceSheet?.totalLiabilities)}</p>
            <div className="text-gray-600 text-xs mt-1">QuickBooks book understates real cash outflow — do not read as cash. <form action={refreshAction} className="inline"><button className="text-indigo-400 underline">Refresh from QuickBooks</button></form></div>
          </div>
        </div>

        {/* Documents */}
        <div className="mt-6">
          <h3 className="text-gray-300 font-semibold text-sm mb-1">Documents <span className="text-gray-600">(metadata only)</span></h3>
          {documents.length === 0 ? <p className="text-gray-500 text-sm mb-2">No documents recorded.</p> : <ul className="text-sm mb-2 space-y-1">{documents.map((d) => <li key={d.id} className="text-gray-300">{d.type} · {d.filename} {d.asOf ? `· as-of ${d.asOf}` : ''}</li>)}</ul>}
          <form action={documentAction} className="flex flex-wrap items-end gap-2"><label className="text-xs text-gray-500">Type<br /><input name="type" placeholder="loan_statement" className={input} required /></label><label className="text-xs text-gray-500">Filename<br /><input name="filename" className={input} required /></label><label className="text-xs text-gray-500">As-of<br /><input name="asOf" type="date" className={input} /></label><button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Record</button></form>
        </div>

        {clearing.length > 0 && <p className="text-amber-300/70 text-xs mt-4">Clearing/unreconciled (excluded from cash): {clearing.map((a) => `${a.name} ${money(a.balance?.cents)}`).join(' · ')}</p>}
      </details>

      <p className="text-gray-700 text-xs">CFO decision center · live bank/card feeds · read-only toward QuickBooks · no money movement.</p>
    </main>
  )
}
