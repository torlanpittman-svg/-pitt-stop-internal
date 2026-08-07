'use client'

import { useState, useCallback } from 'react'
import type { DailyProduction } from '@/apps/workflow/production'
import NavHeader from '@/app/components/NavHeader'

export default function ProductionClient({ initial, today }: { initial: DailyProduction; today: string }) {
  const [data, setData] = useState<DailyProduction>(initial)
  const [date, setDate] = useState(today)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (d: string) => {
    setDate(d); setLoading(true)
    try {
      const r = await fetch(`/api/production?date=${d}`, { cache: 'no-store' })
      const j = await r.json(); if (j.ok) setData(j)
    } finally { setLoading(false) }
  }, [])

  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: data.tz })

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/work-board', label: 'Work Board' }} />
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <h1 className="text-2xl font-bold">Daily Production</h1>
          <input type="date" value={date} onChange={(e) => load(e.target.value)}
            className="ml-auto bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
            <p className="text-gray-500 text-xs uppercase tracking-widest">Completed {date === today ? '(today)' : ''}</p>
            <p className="text-4xl font-bold mt-1">{loading ? '…' : data.count}</p>
            <p className="text-gray-600 text-xs mt-1">{data.tz} · counts each Job once on its completion day</p>
          </div>
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5 md:col-span-2">
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">By technician</p>
            {data.byTech.length === 0 ? <p className="text-gray-600 text-sm">—</p> : (
              <div className="flex flex-wrap gap-2">
                {data.byTech.map((t) => (
                  <span key={t.name} className="text-sm bg-gray-800 border border-gray-700 rounded-lg px-3 py-1">{t.name} · <span className="font-bold">{t.count}</span></span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
          <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[11px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
            <div className="col-span-3">Customer</div><div className="col-span-3">Vehicle</div><div className="col-span-3">Services</div><div className="col-span-2">By</div><div className="col-span-1 text-right">Time</div>
          </div>
          {data.jobs.length === 0 ? (
            <p className="px-4 py-8 text-center text-gray-600 text-sm">No Jobs completed on {date}.</p>
          ) : data.jobs.map((j) => (
            <div key={j.orderNumber} className="grid grid-cols-12 gap-2 px-4 py-3 text-sm border-b border-gray-800/60 last:border-0">
              <div className="col-span-3 text-white truncate">{j.customer || 'Unknown'}</div>
              <div className="col-span-3 text-gray-300 truncate">{j.vehicle}</div>
              <div className="col-span-3 text-gray-400 truncate">{j.services.join(', ') || '—'}</div>
              <div className="col-span-2 text-gray-400 truncate">{j.completedBy || '—'}</div>
              <div className="col-span-1 text-right text-gray-500">{fmtTime(j.completedAt)}</div>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
