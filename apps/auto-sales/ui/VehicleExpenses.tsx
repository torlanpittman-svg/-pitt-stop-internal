'use client'
/**
 * Auto-Sales — dedicated ACTIVE EXPENSES list for a vehicle (vendor/description, business date, category,
 * amount, receipt link, and a running total). Separated from the History ledger so correcting a mistaken
 * purchase is unambiguous: acquisition, sales, returns and other lifecycle events stay in History and are
 * NOT shown here. Managers/admins get a "Remove from this vehicle" affordance on each expense —
 * swipe-left reveals it on touch devices, and an always-present accessible button serves desktop/keyboard
 * users. Swiping only REVEALS the action; a short confirmation naming the specific expense and vehicle is
 * required before anything is removed. Removal is a mistaken-attachment CORRECTION (append-only, keeps the
 * receipt, nets the expense out of cost/profit) — it is not a refund and never touches QuickBooks. All
 * authorization is enforced again server-side; this control is convenience + a fail-closed guard.
 */
import { useState } from 'react'
import { removeVehicleExpenseAction } from '@/apps/auto-sales/actions'

const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export type ExpenseRow = {
  id: string
  categoryLabel: string
  date: string
  vendor: string | null
  amountCents: number
  receiptUrl: string | null
  hasReceipt: boolean
  accountingLocked: boolean
  verified: boolean            // false = pending/unverified — attached, but not yet in verified "Added costs"
}

