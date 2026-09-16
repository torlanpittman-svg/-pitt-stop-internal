'use client'
/**
 * Auto-Sales — Purchase Price (acquisition price) view + MANAGER edit. Shows the amount Pitt Stop paid
 * to acquire the vehicle. A manager can correct it inline with an optional reason; the edit is append-
 * only + audited server-side (the prior value is never silently replaced) and immediately updates the
 * vehicle's tracked cost + gross-profit projections. Non-managers see the amount read-only (no Edit).
 */
import { useState } from 'react'
import { editAcquisitionPriceAction } from '@/apps/auto-sales/actions'

const box = 'bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-white w-full'
const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function AcquisitionPrice({ vehicleId, currentCents, canEdit }: { vehicleId: string; currentCents: number; canEdit: boolean }) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState((currentCents / 100).toFixed(2))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true); setErr(null)
    const r = await editAcquisitionPriceAction({ inventoryVehicleId: vehicleId, amount, reason: reason || undefined })
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'Could not update the price.'); return }
    window.location.reload()
  }

  return (
    <div>
      <div className="flex justify-between items-center">
        <span className="text-gray-400">Purchase price</span>
        <span className="flex items-center gap-2">
          <span className="text-white tabular-nums">{money(currentCents)}</span>
          {canEdit && !open && <button onClick={() => setOpen(true)} className="text-indigo-300 text-xs underline">Edit</button>}
        </span>
      </div>
      {canEdit && open && (
        <div className="rounded-xl border border-indigo-900/50 bg-indigo-950/10 p-3 mt-2">
          <p className="text-gray-300 text-xs">Correct the amount paid to acquire this vehicle. This does not change repairs, taxes, title, auction or transport costs. The previous value is kept for accounting review.</p>
          <label className="text-xs text-gray-500 block mt-2">Amount paid<br /><input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
          <label className="text-xs text-gray-500 block mt-2">Reason / note (optional)<br /><input value={reason} onChange={(e) => setReason(e.target.value)} className={box} placeholder="e.g. corrected from bill of sale" /></label>
          {err && <p className="text-red-400 text-xs mt-1">{err}</p>}
          <div className="flex gap-2 mt-2">
            <button disabled={busy} onClick={() => { setOpen(false); setAmount((currentCents / 100).toFixed(2)); setErr(null) }} className="flex-1 bg-gray-800 text-gray-200 py-3 rounded-xl text-sm">Cancel</button>
            <button disabled={busy} onClick={save} className="flex-1 bg-indigo-600 active:bg-indigo-700 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm">{busy ? 'Saving…' : 'Save price'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
