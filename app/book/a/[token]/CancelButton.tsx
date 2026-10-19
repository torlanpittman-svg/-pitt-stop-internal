'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function CancelButton({ token }: { token: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function cancel() {
    setBusy(true); setError(null)
    try {
      const r = await fetch(`/api/book/a/${token}/cancel`, { method: 'POST' })
      const d = await r.json().catch(() => ({}))
      if (!d.ok) { setError(d.error || 'Could not cancel. Please call the shop.'); return }
      router.refresh()
    } catch { setError('Could not reach the shop. Please try again or call.') }
    finally { setBusy(false) }
  }

  return (
    <div className="mt-6">
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className="min-h-12 w-full rounded-xl border border-red-900/70 text-red-300 hover:border-red-700">Cancel appointment</button>
      ) : (
        <div className="rounded-xl border border-red-900/70 bg-red-950/30 p-4">
          <p className="text-sm text-red-100">Cancel this appointment? This frees the time for someone else.</p>
          <div className="mt-3 flex gap-3">
            <button type="button" onClick={cancel} disabled={busy} className="min-h-11 flex-1 rounded-lg bg-red-500 font-semibold text-white disabled:opacity-60">{busy ? 'Cancelling…' : 'Yes, cancel'}</button>
            <button type="button" onClick={() => setConfirming(false)} className="min-h-11 flex-1 rounded-lg border border-gray-700 text-gray-200">Keep it</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-amber-300">{error}</p>}
    </div>
  )
}
