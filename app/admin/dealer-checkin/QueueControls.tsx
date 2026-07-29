'use client'

import { useState, useCallback } from 'react'

export default function QueueControls({ initialQueued }: { initialQueued: number }) {
  const [queued, setQueued] = useState(initialQueued)
  const [draining, setDraining] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const refreshDepth = useCallback(async () => {
    const res = await fetch('/api/dealer-checkin/retry-queue')
    if (res.ok) { const d = await res.json(); setQueued(d.queueDepth) }
  }, [])

  const drain = useCallback(async () => {
    setDraining(true); setResult(null)
    try {
      const res = await fetch('/api/dealer-checkin/retry-queue', { method: 'POST' })
      const d = await res.json()
      if (d.ok) setResult(`Processed ${d.processed} · synced ${d.synced} · still queued ${d.stillQueued}`)
      else setResult(d.error ?? 'Drain failed')
      await refreshDepth()
    } catch (err) {
      setResult(String(err))
    } finally {
      setDraining(false)
    }
  }, [refreshDepth])

  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-white font-semibold">Invoice queue</p>
          <p className="text-gray-500 text-sm">{queued} check-in{queued === 1 ? '' : 's'} awaiting QuickBooks sync</p>
        </div>
        <button
          onClick={drain}
          disabled={draining || queued === 0}
          className="px-5 py-2.5 rounded-xl font-semibold text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-colors"
        >
          {draining ? 'Draining…' : 'Drain queue'}
        </button>
      </div>
      {result && <p className="text-gray-400 text-sm mt-3">{result}</p>}
    </div>
  )
}
