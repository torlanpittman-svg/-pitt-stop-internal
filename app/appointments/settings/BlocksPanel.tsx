'use client'

import { useActionState, useTransition } from 'react'
import { addBlockAction, removeBlockAction } from '../actions'
import { formatDateLabel, formatTimeLabel } from '@/apps/appointments/policy'

interface BlockRow { id: string; kind: string; date: string; time: string | null; reason: string | null }

export default function BlocksPanel({ blocks, holidays }: { blocks: BlockRow[]; holidays: [string, string][] }) {
  const [state, action, pending] = useActionState(addBlockAction, null)
  const [removing, start] = useTransition()
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-semibold">Closures &amp; blocks</h2>
      <form action={action} className="grid grid-cols-2 gap-2 rounded-xl border border-gray-800 bg-gray-900 p-3">
        <select name="kind" className="h-11 rounded-lg border border-gray-700 bg-gray-950 px-2 text-white">
          <option value="close">Close / block</option>
          <option value="open">Re-open a holiday or closed day</option>
        </select>
        <input type="date" name="date" required className="h-11 rounded-lg border border-gray-700 bg-gray-950 px-2 text-white" />
        <input type="time" name="time" step={300} className="h-11 rounded-lg border border-gray-700 bg-gray-950 px-2 text-white" aria-label="Time (blank = whole day)" />
        <input name="reason" placeholder="Reason (optional)" className="h-11 rounded-lg border border-gray-700 bg-gray-950 px-3 text-white placeholder-gray-600" />
        <p className="col-span-2 text-xs text-gray-500">Leave the time blank to close the whole day. Re-open always applies to a whole day.</p>
        <button type="submit" disabled={pending} className="col-span-2 min-h-11 rounded-lg bg-gray-100 font-semibold text-gray-950 disabled:opacity-60">Add</button>
        {state && !state.ok && <p className="col-span-2 text-sm text-amber-300">{state.error}</p>}
      </form>
      <ul className="space-y-1 text-sm">
        {blocks.map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-800 px-3 py-2">
            <span>{b.kind === 'open' ? 'Re-opened' : 'Closed'} · {formatDateLabel(b.date)}{b.time ? ` ${formatTimeLabel(b.time)}` : ' (all day)'}{b.reason ? ` — ${b.reason}` : ''}</span>
            <button type="button" disabled={removing} onClick={() => start(async () => { await removeBlockAction(b.id) })} className="text-red-300">Remove</button>
          </li>
        ))}
        {!blocks.length && <li className="text-gray-500">No upcoming closures.</li>}
      </ul>
      {holidays.length > 0 && (
        <p className="text-xs text-gray-500">Automatic holiday closures: {holidays.map(([d, n]) => `${n} (${d})`).join(' · ')}</p>
      )}
    </section>
  )
}
