'use client'

import Link from 'next/link'
import { useState, useCallback } from 'react'
import type { OrderWithContext } from '@/apps/workflow/db'
import { isDealerOrder } from '@/apps/workflow/fees'
import CustomerContactModal from '@/app/components/CustomerContactModal'
import SwipeRow from '@/app/components/SwipeRow'

// Employee-facing card status: is the Job still active, or finished? The detailed
// lifecycle (in_progress/paused/drying/qc_ready) stays in the data model + manager
// views — employees just see Active vs Ready.
function simpleStatus(status: string): { label: string; bg: string; text: string } {
  if (status === 'ready')     return { label: 'Ready',     bg: 'bg-green-900/40', text: 'text-green-400' }
  if (status === 'delivered') return { label: 'Delivered', bg: 'bg-gray-800',     text: 'text-gray-400'  }
  if (status === 'cancelled') return { label: 'Cancelled', bg: 'bg-red-900/40',   text: 'text-red-400'   }
  return { label: 'Active', bg: 'bg-blue-900/40', text: 'text-blue-400' }
}

export default function VehicleCard({
  order,
  highlighted = false,
  removable = false,
  onRemoved,
}: {
  order: OrderWithContext
  highlighted?: boolean
  /** Manager/admin on the Active tab → allow swipe-to-remove. */
  removable?: boolean
  onRemoved?: (orderId: string) => void
}) {
  const { vehicle } = order
  const style = simpleStatus(order.status)
  const [contactOpen, setContactOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [qbInvoice, setQbInvoice] = useState<string | null>(null)  // linked QB invoice # (warning)

  const vehicleName = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unknown Vehicle'
  // Card title = retail customer or dealer name; vehicle info goes underneath.
  const title = order.customerName?.trim() || 'Unknown Customer'
  const isDealer = isDealerOrder(order)
  // Swipe-to-remove is RETAIL + manager/admin only (dealer cards never get the gesture).
  const canRemove = removable && !isDealer

  // Open the confirmation; look up any linked QB invoice so we can warn it stays intact.
  const openConfirm = useCallback(async () => {
    setErr(null); setQbInvoice(null); setConfirmOpen(true)
    try {
      const r = await fetch(`/api/workflow/orders/${order.id}/invoice`, { cache: 'no-store' })
      const d = await r.json().catch(() => null)
      if (d?.draft?.qb?.linked) setQbInvoice(d.draft.qb.invoiceNumber ?? '')
    } catch { /* warning is best-effort; removal still works */ }
  }, [order.id])

  const doRemove = useCallback(async () => {
    if (removing) return
    setRemoving(true); setErr(null)
    try {
      const r = await fetch(`/api/workflow/orders/${order.id}/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) { setErr(d.error ?? 'Could not remove this Job.'); return }
      setConfirmOpen(false)
      onRemoved?.(order.id)   // parent drops it from the board immediately
    } catch { setErr('Network error — please try again.') }
    finally { setRemoving(false) }
  }, [order.id, removing, onRemoved])

  const card = (
    <Link
      href={`/orders/${order.id}`}
      className={`block bg-gray-900 rounded-2xl px-5 py-4 active:bg-gray-800 transition-all border ${
        highlighted
          ? 'border-green-500 shadow-lg shadow-green-900/30'
          : 'border-gray-800'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Retail customer name → tap opens the contact popup (doesn't navigate). Dealer name is plain. */}
          {isDealer ? (
            <p className="text-white font-bold text-lg leading-tight truncate">{title}</p>
          ) : (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setContactOpen(true) }}
              className="text-white font-bold text-lg leading-tight truncate text-left underline decoration-dotted decoration-gray-600 underline-offset-4 active:opacity-70 max-w-full">
              {title}
            </button>
          )}
          <p className="text-gray-500 text-sm mt-0.5 truncate">
            {vehicleName}
          </p>
        </div>
        <span className={`flex-none text-xs font-semibold px-2.5 py-1 rounded-full ${style.bg} ${style.text}`}>
          {style.label}
        </span>
      </div>

      {/* Selected services (Quick Entry). Compact chips; wraps on phone. No prices. */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {order.services && order.services.length > 0 ? (
          order.services.map((s, i) => (
            <span key={i} className="max-w-full truncate text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-md">
              {s}
            </span>
          ))
        ) : (
          <span className="text-xs text-gray-600 italic">No services listed.</span>
        )}
      </div>
    </Link>
  )

  return (
    <>
      {/* Manager/admin on a retail Active Job → swipe-left reveals Remove (tap + confirm required;
          a swipe alone never removes). Everyone else / dealer cards keep the plain card. */}
      {canRemove
        ? <SwipeRow onRemove={openConfirm} busy={removing}>{card}</SwipeRow>
        : card}

      {contactOpen && <CustomerContactModal orderId={order.id} customerName={title} onClose={() => setContactOpen(false)} />}

      {/* Confirmation — required before anything is removed. Warns if a QB invoice is linked. */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[70] flex flex-col justify-end bg-black/70" onClick={() => !removing && setConfirmOpen(false)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-bold text-lg mb-2">Remove this Job from the Work Board?</h3>
            <p className="text-white text-base font-semibold">{title}</p>
            <p className="text-gray-400 text-sm mb-3">{vehicleName}</p>
            {qbInvoice !== null && (
              <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-3 mb-3">
                <p className="text-amber-300 text-sm">
                  This Job has QuickBooks Invoice{qbInvoice ? ` #${qbInvoice}` : ''}. Removing the Job from the Work Board will <b>not</b> remove or void the QuickBooks invoice.
                </p>
              </div>
            )}
            <p className="text-gray-500 text-xs mb-4">The Job is cancelled (not deleted) — the customer, vehicle, and history are kept.</p>
            {err && <p className="text-red-400 text-sm mb-3">{err}</p>}
            <div className="flex gap-3">
              <button onClick={() => setConfirmOpen(false)} disabled={removing} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
              <button onClick={doRemove} disabled={removing} className="flex-1 py-3.5 rounded-2xl bg-red-600 text-white font-bold active:bg-red-700 disabled:opacity-50">{removing ? 'Removing…' : 'Remove'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
