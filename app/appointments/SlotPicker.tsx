'use client'

import { useEffect, useState } from 'react'
import { staffAvailability } from './actions'
import { allTimes } from '@/apps/appointments/public'
import { formatTimeLabel, type DayView } from '@/apps/appointments/policy'

const REASON: Record<string, string> = { full: 'Full', blocked: 'Blocked', past: 'Past', lead_time: 'Too soon' }

export default function SlotPicker({ serviceKeys, value, onChange, allowOverride, excludeId = null }: {
  serviceKeys: string[]
  value: { date: string; time: string | null; override: boolean }
  onChange: (v: { date: string; time: string | null; override: boolean }) => void
  allowOverride: boolean
  excludeId?: string | null
}) {
  const keys = serviceKeys.join(',')
  const reqKey = `${value.date}|${keys}|${excludeId ?? ''}`
  const [result, setResult] = useState<{ key: string; day: DayView | null } | null>(null)
  const loading = !!value.date && result?.key !== reqKey
  const day = result?.key === reqKey ? result.day : null

  useEffect(() => {
    let live = true
    if (!value.date) return
    staffAvailability(value.date, keys ? keys.split(',') : [], excludeId).then((d) => { if (live) setResult({ key: reqKey, day: d }) })
      .catch(() => { if (live) setResult({ key: reqKey, day: null }) })
    return () => { live = false }
  }, [value.date, keys, excludeId, reqKey])

  return (
    <div className="mt-3 space-y-3">
      <label className="block">
        <span className="text-sm text-gray-300">Date</span>
        <input type="date" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value, time: null })}
          className="mt-1 h-11 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 text-white" />
      </label>
      {allowOverride && (
        <label className="flex items-start gap-2 text-sm text-amber-200">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={value.override} onChange={(e) => onChange({ ...value, override: e.target.checked, time: null })} />
          <span>Manager override — any time, ignores the online window, closures and capacity.</span>
        </label>
      )}
      {loading && <p className="text-sm text-gray-400">Checking availability…</p>}
      {!loading && day && !value.override && day.closed && <p className="text-sm text-amber-300">Closed: {day.closedReason}.{allowOverride ? ' Use manager override to book anyway.' : ''}</p>}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {value.override
          ? allTimes().map((t) => (
              <button key={t} type="button" onClick={() => onChange({ ...value, time: t })}
                className={`min-h-11 rounded-lg border text-sm ${value.time === t ? 'border-amber-400 bg-amber-400 text-gray-950' : 'border-gray-700 bg-gray-950'}`}>{formatTimeLabel(t)}</button>
            ))
          : day && !day.closed && day.slots.map((s) => (
              <button key={s.time} type="button" disabled={!s.available} onClick={() => onChange({ ...value, time: s.time })}
                className={`min-h-11 rounded-lg border text-sm ${value.time === s.time ? 'border-emerald-500 bg-emerald-500 text-gray-950' : s.available ? 'border-gray-700 bg-gray-950' : 'border-gray-900 text-gray-600'}`}>
                {formatTimeLabel(s.time)}{!s.available && <span className="block text-[10px]">{REASON[s.reason ?? ''] ?? ''}</span>}
              </button>
            ))}
      </div>
    </div>
  )
}
