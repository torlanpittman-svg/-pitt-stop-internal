'use client'

/**
 * Dealer invoice status + safe retry for an existing Work Board job (manager/admin).
 * Reads GET /api/dealer-checkin/attach (none|pending|queued|linked|failed) and, when
 * not yet linked, offers a one-tap Attach/Retry that POSTs to the same route. The
 * server path is idempotent and partial-failure safe — retrying NEVER double-charges
 * (it recovers an already-written #STOCK line). Never emails the invoice.
 */
import { useState, useEffect, useCallback } from 'react'

type Status = 'none' | 'pending' | 'queued' | 'linked' | 'failed'

const VIEW: Record<Status, { label: string; cls: string }> = {
  linked:  { label: 'Invoiced',     cls: 'text-green-300 border-green-700 bg-green-900/30' },
  pending: { label: 'Not invoiced', cls: 'text-amber-300 border-amber-700 bg-amber-900/20' },
  none:    { label: 'Not invoiced', cls: 'text-amber-300 border-amber-700 bg-amber-900/20' },
  queued:  { label: 'Queued',       cls: 'text-amber-300 border-amber-700 bg-amber-900/20' },
  failed:  { label: 'Failed',       cls: 'text-red-300 border-red-700 bg-red-900/20' },
}

export default function DealerInvoicePanel({ orderId }: { orderId: string }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/dealer-checkin/attach?orderId=${orderId}`)
      if (!res.ok) return
      const d = await res.json()
      setStatus(d.status as Status)
      setInvoiceNumber(d.invoiceNumber ?? null)
    } catch { /* leave prior state */ }
  }, [orderId])

  useEffect(() => { void refresh() }, [refresh])

  const run = useCallback(async () => {
    if (busy) return
    setBusy(true); setErr(null); setMsg(null)
    try {
      const res = await fetch('/api/dealer-checkin/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-QB-Write-Approved': 'true' },
        body: JSON.stringify({ serviceOrderId: orderId }),
      })
      const d = await res.json()
      if (d.ok) {
        const verb = d.action === 'appended' ? 'added to' : d.action === 'created' ? 'created on' : d.action === 'recovered' ? 'recovered on' : 'linked to'
        setMsg(`Invoice ${d.invoiceNumber ? `#${d.invoiceNumber}` : ''} ${verb} QuickBooks.`)
      } else {
        setErr(d.error || `Could not invoice (${d.outcome}).`)
      }
    } catch {
      setErr('QuickBooks unreachable — the job is safe. Tap Retry.')
    } finally {
      setBusy(false)
      void refresh()
    }
  }, [busy, orderId, refresh])

  if (status === null) return null
  const v = VIEW[status]
  const canWrite = status !== 'linked'
  const retry = status === 'failed' || status === 'queued'

  return (
    <div className="px-6 mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Dealer invoice</h2>
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md border ${v.cls}`}>
          {v.label}{status === 'linked' && invoiceNumber ? ` · #${invoiceNumber}` : ''}
        </span>
      </div>

      {canWrite && (
        <button onClick={run} disabled={busy}
          className="w-full h-12 rounded-2xl bg-white text-black text-base font-bold active:bg-gray-200 disabled:opacity-40">
          {busy ? 'Working…' : retry ? 'Retry invoice' : 'Attach invoice to QuickBooks'}
        </button>
      )}

      {msg && <p className="mt-2 text-green-300 text-sm">{msg}</p>}
      {err && <p className="mt-2 text-red-400 text-sm">{err}</p>}
    </div>
  )
}
