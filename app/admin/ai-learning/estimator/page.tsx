import Link from 'next/link'
import { listEstimatorLearningEvents } from '@/apps/ai-learning/db'
import type { LineItemSnapshot } from '@/apps/ai-learning/db'

export const dynamic = 'force-dynamic'

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function pct(n: number, d: number): string {
  if (d === 0) return '—'
  return `${Math.round((n / d) * 100)}%`
}

function colorForPct(p: number | null, higherIsWorse = false): string {
  if (p === null) return 'text-gray-500'
  const good = higherIsWorse ? p < 10 : p >= 90
  const warn = higherIsWorse ? p < 30 : p >= 70
  return good ? 'text-green-400' : warn ? 'text-yellow-400' : 'text-red-400'
}

export default async function EstimatorLearningPage() {
  const events = await listEstimatorLearningEvents()
  const total  = events.length

  if (total === 0) {
    return (
      <main className="max-w-5xl mx-auto px-6 py-10">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-sm transition-colors mb-8"
        >
          <span>←</span>
          <span>Back to Admin</span>
        </Link>
        <h1 className="text-2xl font-bold text-white mb-2">Retail Estimator Learning</h1>
        <div className="bg-gray-800 border border-gray-700 rounded-2xl px-6 py-16 text-center mt-8">
          <p className="text-gray-400 text-lg font-medium">No approved estimates yet</p>
          <p className="text-gray-600 text-sm mt-2">
            A learning event is recorded each time an employee approves an estimate.
          </p>
        </div>
      </main>
    )
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────

  const priceAdjusted    = events.filter(e => e.pricingWasCorrected).length
  const vehicleCorrected = events.filter(e => e.vehicleWasCorrected).length
  const withPrices       = events.filter(e => e.aiRecommendedPriceCents !== null && e.approvedPriceCents !== null)

  const avgAiPrice = withPrices.length
    ? Math.round(withPrices.reduce((s, e) => s + (e.aiRecommendedPriceCents ?? 0), 0) / withPrices.length)
    : null
  const avgApprovedPrice = withPrices.length
    ? Math.round(withPrices.reduce((s, e) => s + (e.approvedPriceCents ?? 0), 0) / withPrices.length)
    : null

  const avgDelta = withPrices.length
    ? Math.round(withPrices.reduce((s, e) => s + (e.priceAdjustmentCents ?? 0), 0) / withPrices.length)
    : null

  // By service focus
  const byService = new Map<string, { total: number; adjusted: number; totalDelta: number; count: number }>()
  for (const e of events) {
    const k = e.serviceFocus ?? 'unknown'
    if (!byService.has(k)) byService.set(k, { total: 0, adjusted: 0, totalDelta: 0, count: 0 })
    const s = byService.get(k)!
    s.total++
    if (e.pricingWasCorrected) s.adjusted++
    if (e.priceAdjustmentCents !== null) { s.totalDelta += e.priceAdjustmentCents; s.count++ }
  }

  const serviceFocusLabels: Record<string, string> = {
    full_detail:       'Full Detail',
    exterior_only:     'Exterior Only',
    interior_only:     'Interior Only',
    specific_service:  'Specific Service',
  }

  const adjustmentPct = total > 0 ? Math.round((priceAdjusted / total) * 100) : null
  const vehicleCorrPct = total > 0 ? Math.round((vehicleCorrected / total) * 100) : null

  return (
    <main className="max-w-5xl mx-auto px-6 py-10">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-sm transition-colors mb-8"
      >
        <span>←</span>
        <span>Back to Admin</span>
      </Link>

      <h1 className="text-2xl font-bold text-white mb-1">Retail Estimator Learning</h1>
      <p className="text-gray-500 text-sm mb-8">
        {total} approved estimate{total !== 1 ? 's' : ''} ·{' '}
        {priceAdjusted} with price adjustment{priceAdjusted !== 1 ? 's' : ''}
      </p>

      <div className="space-y-10">

        {/* ── HEADLINE METRICS ─────────────────────────────────────────── */}
        <section>
          <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Pricing Metrics</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-gray-900 rounded-2xl p-4 text-center">
              <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Estimates</div>
              <div className="text-2xl font-bold text-white">{total}</div>
            </div>
            <div className="bg-gray-900 rounded-2xl p-4 text-center">
              <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Price Adjusted</div>
              <div className={`text-2xl font-bold tabular-nums ${colorForPct(adjustmentPct, true)}`}>
                {adjustmentPct !== null ? `${adjustmentPct}%` : '—'}
              </div>
              <div className="text-gray-600 text-xs mt-1">{priceAdjusted}/{total}</div>
            </div>
            <div className="bg-gray-900 rounded-2xl p-4 text-center">
              <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Avg AI Price</div>
              <div className="text-2xl font-bold text-blue-400">{formatCents(avgAiPrice)}</div>
            </div>
            <div className="bg-gray-900 rounded-2xl p-4 text-center">
              <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Avg Approved</div>
              <div className="text-2xl font-bold text-green-400">{formatCents(avgApprovedPrice)}</div>
              {avgDelta !== null && (
                <div className={`text-xs mt-1 ${avgDelta > 0 ? 'text-green-600' : avgDelta < 0 ? 'text-red-600' : 'text-gray-600'}`}>
                  avg {avgDelta > 0 ? '+' : ''}{formatCents(avgDelta)} vs AI
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 sm:grid-cols-2 gap-3">
            <div className="bg-gray-900 rounded-2xl p-4 text-center">
              <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Vehicle Corrected</div>
              <div className={`text-2xl font-bold tabular-nums ${colorForPct(vehicleCorrPct, true)}`}>
                {vehicleCorrPct !== null ? `${vehicleCorrPct}%` : '—'}
              </div>
              <div className="text-gray-600 text-xs mt-1">{vehicleCorrected}/{total} estimates</div>
            </div>
            <div className="bg-gray-900 rounded-2xl p-4 text-center">
              <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Accepted As-Is</div>
              <div className="text-2xl font-bold text-green-400">
                {pct(total - priceAdjusted, total)}
              </div>
              <div className="text-gray-600 text-xs mt-1">{total - priceAdjusted}/{total}</div>
            </div>
          </div>
        </section>

        {/* ── BY SERVICE FOCUS ──────────────────────────────────────────── */}
        {byService.size > 0 && (
          <section>
            <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">By Service Focus</h2>
            <div className="bg-gray-900 rounded-2xl px-5 divide-y divide-gray-800">
              {[...byService.entries()].map(([key, s]) => {
                const adjRate = s.total > 0 ? Math.round((s.adjusted / s.total) * 100) : null
                const avgDeltaLocal = s.count > 0 ? Math.round(s.totalDelta / s.count) : null
                return (
                  <div key={key} className="flex items-center justify-between py-3 gap-4">
                    <span className="text-gray-300 text-sm">{serviceFocusLabels[key] ?? key}</span>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="text-right">
                        <div className="text-gray-600 text-xs">adjusted</div>
                        <div className={`font-bold tabular-nums ${colorForPct(adjRate, true)}`}>
                          {adjRate !== null ? `${adjRate}%` : '—'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-gray-600 text-xs">avg delta</div>
                        <div className={`font-mono text-xs ${avgDeltaLocal !== null ? (avgDeltaLocal >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-600'}`}>
                          {avgDeltaLocal !== null
                            ? `${avgDeltaLocal >= 0 ? '+' : ''}${formatCents(avgDeltaLocal)}`
                            : '—'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-gray-600 text-xs">count</div>
                        <div className="text-gray-400 text-xs">{s.total}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ── ESTIMATE LIST ─────────────────────────────────────────────── */}
        <section>
          <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">
            All Approved Estimates — AI Prediction vs Employee Approved
          </h2>
          <div className="space-y-3">
            {events.map(e => {
              const pricingChanged = e.pricingWasCorrected
              const delta          = e.priceAdjustmentCents
              const lineItems      = (e.lineItemsSnapshot as LineItemSnapshot[] | null) ?? []

              return (
                <div key={e.id} className="bg-gray-900 rounded-2xl p-5 space-y-4">
                  {/* Header row */}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-gray-400 text-xs">
                        {new Date(e.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                      {e.serviceFocus && (
                        <span className="text-xs bg-purple-950 text-purple-300 rounded px-2 py-0.5">
                          {serviceFocusLabels[e.serviceFocus] ?? e.serviceFocus}
                        </span>
                      )}
                      {pricingChanged ? (
                        <span className="text-xs bg-yellow-950 text-yellow-400 rounded px-2 py-0.5">price adjusted</span>
                      ) : (
                        <span className="text-xs bg-green-950 text-green-600 rounded px-2 py-0.5">accepted as-is</span>
                      )}
                      {e.vehicleWasCorrected && (
                        <span className="text-xs bg-orange-950 text-orange-400 rounded px-2 py-0.5">vehicle corrected</span>
                      )}
                    </div>
                  </div>

                  {/* Vehicle info */}
                  {(e.vehicleYear || e.vehicleMake || e.vehicleModel) && (
                    <div className="text-gray-400 text-sm">
                      {[e.vehicleYear, e.vehicleMake, e.vehicleModel, e.vehicleColor].filter(Boolean).join(' ')}
                    </div>
                  )}

                  {/* Pricing comparison */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-gray-800 rounded-xl p-3 text-center">
                      <div className="text-gray-500 text-xs mb-1">AI Recommended</div>
                      <div className="text-blue-300 font-bold text-lg font-mono">
                        {formatCents(e.aiRecommendedPriceCents)}
                      </div>
                    </div>
                    <div className={`rounded-xl p-3 text-center border ${pricingChanged ? 'bg-yellow-950/30 border-yellow-800/50' : 'bg-gray-800 border-transparent'}`}>
                      <div className="text-gray-500 text-xs mb-1">Employee Approved</div>
                      <div className={`font-bold text-lg font-mono ${pricingChanged ? 'text-yellow-300' : 'text-green-400'}`}>
                        {formatCents(e.approvedPriceCents)}
                      </div>
                    </div>
                    <div className="bg-gray-800 rounded-xl p-3 text-center">
                      <div className="text-gray-500 text-xs mb-1">Δ Delta</div>
                      <div className={`font-bold text-lg font-mono ${delta == null ? 'text-gray-600' : delta > 0 ? 'text-green-400' : delta < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                        {delta == null ? '—' : `${delta >= 0 ? '+' : ''}${formatCents(delta)}`}
                      </div>
                    </div>
                  </div>

                  {/* Line items snapshot */}
                  {lineItems.length > 0 && (
                    <details className="bg-gray-800 rounded-xl overflow-hidden">
                      <summary className="px-4 py-2 text-gray-500 text-xs cursor-pointer select-none hover:text-gray-300 transition-colors">
                        {lineItems.length} line item{lineItems.length !== 1 ? 's' : ''} ▾
                      </summary>
                      <div className="px-4 pb-3 divide-y divide-gray-700">
                        {lineItems.map(li => (
                          <div key={li.id} className="flex items-center justify-between py-2 text-xs">
                            <div className="flex items-center gap-2">
                              {!li.included && (
                                <span className="text-gray-600 line-through">{li.description}</span>
                              )}
                              {li.included && (
                                <span className="text-gray-300">{li.description}</span>
                              )}
                              {li.wasAddedByEmployee && (
                                <span className="text-purple-400 text-xs">(added by employee)</span>
                              )}
                            </div>
                            <span className="text-gray-400 font-mono">{formatCents(li.aiCents)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )
            })}
          </div>
        </section>

      </div>
    </main>
  )
}
