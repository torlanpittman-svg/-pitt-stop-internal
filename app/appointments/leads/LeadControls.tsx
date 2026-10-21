'use client'

import { useState, useTransition } from 'react'
import { setLeadStatusAction, requeueLeadFollowUpAction } from '../actions'

const LABEL: Record<string, string> = { new: 'New', contacted: 'Contacted', closed: 'Closed' }

export function LeadStatusButtons({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Follow-up status">
        {Object.entries(LABEL).map(([k, l]) => (
          <button key={k} type="button" disabled={pending || k === status} aria-pressed={k === status}
            onClick={() => start(async () => { const r = await setLeadStatusAction(id, k); setError(r.ok ? null : r.error) })}
            className={`min-h-9 rounded-lg border px-3 text-sm ${k === status ? 'border-emerald-600 bg-emerald-950/40 text-emerald-200' : 'border-gray-700 text-gray-300 hover:border-gray-500'} disabled:cursor-default`}>
            {l}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-amber-300">{error}</p>}
    </div>
  )
}

export function RequeueFollowUp({ id }: { id: string }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  return (
    <span>
      <button type="button" disabled={pending} onClick={() => start(async () => { const r = await requeueLeadFollowUpAction(id); setMsg(r.ok ? 'Queued for the next run.' : r.error) })}
        className="text-xs text-emerald-300 underline disabled:opacity-60">Queue again</button>
      {msg && <span className="ml-2 text-xs text-gray-400">{msg}</span>}
    </span>
  )
}
