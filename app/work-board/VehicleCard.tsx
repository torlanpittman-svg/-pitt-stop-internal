'use client'

import Link from 'next/link'
import { useState, useCallback } from 'react'
import type { OrderWithContext } from '@/apps/workflow/db'
import type { RemovalPreview } from '@/apps/workflow/order-removal'
import { isDealerOrder, orderSourceKind } from '@/apps/workflow/fees'
import CustomerContactModal from '@/app/components/CustomerContactModal'
import SwipeRow from '@/app/components/SwipeRow'

/** Dealer stock number, read from the Job notes ("Stock: X | Invoice: … | Dealer"). Display-only. */
function stockFromNotes(notes: string | null | undefined): string | null {
  const m = (notes ?? '').match(/Stock:\s*([^|]+?)\s*(?:\||$)/i)
  const s = m?.[1]?.trim()
  return s && s.toLowerCase() !== 'n/a' ? s : null
}

/** Remove-button label — spells out the QB effect when there is one. */
function removeButtonLabel(preview: RemovalPreview | null): string {
  if (preview?.kind === 'line_remove' || preview?.kind === 'void_standalone') return 'Remove Vehicle'
  return 'Remove'
}

/** The QuickBooks consequence copy shown in the confirm sheet, driven by the live preview. */
function renderQbConsequence(preview: RemovalPreview) {
  const inv = preview.invoiceNumber ? `#${preview.invoiceNumber}` : ''
  if (preview.kind === 'blocked_paid') {
    return (
      <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 mb-4">
        <p className="text-red-300 text-sm">This invoice {inv} has payment activity and cannot be automatically removed. Review the invoice in QuickBooks.</p>
      </div>
    )
  }
  if (preview.kind === 'ambiguous') {
    return (
      <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 mb-4">
        <p className="text-red-300 text-sm">This vehicle couldn’t be safely matched to an exact QuickBooks invoice line, so QuickBooks will not be changed. Review the invoice in QuickBooks.</p>
      </div>
    )
  }
  if (preview.kind === 'qb_unreachable') {
    return (
      <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-3 mb-4">
        <p className="text-amber-300 text-sm">Couldn’t reach QuickBooks to check the invoice. You can try again — nothing is changed unless the invoice can be verified.</p>
      </div>
    )
  }
  if (preview.kind === 'line_remove') {
    return (
      <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-3 mb-4">
        <p className="text-amber-200 text-sm mb-1">It is currently on QuickBooks Invoice {inv}. Removing it will:</p>
        <ul className="text-amber-200/90 text-sm list-disc pl-5 space-y-0.5">
          <li>remove this vehicle from the Work Board</li>
          <li>remove this vehicle’s line from Invoice {inv}</li>
        </ul>
        <p className="text-amber-200/70 text-xs mt-1.5">Other vehicles on the invoice will not be changed.</p>
      </div>
    )
  }
  if (preview.kind === 'void_standalone') {
    return (
      <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-3 mb-4">
        <p className="text-amber-200 text-sm mb-1">It has its own QuickBooks Invoice {inv}. Removing it will:</p>
        <ul className="text-amber-200/90 text-sm list-disc pl-5 space-y-0.5">
          <li>remove this vehicle from the Work Board</li>
          <li>void the standalone QuickBooks invoice {inv}</li>
        </ul>
        <p className="text-amber-200/70 text-xs mt-1.5">This cannot be undone from the Work Board.</p>
      </div>
    )
  }
  if (preview.kind === 'idempotent_qb_done') {
    return <p className="text-gray-500 text-xs mb-4">The QuickBooks invoice was already corrected. This just clears the vehicle from the Work Board.</p>
  }
  // no_qb / already_removed
  return <p className="text-gray-500 text-xs mb-4">This vehicle has not been added to QuickBooks. It is removed from the Work Board only (cancelled, not deleted) — history is kept.</p>
}

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
  // What removal will do to QuickBooks — fetched live from the preview endpoint when the sheet opens.
  const [preview, setPreview] = useState<RemovalPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Year Make Model, plus the existing authoritative color (helps tell apart same-YMM
  // vehicles at the shop). Color is appended only when present — no empty separator, no
  // "Unknown". If YMM is entirely missing, fall back to "Unknown Vehicle" (never a lone color).
  const ymm = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')
  const color = (vehicle.color ?? '').trim()
  const vehicleName = ymm ? (color ? `${ymm} · ${color}` : ymm) : 'Unknown Vehicle'
  // Card title = retail customer or dealer name; vehicle info goes underneath.
  const title = order.customerName?.trim() || 'Unknown Customer'
  const kind = orderSourceKind(order)               // 'retail' | 'dealer' | 'unknown' (canonical, positive-ID)
  const isDealer = kind === 'dealer'
  const isUrgent = order.isUrgent === true
  const stock = isDealer ? stockFromNotes(order.notes) : null
  // Swipe-to-remove is offered to manager/admin on any active card — RETAIL and DEALER alike
  // (an accidental check-in of either kind can be corrected). The confirm + tap are still required.
  const canRemove = removable

  // Open the confirmation and ask the server exactly what removal will do to QuickBooks (remove one
  // line from a multi-vehicle invoice, void a standalone invoice, nothing, or block on payment).
  const openConfirm = useCallback(async () => {
    setErr(null); setPreview(null); setPreviewLoading(true); setConfirmOpen(true)
    try {
      const r = await fetch(`/api/workflow/orders/${order.id}/remove`, { cache: 'no-store' })
      const d = await r.json().catch(() => null)
      if (r.ok && d?.ok && d.preview) setPreview(d.preview as RemovalPreview)
      else if (d?.error) setErr(d.error)
    } catch { /* preview is best-effort; the POST re-checks and fails closed if needed */ }
    finally { setPreviewLoading(false) }
  }, [order.id])

  const doRemove = useCallback(async () => {
    if (removing) return
    setRemoving(true); setErr(null)
    try {
      const r = await fetch(`/api/workflow/orders/${order.id}/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) { setErr(d.error ?? 'Could not remove this vehicle.'); return }
      setConfirmOpen(false)
      onRemoved?.(order.id)   // parent drops it from the board immediately
    } catch { setErr('Network error — please try again.') }
    finally { setRemoving(false) }
  }, [order.id, removing, onRemoved])

  // Visual hierarchy: URGENT has the STRONGEST priority (amber outline + rail, overrides the normal
  // retail/dealer accent — the badges below still keep the source visible). Otherwise RETAIL draws the
  // eye (emerald left-rail); DEALER/UNKNOWN stay neutral. The green `highlighted` ring (just-added) wins.
  const accent = highlighted
    ? 'border-green-500 shadow-lg shadow-green-900/30 border-l'
    : isUrgent
      ? 'border-2 border-amber-500 border-l-4 border-l-amber-500 bg-amber-950/15'
      : kind === 'retail'
        ? 'border-gray-800 border-l-4 border-l-emerald-500 bg-emerald-950/10'
        : 'border-gray-800 border-l'

  const card = (
    <Link
      href={`/orders/${order.id}`}
      className={`block bg-gray-900 rounded-2xl px-5 py-4 active:bg-gray-800 transition-all border ${accent}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Badges: URGENT (amber, strongest) + the source badge — urgent NEVER hides RETAIL/DEALER. */}
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            {isUrgent && (
              <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/50">URGENT</span>
            )}
            {kind === 'retail' && (
              <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">RETAIL</span>
            )}
            {kind === 'dealer' && (
              <span className="text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded-md bg-gray-800 text-gray-400 border border-gray-700">DEALER</span>
            )}
          </div>
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
          {stock && <p className="text-gray-600 text-xs mt-0.5 truncate">Stock {stock}</p>}
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
      {/* Manager/admin on any Active Job (retail OR dealer) → swipe-left reveals Remove (tap +
          confirm required; a swipe alone never removes). Everyone else keeps the plain card. */}
      {canRemove
        ? <SwipeRow onRemove={openConfirm} busy={removing}>{card}</SwipeRow>
        : card}

      {contactOpen && <CustomerContactModal orderId={order.id} customerName={title} onClose={() => setContactOpen(false)} />}

      {/* Confirmation — required before anything is removed. Shows the LIVE QuickBooks consequence
          (no link / remove one line / void standalone / blocked by payment / ambiguous). */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[70] flex flex-col justify-end bg-black/70" onClick={() => !removing && setConfirmOpen(false)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-bold text-lg mb-2">Remove this vehicle from the Work Board?</h3>
            <p className="text-white text-base font-semibold">{vehicleName}</p>
            <p className="text-gray-400 text-sm">{title}</p>
            {stock && <p className="text-gray-500 text-sm mb-3">Stock #{stock}</p>}
            {!stock && <div className="mb-3" />}

            {/* Live QuickBooks consequence — what this removal will actually do. */}
            {previewLoading && <p className="text-gray-500 text-sm mb-4">Checking QuickBooks…</p>}
            {!previewLoading && preview && renderQbConsequence(preview)}
            {!previewLoading && !preview && !err && (
              <p className="text-gray-500 text-xs mb-4">The vehicle is removed from the Work Board (cancelled, not deleted) — customer, vehicle, and history are kept.</p>
            )}

            {err && <p className="text-red-400 text-sm mb-3">{err}</p>}
            <div className="flex gap-3">
              <button onClick={() => setConfirmOpen(false)} disabled={removing} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">
                {preview?.blocked ? 'Close' : 'Cancel'}
              </button>
              {!preview?.blocked && (
                <button onClick={doRemove} disabled={removing || previewLoading} className="flex-1 py-3.5 rounded-2xl bg-red-600 text-white font-bold active:bg-red-700 disabled:opacity-50">
                  {removing ? 'Removing…' : removeButtonLabel(preview)}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
