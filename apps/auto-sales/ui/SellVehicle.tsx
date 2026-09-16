'use client'
/**
 * Auto-Sales — Sale workflow (MANAGER-facing). Two steps: (1) enter the sale details, (2) an explicit
 * confirmation summary that reconciles the whole transaction (selling price, taxes, fees, discounts,
 * total, received, balance, acquisition price, recon, total cost, ESTIMATED gross profit) before the
 * manager confirms. Every money figure comes from the ONE canonical calc service (integer cents) so the
 * screen agrees to the cent with the server + the monthly report. Taxes/fees are kept separate and are
 * excluded from gross profit. Also handles EDIT (correction) and REVERSE of an existing sale.
 */
import { useState } from 'react'
import { submitSaleAction, reverseSaleAction, type SaleForm } from '@/apps/auto-sales/actions'
import { PAYMENT_METHODS, computeSaleFinancials, computeEstimatedGrossProfit, dollarsToCents, type VehicleCostBasis } from '@/apps/auto-sales/calc'

const box = 'bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-white w-full'
const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export interface SellInitial {
  saleDate?: string; salePrice?: string; saleType?: string; buyerRef?: string; buyerContact?: string
  paymentMethod?: string; salePaymentRef?: string; tax?: string; docFees?: string; otherCharges?: string
  discount?: string; amountReceived?: string; commission?: string; payoff?: string; payoffStatus?: string
  proceedsReceived?: string; proceedsAccount?: string; tradeIn?: boolean; tradeInNotes?: string; markDelivered?: boolean; notes?: string
}

