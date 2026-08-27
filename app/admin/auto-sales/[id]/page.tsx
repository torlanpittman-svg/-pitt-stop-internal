/**
 * Auto-Sales B0 — Vehicle Financial Folder. One folder per canonical vehicle: identity + factual
 * summary (never a definitive "total cost basis" when incomplete) + append-only event ledger + manual
 * Add Expense + append-only reversal. Admin-gated. No money movement.
 */
import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getVehicleFolder, addExpenseEvent, reverseEvent } from '@/apps/auto-sales/db'
import { ECONOMIC_CATEGORIES, IN_SCOPE_ACCOUNTS, labelFor, type EconomicCategory } from '@/apps/auto-sales/types'
import { autoSalesCutoverDate } from '@/apps/settings/db'

export const dynamic = 'force-dynamic'
const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const COMPLETENESS: Record<string, { c: string; label: string }> = {
  complete: { c: 'text-emerald-300', label: 'Complete' },
  partially_reconstructed: { c: 'text-amber-300', label: 'Partially reconstructed' },
  historical_incomplete: { c: 'text-amber-300', label: 'Historical costs incomplete' },
  needs_review: { c: 'text-red-300', label: 'Needs review' },
}
// Categories offered for manual expense entry (costs only; sale/closeout is B1).
const EXPENSE_CATS: EconomicCategory[] = ['part', 'recon_labor', 'mechanic', 'bodywork', 'pdr', 'paint', 'transport', 'title_tax', 'registration', 'auction_fee', 'buyer_fee', 'floorplan_interest', 'floorplan_fee', 'other']

async function addExpense(fd: FormData) {
  'use server'
  const id = String(fd.get('inventoryVehicleId') ?? '')
  const amt = Math.round(parseFloat(String(fd.get('amount') ?? '')) * 100)
  const eventDate = String(fd.get('eventDate') ?? '')
  const cat = String(fd.get('category') ?? '') as EconomicCategory
  if (id && ECONOMIC_CATEGORIES.includes(cat) && Number.isFinite(amt) && amt > 0 && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    await addExpenseEvent({ inventoryVehicleId: id, economicCategory: cat, amountCents: amt, eventDate,
      vendor: String(fd.get('vendor') ?? '') || undefined, memo: String(fd.get('memo') ?? '') || undefined,
      paymentAccountRef: String(fd.get('account') ?? 'unknown'), actor: 'admin' })
  }
  revalidatePath(`/admin/auto-sales/${id}`)
}
async function reverse(fd: FormData) {
  'use server'
  const id = String(fd.get('inventoryVehicleId') ?? ''); const eventId = String(fd.get('eventId') ?? '')
  if (eventId) await reverseEvent(eventId, 'admin')
  revalidatePath(`/admin/auto-sales/${id}`)
}

const input = 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white w-full'
const card = 'rounded-2xl bg-gray-900 border border-gray-800 p-5'