export default function VehicleExpenses({ inventoryVehicleId, vehicleLabel, canRemove, expenses, totalCents }: {
  inventoryVehicleId: string; vehicleLabel: string; canRemove: boolean; expenses: ExpenseRow[]; totalCents: number
}) {
  const [openId, setOpenId] = useState<string | null>(null)      // swipe-revealed row (touch)
  const [confirmId, setConfirmId] = useState<string | null>(null) // row awaiting confirmation
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; msg: string } | null>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null)
  const [startX, setStartX] = useState<number | null>(null)

  if (expenses.length === 0) {
    return (
      <div className="rounded-2xl bg-gray-900 border border-gray-800 p-4 mt-4">
        <p className="text-gray-400 text-sm font-semibold mb-1">Expenses</p>
        <p className="text-gray-600 text-xs">No expenses attached to this vehicle yet. Acquisition and other lifecycle events live in History.</p>
      </div>
    )
  }

  const pendingCents = expenses.filter((e) => !e.verified).reduce((t, e) => t + e.amountCents, 0)
  const verifiedCents = totalCents - pendingCents

  function ask(id: string) { setConfirmId(id); setOpenId(null); setError(null) }
  function cancel() { setConfirmId(null); setError(null) }

  async function remove(id: string) {
    setBusyId(id); setError(null)
    const r = await removeVehicleExpenseAction({ inventoryVehicleId, eventId: id })
    if (r.ok) { window.location.reload(); return }   // reloads with the expense netted out + History showing the removal
    setBusyId(null)
    setError({ id, msg: r.error ?? 'Could not remove this expense.' })
  }

  // Touch swipe — only REVEALS the Remove action (never removes). Left-drag past a threshold latches open.
  function onTouchStart(e: React.TouchEvent, id: string) { if (!canRemove) return; setStartX(e.touches[0].clientX); setDrag({ id, dx: openId === id ? -96 : 0 }) }
  function onTouchMove(e: React.TouchEvent, id: string) {
    if (!canRemove || startX == null) return
    const dx = Math.max(-96, Math.min(0, e.touches[0].clientX - startX + (openId === id ? -96 : 0)))
    setDrag({ id, dx })
  }
  function onTouchEnd(id: string) {
    if (!canRemove) return
    const dx = drag?.id === id ? drag.dx : 0
    setOpenId(dx <= -48 ? id : (openId === id ? null : openId))
    setDrag(null); setStartX(null)
  }

  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 p-4 mt-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-gray-400 text-sm font-semibold">Expenses</p>
        <p className="text-white text-sm font-semibold tabular-nums">{money(totalCents)}</p>
      </div>
      <ul className="space-y-1.5">
        {expenses.map((e) => {
          const revealed = openId === e.id
          const dx = drag?.id === e.id ? drag.dx : (revealed ? -96 : 0)
          const confirming = confirmId === e.id
          const busy = busyId === e.id
          return (
            <li key={e.id} className="relative overflow-hidden rounded-lg bg-gray-950/40">
              {/* Revealed (swipe) Remove — mirrors the accessible button; aria-hidden to avoid duplication. */}
              {canRemove && !e.accountingLocked && !confirming && (
                <button aria-hidden tabIndex={-1} onClick={() => ask(e.id)}
                  className="absolute inset-y-0 right-0 w-24 bg-red-700 text-white text-sm font-semibold flex items-center justify-center">Remove</button>
              )}
              <div
                className="relative bg-gray-900 flex items-center justify-between gap-2 px-3 py-2 transition-transform"
                style={{ transform: `translateX(${confirming ? 0 : dx}px)`, transitionDuration: drag ? '0ms' : '150ms' }}
                onTouchStart={(ev) => onTouchStart(ev, e.id)} onTouchMove={(ev) => onTouchMove(ev, e.id)} onTouchEnd={() => onTouchEnd(e.id)}
              >
                <div className="min-w-0">
                  <span className="text-gray-200 text-sm">{e.categoryLabel}</span>
                  {!e.verified && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full border bg-amber-950/40 text-amber-300 border-amber-900/60" title="Not yet verified — attached, but not counted in verified “Added costs”">pending</span>}
                  {e.hasReceipt && (e.receiptUrl
                    ? <a href={e.receiptUrl} target="_blank" rel="noopener" className="text-indigo-300 no-underline ml-1" title="View receipt">📎</a>
                    : <span className="ml-1" title="receipt on file">📎</span>)}
                  <span className="block text-gray-600 text-xs truncate">{e.date}{e.vendor ? ` · ${e.vendor}` : ''}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-gray-200 text-sm tabular-nums">{money(e.amountCents)}</span>
                  {canRemove && !e.accountingLocked && !confirming && (
                    <button onClick={() => ask(e.id)} aria-label={`Remove ${e.categoryLabel}${e.vendor ? ` from ${e.vendor}` : ''} (${money(e.amountCents)}) from ${vehicleLabel}`}
                      className="text-gray-500 hover:text-red-400 text-[11px] underline">Remove</button>
                  )}
                  {canRemove && e.accountingLocked && (
                    <span className="text-amber-400/80 text-[11px]" title="Linked to a reconciled bank/accounting record — ask the accountant to unlink it first.">🔒 linked</span>
                  )}
                </div>
              </div>
              {/* Confirmation — names the specific expense + vehicle before removing. */}
              {confirming && (
                <div className="border-t border-gray-800 bg-gray-900 px-3 py-2.5">
                  <p className="text-gray-300 text-xs">
                    Remove <span className="text-white font-semibold">{e.categoryLabel}{e.vendor ? ` · ${e.vendor}` : ''} · {money(e.amountCents)}</span> from <span className="text-white font-semibold">{vehicleLabel}</span>?
                  </p>
                  <p className="text-gray-500 text-[11px] mt-0.5">Corrects a mistaken attachment. The receipt is kept and it stays in History; this is not a refund and changes no accounting.</p>
                  {error?.id === e.id && <p className="text-red-400 text-xs mt-1">{error.msg}</p>}
                  <div className="flex gap-2 mt-2">
                    <button disabled={busy} onClick={cancel} className="flex-1 bg-gray-800 text-gray-200 py-2.5 rounded-xl text-sm disabled:opacity-50">Cancel</button>
                    <button disabled={busy} onClick={() => remove(e.id)} className="flex-1 bg-red-600 active:bg-red-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm">{busy ? 'Removing…' : 'Remove'}</button>
                  </div>
                </div>
              )}
              {/* Accounting-lock error shown outside confirm (e.g. server refused a locked expense). */}
              {!confirming && error?.id === e.id && <p className="text-red-400 text-xs px-3 pb-2">{error.msg}</p>}
            </li>
          )
        })}
      </ul>
      <div className="flex items-center justify-between border-t border-gray-800 mt-2 pt-2">
        <span className="text-gray-400 text-sm">Total attached{pendingCents > 0 ? ' (incl. pending)' : ''}</span>
        <span className="text-white text-sm font-semibold tabular-nums">{money(totalCents)}</span>
      </div>
      {pendingCents > 0 && (
        <p className="text-gray-500 text-[11px] mt-1">
          Includes {money(pendingCents)} not yet verified. Only the verified {money(verifiedCents)} feeds “Added costs” in the money summary above.
        </p>
      )}
      {canRemove && <p className="text-gray-600 text-[11px] mt-1.5">Attached by mistake? Swipe left (or use Remove) to correct it — the receipt is kept and it stays in History.</p>}
    </div>
  )
}