export default function SellVehicle({
  vehicleId, vehicleLabel, vin, stockNumber, basis, today, mode = 'record', initial, accounts,
}: {
  vehicleId: string; vehicleLabel: string; vin: string | null; stockNumber: string | null
  basis: VehicleCostBasis; today: string; mode?: 'record' | 'edit'; initial?: SellInitial
  accounts: readonly { ref: string; label: string }[]
}) {
  const [f, setF] = useState<SellInitial>({ saleDate: today, saleType: 'retail', payoffStatus: 'unknown', proceedsReceived: 'unknown', ...initial })
  const [step, setStep] = useState<'form' | 'confirm'>('form')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof SellInitial) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }))

  // Live canonical summary (client mirror of the server math).
  const salePriceCents = dollarsToCents(f.salePrice) ?? 0
  const fin = computeSaleFinancials({
    salePriceCents, taxCents: dollarsToCents(f.tax) ?? 0, docFeesCents: dollarsToCents(f.docFees) ?? 0,
    otherChargesCents: dollarsToCents(f.otherCharges) ?? 0, discountCents: dollarsToCents(f.discount) ?? 0,
    amountReceivedCents: dollarsToCents(f.amountReceived) ?? 0,
  })
  const commissionCents = dollarsToCents(f.commission) ?? 0
  const saleNetOfDiscount = fin.salePriceCents - fin.discountCents
  // Total cost basis uses the vehicle's tracked costs plus (for a live edit) the new acquisition price is
  // already baked into `basis` server-side; the sale price the manager types drives the profit line.
  const gross = computeEstimatedGrossProfit(saleNetOfDiscount, basis)

  const canReview = salePriceCents >= 0 && !!f.saleDate && (dollarsToCents(f.salePrice) != null)

  async function confirm() {
    setBusy(true); setErr(null)
    const payload: SaleForm = {
      inventoryVehicleId: vehicleId, saleDate: f.saleDate!, salePrice: f.salePrice ?? '0', saleType: f.saleType,
      buyerRef: f.buyerRef, buyerContact: f.buyerContact, paymentMethod: f.paymentMethod, salePaymentRef: f.salePaymentRef,
      tax: f.tax, docFees: f.docFees, otherCharges: f.otherCharges, discount: f.discount, amountReceived: f.amountReceived,
      commission: f.commission, payoff: f.payoff, payoffStatus: f.payoffStatus, proceedsReceived: f.proceedsReceived, proceedsAccount: f.proceedsAccount,
      tradeIn: f.tradeIn, tradeInNotes: f.tradeInNotes, markDelivered: f.markDelivered, notes: f.notes, mode,
    }
    const r = await submitSaleAction(payload)
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'Could not save the sale.'); return }
    window.location.reload()
  }

  const Row = ({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: 'pos' | 'neg' | 'muted' }) => (
    <div className={`flex justify-between ${strong ? 'border-t border-gray-700 pt-1.5 mt-1' : ''}`}>
      <span className={strong ? 'text-white font-semibold' : 'text-gray-400'}>{label}</span>
      <span className={`tabular-nums ${strong ? 'text-white font-bold' : accent === 'pos' ? 'text-emerald-300' : accent === 'neg' ? 'text-red-300' : 'text-white'}`}>{value}</span>
    </div>
  )

  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
      {step === 'form' ? (
        <details open={mode === 'edit'} className="overflow-hidden">
          <summary className="px-4 py-4 cursor-pointer list-none text-white font-bold text-lg flex items-center justify-between">
            {mode === 'edit' ? 'Edit Sale' : 'Sell this vehicle'} <span className="text-gray-500 text-sm">▾</span>
          </summary>
          <div className="px-4 pb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-500">Selling price<br /><input value={f.salePrice ?? ''} onChange={set('salePrice')} type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
              <label className="text-xs text-gray-500">Sale date<br /><input value={f.saleDate ?? ''} onChange={set('saleDate')} type="date" className={box} /></label>
              <label className="text-xs text-gray-500">Buyer name<br /><input value={f.buyerRef ?? ''} onChange={set('buyerRef')} className={box} /></label>
              <label className="text-xs text-gray-500">Buyer contact<br /><input value={f.buyerContact ?? ''} onChange={set('buyerContact')} placeholder="phone / email" className={box} /></label>
              <label className="text-xs text-gray-500">Payment method<br /><select value={f.paymentMethod ?? ''} onChange={set('paymentMethod')} className={box}><option value="">—</option>{PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
              <label className="text-xs text-gray-500">Payment ref / note<br /><input value={f.salePaymentRef ?? ''} onChange={set('salePaymentRef')} className={box} /></label>
            </div>

            <details className="rounded-xl border border-gray-800 bg-gray-900/60">
              <summary className="px-3 py-2 text-gray-400 text-sm cursor-pointer list-none">Taxes, fees &amp; money received ▾</summary>
              <div className="px-3 pb-3 grid grid-cols-2 gap-2">
                <label className="text-xs text-gray-500">Sales tax collected<br /><input value={f.tax ?? ''} onChange={set('tax')} type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
                <label className="text-xs text-gray-500">Title/doc fees<br /><input value={f.docFees ?? ''} onChange={set('docFees')} type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
                <label className="text-xs text-gray-500">Other charges<br /><input value={f.otherCharges ?? ''} onChange={set('otherCharges')} type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
                <label className="text-xs text-gray-500">Discount / allowance<br /><input value={f.discount ?? ''} onChange={set('discount')} type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
                <label className="text-xs text-gray-500">Amount received<br /><input value={f.amountReceived ?? ''} onChange={set('amountReceived')} type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
                <label className="text-xs text-gray-500">Money received?<br /><select value={f.proceedsReceived ?? 'unknown'} onChange={set('proceedsReceived')} className={box}><option value="unknown">unknown</option><option value="yes">yes</option><option value="no">no</option></select></label>
              </div>
            </details>

            <details className="rounded-xl border border-gray-800 bg-gray-900/60">
              <summary className="px-3 py-2 text-gray-400 text-sm cursor-pointer list-none">Trade-in, commission, payoff &amp; more ▾</summary>
              <div className="px-3 pb-3 grid grid-cols-2 gap-2">
                <label className="text-xs text-gray-500">Retail/wholesale<br /><select value={f.saleType ?? 'retail'} onChange={set('saleType')} className={box}><option value="retail">retail</option><option value="wholesale">wholesale</option></select></label>
                <label className="text-xs text-gray-500">Proceeds to<br /><select value={f.proceedsAccount ?? '*5600'} onChange={set('proceedsAccount')} className={box}>{accounts.map((a) => <option key={a.ref} value={a.ref}>{a.ref}</option>)}</select></label>
                <label className="text-xs text-gray-500">Commission<br /><input value={f.commission ?? ''} onChange={set('commission')} type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
                <label className="text-xs text-gray-500">Known payoff<br /><input value={f.payoff ?? ''} onChange={set('payoff')} type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
                <label className="text-xs text-gray-500">Payoff status<br /><select value={f.payoffStatus ?? 'unknown'} onChange={set('payoffStatus')} className={box}><option value="unknown">unknown</option><option value="open">open</option><option value="paid">paid</option><option value="none">none</option></select></label>
                <label className="text-xs text-gray-500 flex items-center gap-2 mt-4"><input checked={!!f.tradeIn} onChange={set('tradeIn')} type="checkbox" className="w-5 h-5" /> trade-in involved</label>
                {f.tradeIn && <label className="text-xs text-gray-500 col-span-2">Trade-in notes<br /><input value={f.tradeInNotes ?? ''} onChange={set('tradeInNotes')} className={box} /></label>}
                <label className="text-xs text-gray-500 flex items-center gap-2 mt-1"><input checked={!!f.markDelivered} onChange={set('markDelivered')} type="checkbox" className="w-5 h-5" /> delivered</label>
                <label className="text-xs text-gray-500 col-span-2">Sale notes<br /><input value={f.notes ?? ''} onChange={set('notes')} className={box} /></label>
              </div>
            </details>

            <button disabled={!canReview} onClick={() => { setErr(null); setStep('confirm') }} className="w-full bg-indigo-600 active:bg-indigo-700 disabled:opacity-40 text-white text-lg font-bold py-4 rounded-2xl">Review sale →</button>
          </div>
        </details>
      ) : (
        <div className="p-4 space-y-3">
          <p className="text-white font-bold text-lg">Confirm sale</p>
          <div className="text-sm text-gray-400">
            <p className="text-white font-semibold">{vehicleLabel}</p>
            <p>{[stockNumber, vin ? `VIN ${vin}` : null].filter(Boolean).join(' · ')}</p>
            <p>Buyer: <span className="text-gray-200">{f.buyerRef || '—'}</span> · {f.saleDate}</p>
          </div>
          <div className="rounded-xl bg-gray-950/50 border border-gray-800 p-3 space-y-1.5 text-[15px]">
            <Row label="Vehicle selling price" value={money(fin.salePriceCents)} />
            {fin.discountCents > 0 && <Row label="Discount / allowance" value={`−${money(fin.discountCents)}`} accent="pos" />}
            {fin.taxCents > 0 && <Row label="Sales tax (pass-through)" value={money(fin.taxCents)} accent="muted" />}
            {fin.docFeesCents > 0 && <Row label="Title / doc fees" value={money(fin.docFeesCents)} accent="muted" />}
            {fin.otherChargesCents > 0 && <Row label="Other charges" value={money(fin.otherChargesCents)} accent="muted" />}
            <Row label="Total customer transaction" value={money(fin.totalTransactionCents)} strong />
            <Row label="Amount received" value={money(fin.amountReceivedCents)} />
            {fin.balanceRemainingCents > 0 && <Row label="Balance remaining" value={money(fin.balanceRemainingCents)} accent="neg" />}
            {fin.overpaidCents > 0 && <Row label="Overpaid (review)" value={money(fin.overpaidCents)} accent="muted" />}
          </div>
          <div className="rounded-xl bg-gray-950/50 border border-gray-800 p-3 space-y-1.5 text-[15px]">
            <Row label="Acquisition price" value={money(basis.acquisitionPriceCents)} />
            {basis.acquisitionRelatedCents > 0 && <Row label="Acquisition-related costs" value={money(basis.acquisitionRelatedCents)} />}
            {basis.reconditioningCents > 0 && <Row label="Repairs / reconditioning" value={money(basis.reconditioningCents)} />}
            {basis.otherCostCents > 0 && <Row label="Other inventory cost" value={money(basis.otherCostCents)} />}
            {basis.returnsCreditsCents > 0 && <Row label="Returns / credits" value={`−${money(basis.returnsCreditsCents)}`} accent="pos" />}
            <Row label="Total vehicle cost" value={money(basis.totalInvestedCents)} strong />
            {commissionCents > 0 && <Row label="Selling commission (separate)" value={money(commissionCents)} accent="muted" />}
            <Row label="Estimated gross profit" value={money(gross)} strong accent={gross < 0 ? 'neg' : 'pos'} />
          </div>
          <p className="text-gray-600 text-[11px]">Management estimate — taxes &amp; customer fees are excluded from gross profit and shown separately. Nothing posts to QuickBooks.{basis.hasUnverified ? ` ⚠ ${money(basis.unverifiedCents)} of costs are unverified and not counted.` : ''}</p>
          {err && <p className="text-red-400 text-sm">{err}</p>}
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => setStep('form')} className="flex-1 bg-gray-800 active:bg-gray-700 text-gray-200 font-semibold py-4 rounded-2xl">← Back</button>
            <button disabled={busy} onClick={confirm} className="flex-[2] bg-emerald-600 active:bg-emerald-700 disabled:opacity-50 text-white text-lg font-bold py-4 rounded-2xl">{busy ? 'Saving…' : mode === 'edit' ? 'Confirm changes' : 'Confirm & mark Sold'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Manager-only reverse control — explicit warning + reason before restoring the vehicle to inventory. */
export function ReverseSale({ vehicleId }: { vehicleId: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  async function go() {
    setBusy(true); setErr(null)
    const r = await reverseSaleAction({ inventoryVehicleId: vehicleId, reason: reason || undefined })
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'Could not reverse the sale.'); return }
    window.location.reload()
  }
  if (!open) return <button onClick={() => setOpen(true)} className="text-red-400/80 text-xs underline">Reverse this sale</button>
  return (
    <div className="rounded-xl border border-red-900/50 bg-red-950/15 p-3 mt-2">
      <p className="text-red-300 text-sm font-semibold">Reverse this sale?</p>
      <p className="text-gray-400 text-xs mt-1">The vehicle returns to active inventory and can be re-sold. History is kept — the sale entries are reversed, never deleted. This is audited.</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (recommended)" className={`${box} mt-2`} />
      {err && <p className="text-red-400 text-xs mt-1">{err}</p>}
      <div className="flex gap-2 mt-2">
        <button disabled={busy} onClick={() => setOpen(false)} className="flex-1 bg-gray-800 text-gray-200 py-3 rounded-xl text-sm">Cancel</button>
        <button disabled={busy} onClick={go} className="flex-1 bg-red-700 active:bg-red-800 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm">{busy ? 'Reversing…' : 'Reverse sale'}</button>
      </div>
    </div>
  )
}
