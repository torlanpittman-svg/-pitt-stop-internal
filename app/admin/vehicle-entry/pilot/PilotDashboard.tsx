'use client'

import { useState, useEffect, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

type Stats = {
  total:                  number
  synced:                 number
  waitingForReview:       number
  failed:                 number
  vehicleInfoAccuracyPct: number | null
  stockAccuracyPct:       number | null
  vinFallbacks:           number
  avgScanMs:              number | null
  firstScanAt:            string | null
  lastScanAt:             string | null
  correctionsPerVehicle:  number | null
  corrections:            number
  invoiceSections:        InvoiceSection[]
  speedProgression:       SpeedEntry[]
  needsAttention:         NeedsAttentionItem[]
}

type InvoiceSection = {
  dealershipName: string
  invoiceNumber:  string | null
  total:          number
  synced:         number
  waiting:        number
  failed:         number
}

type SpeedEntry = {
  n:                 number
  vehicle:           string
  stockNumber:       string
  dealershipName:    string
  invoiceSyncStatus: string | null
  wasCorrected:      boolean
  entryMethod:       string
  scanMs:            number | null
  gapMs:             number | null
  scanTimeAt:        string | null
}

type NeedsAttentionItem = {
  n:           number
  stockNumber: string
  dealership:  string
  syncStatus:  string | null
  reason:      string
}

type Intervention = {
  id:        string
  type:      'help_requested' | 'manager_touched'
  reason:    string | null
  createdAt: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMs(ms: number | null): string {
  if (ms === null || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function pct(n: number | null): string {
  return n !== null ? `${n}%` : '—'
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">
      {children}
    </h2>
  )
}

function Row({
  label, value, valueClass = 'text-white', sub,
}: {
  label: string; value: string | number; valueClass?: string; sub?: string
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-800 last:border-0">
      <span className="text-gray-400 text-sm">{label}</span>
      <div className="text-right">
        <span className={`text-sm font-semibold tabular-nums ${valueClass}`}>{value}</span>
        {sub && <span className="text-gray-600 text-xs ml-2">{sub}</span>}
      </div>
    </div>
  )
}

function AccuracyRow({
  label, pctValue, target,
}: {
  label: string; pctValue: number | null; target: string
}) {
  const color =
    pctValue === null    ? 'text-gray-500' :
    pctValue >= 97       ? 'text-green-400' :
    pctValue >= 85       ? 'text-yellow-400' :
                           'text-red-400'

  const tick =
    pctValue === null    ? '' :
    pctValue >= 97       ? ' ✓' :
    pctValue >= 85       ? '' :
                           ' ✗'

  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-800 last:border-0">
      <div>
        <span className="text-gray-400 text-sm">{label}</span>
        <span className="text-gray-600 text-xs ml-2">target {target}</span>
      </div>
      <span className={`text-sm font-bold tabular-nums ${color}`}>
        {pct(pctValue)}{tick}
      </span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PilotDashboard() {
  const [stats,          setStats]          = useState<Stats | null>(null)
  const [interventions,  setInterventions]  = useState<Intervention[]>([])
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState<string | null>(null)
  const [resetting,      setResetting]      = useState(false)
  const [logReason,      setLogReason]      = useState('')
  const [showLogForm,    setShowLogForm]    = useState<'help_requested' | 'manager_touched' | null>(null)
  const [lastRefresh,    setLastRefresh]    = useState<Date>(new Date())

  const refresh = useCallback(async () => {
    try {
      const [statsRes, intRes] = await Promise.all([
        fetch('/api/vehicle-entry/pilot-stats'),
        fetch('/api/vehicle-entry/pilot-interventions'),
      ])
      if (!statsRes.ok) {
        const text = await statsRes.text()
        throw new Error(`pilot-stats ${statsRes.status}: ${text || '(empty response)'}`)
      }
      const [statsData, intData] = await Promise.all([statsRes.json(), intRes.json()])
      setStats(statsData)
      setInterventions(intData.interventions ?? [])
      setError(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
      setLastRefresh(new Date())
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const id = setInterval(refresh, 15_000)
    return () => clearInterval(id)
  }, [refresh])

  async function logIntervention(type: 'help_requested' | 'manager_touched') {
    await fetch('/api/vehicle-entry/pilot-interventions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, reason: logReason || null }),
    })
    setShowLogForm(null)
    setLogReason('')
    await refresh()
  }

  async function handleReset() {
    if (!confirm(
      'Delete all pilot vehicle entries and clear all mock invoices.\n\n' +
      'This also clears intervention logs.\n\nContinue?'
    )) return
    setResetting(true)
    await fetch('/api/vehicle-entry/pilot-reset', { method: 'POST' })
    // Clear intervention logs by deleting them via DB — for now refresh and inform
    setResetting(false)
    await refresh()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="w-8 h-8 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="max-w-2xl">
        <div className="bg-red-950/40 border border-red-800 rounded-2xl px-6 py-8 text-center space-y-4">
          <p className="text-red-300 font-semibold">Dashboard failed to load</p>
          <p className="text-red-500 text-sm font-mono break-all">{error ?? 'No data returned'}</p>
          <button
            onClick={refresh}
            className="mt-2 text-sm px-4 py-2 rounded-lg border border-red-800 text-red-400 hover:border-red-600 hover:text-red-300 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  const s = stats

  const managerTouched   = interventions.filter(i => i.type === 'manager_touched').length
  const helpRequested    = interventions.filter(i => i.type === 'help_requested').length
  const interventionReasons = interventions.map(i => i.reason).filter(Boolean) as string[]

  // Goal meter: green if no manager touches yet, red if any, gray if not started
  const goalState: 'not_started' | 'yes' | 'no' =
    s.total === 0           ? 'not_started' :
    managerTouched === 0    ? 'yes'          :
                              'no'

  const timed   = s.speedProgression.filter(e => e.scanMs !== null)
  const fastest = timed.length > 0 ? Math.min(...timed.map(e => e.scanMs!)) : null

  return (
    <div className="space-y-8 max-w-2xl">

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-gray-600 text-xs">
          Updates every 15s · {lastRefresh.toLocaleTimeString()}
        </p>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-500 hover:text-gray-300 transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={handleReset}
            disabled={resetting}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-800 transition-colors disabled:opacity-40"
          >
            {resetting ? 'Resetting…' : 'Reset'}
          </button>
        </div>
      </div>

      {/* ── TODAY'S VEHICLES ─────────────────────────────────────────────── */}
      <div>
        <SectionHeading>Today&rsquo;s Vehicles</SectionHeading>
        <div className="bg-gray-900 rounded-2xl px-5 divide-y-0">
          <Row
            label="Total scanned"
            value={s.total}
            valueClass={s.total > 0 ? 'text-white' : 'text-gray-500'}
          />
          <Row
            label="Successfully added to invoice"
            value={s.total > 0 ? `${s.synced} of ${s.total}` : '—'}
            valueClass={s.synced === s.total && s.total > 0 ? 'text-green-400' : s.synced > 0 ? 'text-yellow-400' : 'text-gray-500'}
          />
          <Row
            label="Waiting for review"
            value={s.waitingForReview || '—'}
            valueClass={s.waitingForReview > 0 ? 'text-yellow-400' : 'text-gray-500'}
          />
          <Row
            label="Failed"
            value={s.failed || '—'}
            valueClass={s.failed > 0 ? 'text-red-400' : 'text-gray-500'}
          />
        </div>
      </div>

      {/* ── OCR ──────────────────────────────────────────────────────────── */}
      <div>
        <SectionHeading>OCR</SectionHeading>
        <div className="bg-gray-900 rounded-2xl px-5 divide-y-0">
          <AccuracyRow label="Vehicle info accuracy" pctValue={s.vehicleInfoAccuracyPct} target="99%" />
          <AccuracyRow label="Stock number accuracy" pctValue={s.stockAccuracyPct}       target="90–95%" />
          <Row
            label="VIN fallbacks used"
            value={s.vinFallbacks || '—'}
            valueClass={s.vinFallbacks > 0 ? 'text-purple-400' : 'text-gray-500'}
            sub={s.vinFallbacks > 0 ? 'tag unreadable' : undefined}
          />
        </div>
      </div>

      {/* ── EMPLOYEE ─────────────────────────────────────────────────────── */}
      <div>
        <SectionHeading>Employee</SectionHeading>
        <div className="bg-gray-900 rounded-2xl px-5 divide-y-0">
          <Row
            label="Average seconds per vehicle"
            value={fmtMs(s.avgScanMs)}
            valueClass="text-white"
            sub={fastest !== null && timed.length > 2 ? `best: ${fmtMs(fastest)}` : undefined}
          />
          <Row label="First scan"              value={s.firstScanAt  ?? '—'} />
          <Row label="Last scan"               value={s.lastScanAt   ?? '—'} />
          <Row
            label="Corrections per vehicle"
            value={s.correctionsPerVehicle !== null ? s.correctionsPerVehicle.toFixed(2) : '—'}
            valueClass={
              s.correctionsPerVehicle === null ? 'text-gray-500' :
              s.correctionsPerVehicle <= 0.1   ? 'text-green-400' :
              s.correctionsPerVehicle <= 0.3   ? 'text-yellow-400' :
                                                  'text-red-400'
            }
            sub={s.corrections > 0 ? `${s.corrections} total` : undefined}
          />
        </div>

        {/* Speed progression — shows the employee getting faster */}
        {s.speedProgression.length > 0 && (
          <div className="mt-2 bg-gray-900 rounded-2xl overflow-hidden">
            <div className="grid grid-cols-[1.5rem_1fr_auto_auto] gap-3 px-5 py-2.5 border-b border-gray-800 text-xs text-gray-600 uppercase tracking-wide">
              <span>#</span>
              <span>Vehicle</span>
              <span className="text-right">Time</span>
              <span className="text-right">Gap</span>
            </div>
            <div className="max-h-72 overflow-y-auto divide-y divide-gray-800">
              {s.speedProgression.map(e => {
                const isFastest = e.scanMs !== null && e.scanMs === fastest && timed.length > 2
                return (
                  <div
                    key={e.n}
                    className={`grid grid-cols-[1.5rem_1fr_auto_auto] gap-3 items-center px-5 py-2.5 text-sm
                      ${isFastest ? 'bg-green-950/30' : ''}`}
                  >
                    <span className="text-gray-600 text-xs">{e.n}</span>
                    <div className="min-w-0">
                      <span className="text-gray-300 truncate block">{e.vehicle}</span>
                      <span className="text-gray-600 font-mono text-xs">{e.stockNumber}</span>
                      {e.wasCorrected && <span className="text-yellow-600 text-xs ml-1">edited</span>}
                      {e.entryMethod === 'vin-fallback' && <span className="text-purple-500 text-xs ml-1">VIN</span>}
                    </div>
                    <span className={`text-xs font-mono text-right ${isFastest ? 'text-green-400 font-bold' : 'text-gray-300'}`}>
                      {fmtMs(e.scanMs)}
                    </span>
                    <span className="text-gray-700 font-mono text-xs text-right">
                      {e.gapMs !== null && e.gapMs > 0 ? `+${fmtMs(e.gapMs)}` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── INVOICE ──────────────────────────────────────────────────────── */}
      <div>
        <SectionHeading>Invoice</SectionHeading>
        {s.invoiceSections.length === 0 ? (
          <div className="bg-gray-900 rounded-2xl px-5 py-4 text-gray-600 text-sm">No active batches found</div>
        ) : (
          <div className="bg-gray-900 rounded-2xl px-5 divide-y-0">
            {s.invoiceSections.map(inv => {
              const allGood = inv.total > 0 && inv.synced === inv.total
              const hasIssue = inv.waiting > 0 || inv.failed > 0
              return (
                <div key={inv.dealershipName} className="flex items-center justify-between py-3 border-b border-gray-800 last:border-0">
                  <div>
                    <span className="text-gray-300 text-sm font-medium">{inv.dealershipName}</span>
                    {inv.invoiceNumber && (
                      <span className="text-gray-600 font-mono text-xs ml-2">{inv.invoiceNumber}</span>
                    )}
                  </div>
                  <div className="text-right">
                    {inv.total === 0 ? (
                      <span className="text-gray-600 text-sm">No scans yet</span>
                    ) : (
                      <>
                        <span className={`text-sm font-semibold ${allGood ? 'text-green-400' : hasIssue ? 'text-yellow-400' : 'text-white'}`}>
                          {inv.synced} of {inv.total} added
                        </span>
                        {inv.waiting > 0 && (
                          <span className="text-yellow-500 text-xs block">{inv.waiting} waiting</span>
                        )}
                        {inv.failed > 0 && (
                          <span className="text-red-400 text-xs block">{inv.failed} failed</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── MANAGER INTERVENTION ─────────────────────────────────────────── */}
      <div>
        <SectionHeading>Manager Intervention</SectionHeading>
        <div className="bg-gray-900 rounded-2xl px-5 divide-y-0">
          <Row
            label="Times employee requested help"
            value={helpRequested || '—'}
            valueClass={helpRequested > 0 ? 'text-yellow-400' : 'text-gray-500'}
          />
          <Row
            label="Times manager touched the phone"
            value={managerTouched || '—'}
            valueClass={managerTouched > 0 ? 'text-red-400' : 'text-gray-500'}
          />
          {interventionReasons.length > 0 && (
            <div className="py-3 border-b border-gray-800">
              <div className="text-gray-500 text-xs uppercase tracking-wide mb-2">Reasons</div>
              <ul className="space-y-1">
                {interventionReasons.map((r, i) => (
                  <li key={i} className="text-gray-300 text-sm">· {r}</li>
                ))}
              </ul>
            </div>
          )}
          {/* Log buttons */}
          <div className="py-4 flex gap-2">
            <button
              onClick={() => setShowLogForm(showLogForm === 'help_requested' ? null : 'help_requested')}
              className="text-xs px-3 py-2 rounded-lg border border-yellow-800 text-yellow-500 hover:border-yellow-600 transition-colors"
            >
              + Employee asked for help
            </button>
            <button
              onClick={() => setShowLogForm(showLogForm === 'manager_touched' ? null : 'manager_touched')}
              className="text-xs px-3 py-2 rounded-lg border border-red-900 text-red-500 hover:border-red-700 transition-colors"
            >
              + I touched the phone
            </button>
          </div>
          {showLogForm && (
            <div className="pb-4 flex gap-2">
              <input
                type="text"
                value={logReason}
                onChange={e => setLogReason(e.target.value)}
                placeholder="Reason (optional)"
                className="flex-1 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-gray-500"
                onKeyDown={e => { if (e.key === 'Enter') logIntervention(showLogForm) }}
                autoFocus
              />
              <button
                onClick={() => logIntervention(showLogForm)}
                className="text-xs px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white font-semibold transition-colors"
              >
                Log
              </button>
              <button
                onClick={() => { setShowLogForm(null); setLogReason('') }}
                className="text-xs px-3 py-2 rounded-lg border border-gray-700 text-gray-500"
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Needs attention detail */}
        {s.needsAttention.length > 0 && (
          <div className="mt-2 bg-gray-900 rounded-2xl px-5 py-4 space-y-2">
            <div className="text-gray-500 text-xs uppercase tracking-wide mb-3">Items needing attention</div>
            {s.needsAttention.map(a => (
              <div key={a.n} className="grid grid-cols-[1.5rem_auto_1fr] gap-3 text-sm items-start">
                <span className="text-gray-600 text-xs">#{a.n}</span>
                <span className="text-white font-mono">{a.stockNumber}</span>
                <span className="text-gray-500 text-xs">{a.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── GOAL METER ───────────────────────────────────────────────────── */}
      <div>
        <SectionHeading>Goal Meter</SectionHeading>
        <div className={`rounded-2xl p-6 border-2 text-center
          ${goalState === 'not_started' ? 'bg-gray-900 border-gray-800' :
            goalState === 'yes'         ? 'bg-green-950/40 border-green-800' :
                                          'bg-red-950/40 border-red-800'}`}
        >
          <p className="text-gray-400 text-sm mb-5">
            Can an employee scan every dealership vehicle today without manager intervention?
          </p>

          {goalState === 'not_started' ? (
            <div className="text-gray-600 text-4xl font-bold">Waiting to start</div>
          ) : goalState === 'yes' ? (
            <>
              <div className="text-6xl mb-3">🟢</div>
              <div className="text-green-300 text-3xl font-bold">YES</div>
              <p className="text-green-600 text-sm mt-2">
                {s.total} vehicle{s.total !== 1 ? 's' : ''} scanned · 0 manager touches
              </p>
            </>
          ) : (
            <>
              <div className="text-6xl mb-3">🔴</div>
              <div className="text-red-300 text-3xl font-bold">NO</div>
              <p className="text-red-600 text-sm mt-2">
                {managerTouched} manager touch{managerTouched !== 1 ? 'es' : ''} logged
              </p>
              {interventionReasons.length > 0 && (
                <p className="text-gray-600 text-xs mt-1">
                  {interventionReasons.join(' · ')}
                </p>
              )}
            </>
          )}
        </div>
      </div>

    </div>
  )
}
