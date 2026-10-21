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
        <button type="button" onClick={() => setConfirming(true)} className="min-h-12 w-full rounded-[30px] border-[1.5px] border-[var(--ps-error)] bg-white font-medium text-[var(--ps-error)] hover:bg-[#fdf1f0]">Cancel appointment</button>
      ) : (
        <div className="rounded-xl border border-[#f1c2bf] bg-[#fdf1f0] p-4">
          <p className="text-[0.95rem] text-[var(--ps-ink)]">Cancel this appointment? This frees the time for someone else.</p>
          <div className="mt-3 flex gap-3">
            <button type="button" onClick={cancel} disabled={busy} className="min-h-11 flex-1 rounded-[30px] bg-[var(--ps-error)] font-semibold text-white disabled:opacity-60">{busy ? 'Cancelling…' : 'Yes, cancel'}</button>
            <button type="button" onClick={() => setConfirming(false)} className="ps-btn-secondary flex-1 !min-h-11">Keep it</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm font-medium text-[var(--ps-error)]">{error}</p>}
    </div>
  )
}
