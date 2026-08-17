'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { DailyProduction } from '@/apps/workflow/production'
import NavHeader from '@/app/components/NavHeader'

// Calendar-day math on a plain YYYY-MM-DD (UTC to avoid DST/local shifts).
function addDays(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10)
}
const money = (c: number) => `$${(c / 100).toFixed(2)}`

export default function ProductionClient({ data, today, date }: { data: DailyProduction; today: string; date: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // Selected date lives in the URL. Arrows move ±1 calendar day; the calendar jumps farther.
  // Same state for both — pure navigation, never a write.
  const go = (d: string) => startTransition(() => router.push(`/production?date=${d}`, { scroll: false }))

  const label = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: data.tz })

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/work-board', label: 'Work Board' }} />
      <div className="max-w-3xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-4">Daily Production</h1>

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
                    <p className="text-gray-600 text-[11px] mt-0.5">{j.source === 'dealer' ? 'Dealer' : 'Retail'} · {fmtTime(j.completedAt)}</p>
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
