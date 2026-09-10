'use client'
/**
 * Controlled per-check actions on the detail screen. All reuse the same guarded endpoints as the write
 * flow, so their invariants hold here too:
 *   • Reprint  → POST /queue-print { reprint:true } — re-queues the SAME check/number/QBO txn; NEVER
 *                writes QuickBooks again. Only offered once the check is recorded.
 *   • Retry QB → POST /retry-qb — adoption-safe; only offered when the QB write previously failed.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function CheckDetailActions(props: {
  checkId: string; checkNumber: number; qbStatus: string; printStatus: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reprint() {
    setBusy(true); setError(null); setStatus('queuing…')
    try {
      const res = await fetch(`/api/checks/${props.checkId}/queue-print`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reprint: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Could not queue the reprint.')
      setStatus('queued — waiting for shop printer…')
      poll(data.jobId)
    } catch (e) { setError(String((e as Error).message)); setStatus(null) } finally { setBusy(false) }
  }

  function poll(jobId: string, tries = 0) {
    if (tries > 40) { setStatus('still queued — check the shop printer/bridge.'); return }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/checks/${props.checkId}/jobs`)
        const data = await res.json()
        const job = (data.jobs || []).find((j: { id: string }) => j.id === jobId)
        if (job?.status === 'printed') { setStatus('printed ✓'); router.refresh(); return }
        if (job?.status === 'failed') { setStatus(`print failed: ${job.error || 'unknown'} — you can resend.`); return }
        setStatus(job?.status === 'claimed' ? 'printing…' : 'queued…')
        poll(jobId, tries + 1)
      } catch { poll(jobId, tries + 1) }
    }, 2000)
  }

  async function retryQb() {
    setBusy(true); setError(null); setStatus('retrying QuickBooks…')
    try {
      const res = await fetch(`/api/checks/${props.checkId}/retry-qb`, { method: 'POST' })
      const data = await res.json()
      if (data.recorded) { setStatus('recorded ✓'); router.refresh() }
      else { setError(data.error || data.message || 'Still failing.'); setStatus(null) }
    } catch (e) { setError(String((e as Error).message)); setStatus(null) } finally { setBusy(false) }
  }

  return (
    <div className="mt-4 space-y-2">
      {props.qbStatus === 'recorded' && (
        <button disabled={busy} onClick={reprint} className="w-full rounded-xl bg-neutral-900 py-3 font-semibold text-white disabled:opacity-50">
          {busy ? 'Working…' : props.printStatus === 'printed' ? `Reprint Check #${props.checkNumber}` : `Send Check #${props.checkNumber} to Shop Printer`}
        </button>
      )}
      {props.qbStatus === 'failed' && (
        <button disabled={busy} onClick={retryQb} className="w-full rounded-xl bg-amber-600 py-3 font-semibold text-white disabled:opacity-50">
          {busy ? 'Retrying…' : 'Retry QuickBooks'}
        </button>
      )}
      {status && <p className="text-center text-sm text-neutral-600">{status}</p>}
      {error && <p className="rounded-lg bg-red-50 p-2 text-center text-sm text-red-700">{error}</p>}
    </div>
  )
}
