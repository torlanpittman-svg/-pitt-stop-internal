'use client'
/**
 * Controlled per-check actions on the detail screen. All reuse the same guarded endpoints as the write
 * flow, so their invariants hold here too:
 *   • Print / confirm / reprint → CheckPrintPanel (one open print job per check; a manager confirms the
 *                paper came out; a reprint is deliberate). NEVER writes QuickBooks again.
 *   • Retry QB → POST /retry-qb — locked + adoption-safe; offered whenever the check is not recorded yet.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import CheckPrintPanel from '../CheckPrintPanel'

export default function CheckDetailActions(props: {
  checkId: string; checkNumber: number; qbStatus: string; printStatus: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      {props.qbStatus === 'recorded' && <CheckPrintPanel checkId={props.checkId} checkNumber={props.checkNumber} printStatus={props.printStatus} />}
      {props.qbStatus !== 'recorded' && props.qbStatus !== 'voided' && (
        <button disabled={busy} onClick={retryQb} className="w-full rounded-xl bg-amber-600 py-3 font-semibold text-white disabled:opacity-50">
          {busy ? 'Retrying…' : 'Retry QuickBooks'}
        </button>
      )}
      {status && <p className="text-center text-sm text-neutral-600">{status}</p>}
      {error && <p className="rounded-lg bg-red-50 p-2 text-center text-sm text-red-700">{error}</p>}
    </div>
  )
}