export default async function VehicleFolderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [folder, cutover] = await Promise.all([getVehicleFolder(id), autoSalesCutoverDate()])
  if (!folder) notFound()
  const { inv, vehicle, events, summary, daysOnLot } = folder
  const cm = COMPLETENESS[inv.financialCompleteness] ?? COMPLETENESS.needs_review
  const reversedTargets = new Set(events.filter((e) => e.reversesEventId).map((e) => e.reversesEventId))

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-8 py-8 max-w-5xl mx-auto">
      <Link href="/admin/auto-sales" className="text-gray-500 text-xs">← Inventory</Link>
      <h1 className="text-2xl font-bold text-white mt-1">{inv.stockNumber ?? '(no stock — needs VIN)'} <span className="text-gray-500 font-normal text-lg">· {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unidentified vehicle'}</span></h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        {/* Vehicle identity */}
        <div className={card}>
          <p className="text-gray-500 text-[11px] uppercase tracking-widest mb-2">Vehicle</p>
          <dl className="text-sm space-y-1">
            <div className="flex justify-between"><dt className="text-gray-500">VIN</dt><dd className="text-gray-200 tabular-nums">{vehicle.vin ?? '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Stock #</dt><dd className="text-gray-200">{inv.stockNumber ?? '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Y/M/M · color</dt><dd className="text-gray-200">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—'} · {vehicle.color ?? '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Acquired</dt><dd className="text-gray-200">{inv.acquiredAt ?? '—'} · {daysOnLot ?? '—'} days on lot</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Status</dt><dd className="text-gray-200 capitalize">{inv.status.replace('_', ' ')}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Tracking</dt><dd className="text-gray-200">{inv.preCutover ? `historical (pre-cutover ${cutover})` : `go-forward from ${inv.trackingStartDate}`}</dd></div>
          </dl>
        </div>

        {/* Factual financial summary — NOT a definitive total when incomplete */}
        <div className={card}>
          <p className="text-gray-500 text-[11px] uppercase tracking-widest mb-2">Financial summary</p>
          <dl className="text-sm space-y-1">
            <div className="flex justify-between"><dt className="text-gray-400">Acquisition cost</dt><dd className="text-white tabular-nums">{money(summary.acquisitionCostCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-400">Verified additional costs</dt><dd className="text-white tabular-nums">{money(summary.verifiedAdditionalCents)}</dd></div>
            <div className="flex justify-between border-t border-gray-700 pt-1 mt-1"><dt className="text-gray-100 font-semibold">Current known investment</dt><dd className="text-white font-bold tabular-nums">{money(summary.knownInvestmentCents)}</dd></div>
            {summary.unverifiedAdditionalCents !== 0 && <div className="flex justify-between"><dt className="text-gray-500 text-xs">Unverified (not counted)</dt><dd className="text-amber-400/80 tabular-nums text-xs">{money(summary.unverifiedAdditionalCents)}</dd></div>}
            {summary.historicalIncomplete && <div className="flex justify-between"><dt className="text-amber-400/90 text-xs">Historical recon costs</dt><dd className="text-amber-400/90 text-xs">Incomplete</dd></div>}
            <div className="flex justify-between"><dt className="text-gray-500 text-xs">Financial completeness</dt><dd className={`text-xs font-semibold ${cm.c}`}>{cm.label}</dd></div>
          </dl>
          {summary.historicalIncomplete && <p className="text-gray-600 text-[11px] mt-2">This is <b>current known investment</b>, not a definitive total cost basis — historical costs before cutover may be incomplete.</p>}
        </div>
      </div>

      {/* Add Expense (manual — B0) */}
      <div className={`${card} mt-4`}>
        <h2 className="text-white font-bold mb-1">Add expense <span className="text-gray-600 text-sm font-normal">(manual · receipt-photo AI comes in B2)</span></h2>
        <form action={addExpense} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <input type="hidden" name="inventoryVehicleId" value={inv.id} />
          <label className="text-xs text-gray-500 col-span-2">Category<br /><select name="category" className={input} defaultValue="part">{EXPENSE_CATS.map((c) => <option key={c} value={c}>{labelFor(c)}</option>)}</select></label>
          <label className="text-xs text-gray-500">Amount ($)<br /><input name="amount" type="number" step="0.01" min="0" required className={input} /></label>
          <label className="text-xs text-gray-500">Date<br /><input name="eventDate" type="date" required className={input} /></label>
          <label className="text-xs text-gray-500">Vendor<br /><input name="vendor" className={input} /></label>
          <label className="text-xs text-gray-500">Paid from<br /><select name="account" className={input} defaultValue="unknown">{IN_SCOPE_ACCOUNTS.map((a) => <option key={a.ref} value={a.ref}>{a.ref}</option>)}</select></label>
          <label className="text-xs text-gray-500 col-span-2 md:col-span-5">Memo<br /><input name="memo" className={input} /></label>
          <div><button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg w-full">Add</button></div>
        </form>
        <p className="text-gray-600 text-[11px] mt-2">The <b>account paid from</b> and the <b>vehicle this belongs to</b> are separate facts — B3 will reconcile the actual bank/card transaction to this event. Nothing here moves money.</p>
      </div>

      {/* Event ledger (append-only) */}
      <div className={`${card} mt-4`}>
        <h2 className="text-white font-bold mb-3">Event ledger <span className="text-gray-600 text-sm font-normal">(append-only)</span></h2>
        {events.length === 0 ? <p className="text-gray-500 text-sm">No events.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-gray-600 text-xs uppercase tracking-wider"><th className="text-left font-normal py-1">Date</th><th className="text-left font-normal py-1">Economic</th><th className="text-left font-normal py-1">Cash-flow</th><th className="text-left font-normal py-1">Vendor</th><th className="text-left font-normal py-1">Acct</th><th className="text-right font-normal py-1">Amount</th><th className="text-left font-normal py-1 pl-2">Status</th><th className="py-1"></th></tr></thead>
            <tbody>
              {events.map((e) => {
                const voided = e.status === 'void' || reversedTargets.has(e.id) || Boolean(e.reversesEventId)
                return (
                  <tr key={e.id} className={`border-b border-gray-800/60 ${voided ? 'opacity-45 line-through' : ''}`}>
                    <td className="py-1.5 text-gray-500 text-xs whitespace-nowrap">{e.eventDate}</td>
                    <td className="py-1.5 text-gray-200">{labelFor(e.economicCategory)}{e.reversesEventId && <span className="text-amber-400 text-xs no-underline"> ↩ reversal</span>}</td>
                    <td className="py-1.5 text-gray-500 text-xs">{labelFor(e.cashflowCategory)}</td>
                    <td className="py-1.5 text-gray-400">{e.vendor ?? '—'}</td>
                    <td className="py-1.5 text-gray-500 text-xs">{e.paymentAccountRef ?? '—'}</td>
                    <td className="py-1.5 text-right tabular-nums text-gray-200">{money(e.amountCents)}</td>
                    <td className="py-1.5 pl-2"><span className="text-[10px] text-gray-500">{e.status}{e.accountingTreatment === 'unknown_confirm' ? '' : ` · ${e.accountingTreatment}`}</span></td>
                    <td className="py-1.5 text-right">{!voided && e.economicCategory !== 'acquisition' && <form action={reverse}><input type="hidden" name="inventoryVehicleId" value={inv.id} /><input type="hidden" name="eventId" value={e.id} /><button className="text-gray-600 text-[11px] underline">reverse</button></form>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <p className="text-gray-600 text-[11px] mt-2">Accounting treatment defaults to <b>unknown / confirm</b> — the accountant-configurable treatment layer comes in B6. This ledger records facts only.</p>
      </div>
    </main>
  )
}
