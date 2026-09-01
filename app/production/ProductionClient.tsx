'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { DailyProduction, WeeklyProduction } from '@/apps/workflow/production'
import NavHeader from '@/app/components/NavHeader'

// Calendar-day math on a plain YYYY-MM-DD (UTC noon to avoid DST/local shifts).
function addDays(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day + n, 12)).toISOString().slice(0, 10)
}
const money = (c: number) => `$${(c / 100).toFixed(2)}`
const money0 = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })

export default function ProductionClient({ data, week, today, date }: { data: DailyProduction; week: WeeklyProduction; today: string; date: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // Selected date lives in the URL. Arrows move ±1 calendar day; the calendar jumps farther.
  // Same state for both — pure navigation, never a write.
  const go = (d: string) => startTransition(() => router.push(`/production?date=${d}`, { scroll: false }))

  const label = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: data.tz })
  const kindLabel = (s: string) => s === 'dealer' ? 'Dealer' : s === 'unknown' ? 'Other' : 'Retail'

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/work-board', label: 'Work Board' }} />
      <div className="max-w-3xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-4">Production</h1>

        {/* THIS WEEK — Monday→Saturday. WEEK TOTAL is the headline number. */}
        <div className="rounded-2xl bg-gray-900 border border-gray-800 p-4 mb-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-gray-500 text-xs uppercase tracking-widest">This week</p>
              <p className="text-gray-500 text-[11px] mt-0.5">{shortDate(week.weekStartMon)} – {shortDate(week.weekEndSat)} · Mon–Sat</p>
            </div>
            <div className="text-right">
              <p className="text-gray-500 text-xs uppercase tracking-widest">Week total</p>
              <p className="text-3xl font-black tabular-nums text-emerald-300">{money0(week.weekTotalCents)}</p>
            </div>
          </div>

          {/* Retail / Dealer / Other breakdown (reconciles to Week total) */}
          <div className="grid grid-cols-3 gap-2 mt-3">
            <div className="rounded-xl bg-emerald-950/20 border border-emerald-900/40 px-3 py-2">
              <p className="text-emerald-300/80 text-[11px] uppercase tracking-wider">Retail</p>
              <p className="text-white font-bold tabular-nums">{money0(week.byKind.retail)}</p>
            </div>
            <div className="rounded-xl bg-gray-800/50 border border-gray-700 px-3 py-2">
              <p className="text-gray-400 text-[11px] uppercase tracking-wider">Dealer</p>
              <p className="text-white font-bold tabular-nums">{money0(week.byKind.dealer)}</p>
            </div>
            <div className="rounded-xl bg-gray-800/30 border border-gray-800 px-3 py-2">
              <p className="text-gray-500 text-[11px] uppercase tracking-wider">Other</p>
              <p className="text-gray-300 font-bold tabular-nums">{week.byKind.unknown > 0 ? money0(week.byKind.unknown) : '—'}</p>
            </div>
          </div>

          {/* Mon..Sat rows (future days blank). Tap a day → daily view for that date. */}
          <div className="mt-3 divide-y divide-gray-800/70">
            {week.days.map((d) => (
              <button key={d.date} onClick={() => go(d.date)}
                className={`w-full flex items-center justify-between py-2 text-sm active:opacity-70 ${d.date === date ? 'text-white' : 'text-gray-300'}`}>
                <span className="flex items-center gap-2">
                  <span className={`w-9 text-left ${d.date === today ? 'text-emerald-300 font-semibold' : ''}`}>{d.weekday}</span>
                  <span className="text-gray-600 text-xs">{shortDate(d.date)}</span>
                </span>
                <span className="tabular-nums font-semibold">{d.isFuture ? <span className="text-gray-700">—</span> : d.totalCents > 0 ? money0(d.totalCents) : <span className="text-gray-600">$0</span>}</span>
              </button>
            ))}
          </div>

          {/* Week navigation */}
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-800">
            <button onClick={() => go(addDays(week.weekStartMon, -7))} disabled={pending} className="text-sm text-gray-300 px-3 py-2 rounded-xl border border-gray-700 active:opacity-70 disabled:opacity-40">‹ Previous week</button>
            <button onClick={() => go(today)} disabled={pending} className="text-sm text-gray-400 px-3 py-2 active:opacity-70 disabled:opacity-40">This week</button>
            <button onClick={() => go(addDays(week.weekStartMon, 7))} disabled={pending} className="text-sm text-gray-300 px-3 py-2 rounded-xl border border-gray-700 active:opacity-70 disabled:opacity-40">Next week ›</button>
          </div>
        </div>

        <h2 className="text-lg font-bold mb-3">Daily</h2>

        {/* Date navigator: ‹ [date] › with the calendar picker for bigger jumps */}
        <div className="flex items-center gap-2 mb-5">
          <button onClick={() => go(addDays(date, -1))} aria-label="Previous day" disabled={pending}
            className="w-11 h-11 shrink-0 rounded-xl bg-gray-800 border border-gray-700 text-xl text-gray-200 active:opacity-70 disabled:opacity-40">‹</button>
          <div className="flex-1 text-center">
            <p className={`text-base font-semibold ${pending ? 'text-gray-500' : 'text-white'}`}>{label}{date === today ? ' · today' : ''}</p>
          </div>
          <button onClick={() => go(addDays(date, +1))} aria-label="Next day" disabled={pending}
            className="w-11 h-11 shrink-0 rounded-xl bg-gray-800 border border-gray-700 text-xl text-gray-200 active:opacity-70 disabled:opacity-40">›</button>
          <input type="date" value={date} onChange={(e) => { if (e.target.value) go(e.target.value) }} aria-label="Pick a date"
            className="shrink-0 bg-gray-800 border border-gray-700 rounded-xl px-2 py-2.5 text-xs text-gray-300" />
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
            <p className="text-gray-500 text-xs uppercase tracking-widest">Completed</p>
            <p className="text-3xl font-bold mt-0.5">{pending ? '…' : data.count}</p>
            <p className="text-emerald-300 text-sm font-semibold mt-1 tabular-nums">{money0(data.jobs.reduce((s, j) => s + (j.priceCents ?? 0), 0))}</p>
          </div>
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-1.5">By technician</p>
            {data.byTech.length === 0 ? <p className="text-gray-600 text-sm">—</p> : (
              <div className="flex flex-wrap gap-1.5">
                {data.byTech.map((t) => <span key={t.name} className="text-xs bg-gray-800 border border-gray-700 rounded-lg px-2 py-0.5">{t.name} · <span className="font-bold">{t.count}</span></span>)}
              </div>
            )}
          </div>
        </div>

        {/* Jobs — tappable cards → the same /orders/[id] Job detail as Work Board / Ready */}
        {data.jobs.length === 0 ? (
          <p className="rounded-2xl bg-gray-900 border border-gray-800 px-4 py-10 text-center text-gray-600 text-sm">No Jobs completed on {label}.</p>
        ) : (
          <div className="space-y-2">
            {data.jobs.map((j) => (
              <Link key={j.id} href={`/orders/${j.id}`}
                className="block rounded-2xl bg-gray-900 border border-gray-800 px-4 py-3.5 active:bg-gray-800">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-semibold truncate">{j.customer || 'Unknown'}</p>
                    <p className="text-gray-400 text-sm truncate">{j.vehicle}</p>
                    <p className="text-gray-500 text-xs mt-0.5 truncate">{j.services.join(', ') || '—'}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-white font-bold tabular-nums">{j.priceCents != null ? money(j.priceCents) : '—'}</p>
                    <p className="text-gray-600 text-[11px] mt-0.5">{kindLabel(j.source)} · {fmtTime(j.completedAt)}</p>
                    {j.completedBy && <p className="text-gray-600 text-[11px]">{j.completedBy}</p>}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
