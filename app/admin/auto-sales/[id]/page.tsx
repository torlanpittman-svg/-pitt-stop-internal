/**
 * Auto-Sales — Vehicle Financial Folder (B0 + B1). One folder per canonical vehicle: identity,
 * factual summary, returns/refunds/credits (append-only, lifecycle-aware), sale/closeout, indicative
 * result (completeness-aware — never definitive when historical costs are incomplete), and the
 * append-only ledger. Admin-gated. No money movement; sale proceeds never feed *5600/company S2S.
 */
import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getVehicleFolder, addExpenseEvent, reverseEvent, addReturnRefund, settleRefund, sellVehicle, updateCloseout } from '@/apps/auto-sales/db'
import { ECONOMIC_CATEGORIES, IN_SCOPE_ACCOUNTS, REFUND_KINDS, labelFor, type EconomicCategory } from '@/apps/auto-sales/types'
import { autoSalesCutoverDate } from '@/apps/settings/db'
import VinResolver from './VinResolver'

export const dynamic = 'force-dynamic'
const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const COMPLETENESS: Record<string, { c: string; label: string }> = {
  complete: { c: 'text-emerald-300', label: 'Complete' }, partially_reconstructed: { c: 'text-amber-300', label: 'Partially reconstructed' },
  historical_incomplete: { c: 'text-amber-300', label: 'Historical costs incomplete' }, needs_review: { c: 'text-red-300', label: 'Needs review' },
}
const EXPENSE_CATS: EconomicCategory[] = ['part', 'recon_labor', 'mechanic', 'bodywork', 'pdr', 'paint', 'transport', 'title_tax', 'registration', 'auction_fee', 'buyer_fee', 'floorplan_interest', 'floorplan_fee', 'other']

async function addExpense(fd: FormData) {
  'use server'
  const id = String(fd.get('inventoryVehicleId') ?? ''); const amt = Math.round(parseFloat(String(fd.get('amount') ?? '')) * 100)
  const eventDate = String(fd.get('eventDate') ?? ''); const cat = String(fd.get('category') ?? '') as EconomicCategory
  if (id && ECONOMIC_CATEGORIES.includes(cat) && Number.isFinite(amt) && amt > 0 && /^\d{4}-\d{2}-\d{2}$/.test(eventDate))
    await addExpenseEvent({ inventoryVehicleId: id, economicCategory: cat, amountCents: amt, eventDate, vendor: String(fd.get('vendor') ?? '') || undefined, memo: String(fd.get('memo') ?? '') || undefined, paymentAccountRef: String(fd.get('account') ?? 'unknown'), actor: 'admin' })
  revalidatePath(`/admin/auto-sales/${id}`)
}
async function reverse(fd: FormData) {
  'use server'
  const id = String(fd.get('inventoryVehicleId') ?? ''); const eventId = String(fd.get('eventId') ?? '')
  if (eventId) await reverseEvent(eventId, 'admin'); revalidatePath(`/admin/auto-sales/${id}`)
}
async function returnRefund(fd: FormData) {
  'use server'
  const id = String(fd.get('inventoryVehicleId') ?? ''); const originalEventId = String(fd.get('originalEventId') ?? '')
  const kindDef = REFUND_KINDS.find((k) => k.kind === String(fd.get('kind') ?? '')); const amt = Math.round(parseFloat(String(fd.get('amount') ?? '')) * 100)
  const eventDate = String(fd.get('eventDate') ?? ''); const refundStatus = String(fd.get('refundStatus') ?? 'pending') as 'expected' | 'pending' | 'settled'
  if (id && originalEventId && kindDef && Number.isFinite(amt) && amt > 0 && /^\d{4}-\d{2}-\d{2}$/.test(eventDate))
    await addReturnRefund({ inventoryVehicleId: id, originalEventId, econ: kindDef.econ, refundMethod: kindDef.method, cash: kindDef.cash, amountCents: amt, eventDate, refundStatus, destinationAccount: String(fd.get('destination') ?? '') || undefined, memo: String(fd.get('memo') ?? '') || undefined, allowExceed: fd.get('allowExceed') === 'on', actor: 'admin' })
  revalidatePath(`/admin/auto-sales/${id}`)
}
async function settle(fd: FormData) {
  'use server'
  const id = String(fd.get('inventoryVehicleId') ?? ''); const eventId = String(fd.get('eventId') ?? ''); const date = String(fd.get('date') ?? '')
  if (eventId && /^\d{4}-\d{2}-\d{2}$/.test(date)) await settleRefund(eventId, date, 'admin'); revalidatePath(`/admin/auto-sales/${id}`)
}
async function sell(fd: FormData) {
  'use server'
  const id = String(fd.get('inventoryVehicleId') ?? ''); const price = Math.round(parseFloat(String(fd.get('salePrice') ?? '')) * 100)
  const saleDate = String(fd.get('saleDate') ?? '')
  if (id && Number.isFinite(price) && price >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(saleDate)) {
    const comm = Math.round(parseFloat(String(fd.get('commission') ?? '0')) * 100) || 0
    const payoff = Math.round(parseFloat(String(fd.get('payoff') ?? '0')) * 100) || 0
    await sellVehicle({ inventoryVehicleId: id, saleDate, salePriceCents: price, saleType: (String(fd.get('saleType') ?? 'retail') as 'retail' | 'wholesale'),
      proceedsAccount: String(fd.get('proceedsAccount') ?? '') || undefined, buyerRef: String(fd.get('buyerRef') ?? '') || undefined,
      commissionCents: comm, payoffKnownCents: payoff, payoffStatus: (String(fd.get('payoffStatus') ?? 'unknown') as any),
      titleOutstanding: fd.get('titleOutstanding') === 'on', proceedsReceived: (String(fd.get('proceedsReceived') ?? 'unknown') as any),
      markDelivered: fd.get('markDelivered') === 'on', notes: String(fd.get('notes') ?? '') || undefined, actor: 'admin' })
  }
  revalidatePath(`/admin/auto-sales/${id}`)
}
async function closeout(fd: FormData) {
  'use server'
  const id = String(fd.get('inventoryVehicleId') ?? '')
  await updateCloseout({ inventoryVehicleId: id, proceedsReceived: (String(fd.get('proceedsReceived') ?? '') || undefined) as any, payoffStatus: (String(fd.get('payoffStatus') ?? '') || undefined) as any, titleOutstanding: fd.get('titleField') ? fd.get('titleOutstanding') === 'on' : undefined, markDelivered: fd.get('markDelivered') === 'on', actor: 'admin' })
  revalidatePath(`/admin/auto-sales/${id}`)
}

const input = 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white w-full'
const card = 'rounded-2xl bg-gray-900 border border-gray-800 p-5'

export default async function VehicleFolderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [folder, cutover] = await Promise.all([getVehicleFolder(id), autoSalesCutoverDate()])
  if (!folder) notFound()
  const { inv, vehicle, events, summary, result, returnable, daysOnLot } = folder
  const cm = COMPLETENESS[inv.financialCompleteness] ?? COMPLETENESS.needs_review
  const reversedTargets = new Set(events.filter((e) => e.reversesEventId).map((e) => e.reversesEventId))
  const returnEvents = events.filter((e) => e.originalEventId && ['return', 'refund', 'vendor_credit'].includes(e.economicCategory))
  const sold = result.sold || inv.status === 'sale_pending'
  const closeoutBadge = result.closeoutStatus === 'sold_incomplete' ? { c: 'bg-amber-950/40 text-amber-300 border-amber-900/60', label: 'SOLD — CLOSEOUT INCOMPLETE' }
    : result.closeoutStatus === 'sold_complete' ? { c: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60', label: 'SOLD — closeout complete' }
    : result.closeoutStatus === 'sale_pending' ? { c: 'bg-blue-950/40 text-blue-300 border-blue-900/60', label: 'SALE PENDING' } : null

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-8 py-8 max-w-5xl mx-auto">
      <Link href="/admin/auto-sales" className="text-gray-500 text-xs">← Inventory</Link>
      <div className="flex items-center gap-3 mt-1">
        <h1 className="text-2xl font-bold text-white">{inv.stockNumber ?? '(no stock — needs VIN)'} <span className="text-gray-500 font-normal text-lg">· {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unidentified vehicle'}</span></h1>
        {closeoutBadge && <span className={`text-[11px] px-2 py-0.5 rounded-full border ${closeoutBadge.c}`}>{closeoutBadge.label}</span>}
        {!vehicle.vin && <span className="text-[11px] px-2 py-0.5 rounded-full border bg-red-950/40 text-red-300 border-red-900/60">Needs VIN</span>}
      </div>

      {/* Needs-VIN → Add / Scan VIN (decode + dedup + PS stock) */}
      {!vehicle.vin && <VinResolver inventoryVehicleId={inv.id} backfill={{ year: vehicle.year, make: vehicle.make, model: vehicle.model }} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        {/* Vehicle identity */}
        <div className={card}>
          <p className="text-gray-500 text-[11px] uppercase tracking-widest mb-2">Vehicle</p>
          <dl className="text-sm space-y-1">
            <div className="flex justify-between"><dt className="text-gray-500">VIN</dt><dd className="text-gray-200 tabular-nums">{vehicle.vin ?? '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Stock #</dt><dd className="text-gray-200">{inv.stockNumber ?? '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Y/M/M · color</dt><dd className="text-gray-200">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—'} · {vehicle.color ?? '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Acquired</dt><dd className="text-gray-200">{inv.acquiredAt ?? '—'} · {daysOnLot ?? '—'} days</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Status</dt><dd className="text-gray-200 capitalize">{inv.status.replace('_', ' ')}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Tracking</dt><dd className="text-gray-200">{inv.preCutover ? `historical (pre-cutover ${cutover})` : `go-forward from ${inv.trackingStartDate}`}</dd></div>
          </dl>
        </div>

        {/* Financial summary */}
        <div className={card}>
          <p className="text-gray-500 text-[11px] uppercase tracking-widest mb-2">Financial summary</p>
          <dl className="text-sm space-y-1">
            <div className="flex justify-between"><dt className="text-gray-400">Acquisition cost</dt><dd className="text-white tabular-nums">{money(summary.acquisitionCostCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-400">Verified additional costs <span className="text-gray-600 text-xs">(net of returns/credits)</span></dt><dd className="text-white tabular-nums">{money(summary.verifiedAdditionalCents)}</dd></div>
            <div className="flex justify-between border-t border-gray-700 pt-1 mt-1"><dt className="text-gray-100 font-semibold">Current known investment</dt><dd className="text-white font-bold tabular-nums">{money(summary.knownInvestmentCents)}</dd></div>
            {summary.refundPendingCents > 0 && <div className="flex justify-between"><dt className="text-amber-400/90 text-xs">Refund pending (cash not yet received)</dt><dd className="text-amber-400/90 tabular-nums text-xs">{money(summary.refundPendingCents)}</dd></div>}
            {summary.cashRefundReceivedCents > 0 && <div className="flex justify-between"><dt className="text-emerald-300/90 text-xs">Cash refund received</dt><dd className="text-emerald-300/90 tabular-nums text-xs">{money(summary.cashRefundReceivedCents)}</dd></div>}
            {summary.historicalIncomplete && <div className="flex justify-between"><dt className="text-amber-400/90 text-xs">Historical recon costs</dt><dd className="text-amber-400/90 text-xs">Incomplete</dd></div>}
            <div className="flex justify-between"><dt className="text-gray-500 text-xs">Financial completeness</dt><dd className={`text-xs font-semibold ${cm.c}`}>{cm.label}</dd></div>
          </dl>
        </div>
      </div>

      {/* Indicative result (when sold) */}
      {result.sold && (
        <div className={`${card} mt-4 ${result.confidence === 'limited' ? 'border-amber-900/40' : 'border-emerald-900/40'}`}>
          <p className="text-gray-500 text-[11px] uppercase tracking-widest mb-2">Vehicle result <span className="text-gray-600">· {result.confidence === 'limited' ? 'LIMITED confidence — historical costs incomplete' : 'go-forward complete'}</span></p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><p className="text-gray-500 text-xs">Sale price</p><p className="text-white tabular-nums text-lg">{money(summary.proceedsCents)}</p></div>
            <div><p className="text-gray-500 text-xs">{result.confidence === 'limited' ? 'Known tracked investment' : 'Known vehicle costs'}</p><p className="text-white tabular-nums text-lg">−{money(summary.knownInvestmentCents)}</p></div>
            <div><p className="text-gray-500 text-xs">Selling costs</p><p className="text-white tabular-nums text-lg">−{money(summary.sellingCostsCents)}</p></div>
            <div><p className="text-gray-500 text-xs">{result.resultLabel}</p><p className={`tabular-nums text-lg font-bold ${(result.indicativeProfitCents ?? 0) < 0 ? 'text-red-400' : 'text-emerald-300'}`}>{money(result.indicativeProfitCents)}</p></div>
          </div>
          {result.confidence === 'limited' && <p className="text-amber-300/80 text-[11px] mt-2">This is an <b>indicative tracked margin</b>, not definitive gross profit — pre-cutover recon costs may be missing (completeness: {cm.label}).</p>}
          <p className="text-gray-600 text-[11px] mt-1">Result is economic. It does <b>not</b> mean this much free cash — payoff/title/pending proceeds are tracked separately below and never feed *5600 unencumbered or company Safe-to-Spend.</p>
          {result.unresolved.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/15 p-3">
              <p className="text-amber-300 text-xs font-semibold">Closeout incomplete — unresolved:</p>
              <ul className="text-gray-300 text-xs mt-1 list-disc pl-4">{result.unresolved.map((u, i) => <li key={i}>{u}</li>)}</ul>
              <form action={closeout} className="flex flex-wrap items-end gap-2 mt-2">
                <input type="hidden" name="inventoryVehicleId" value={inv.id} />
                <label className="text-[11px] text-gray-500">Proceeds received<br /><select name="proceedsReceived" className={input} defaultValue=""><option value="">—</option><option value="yes">yes</option><option value="no">no</option><option value="unknown">unknown</option></select></label>
                <label className="text-[11px] text-gray-500">Payoff status<br /><select name="payoffStatus" className={input} defaultValue=""><option value="">—</option><option value="paid">paid</option><option value="open">open</option><option value="none">none</option><option value="unknown">unknown</option></select></label>
                <label className="text-[11px] text-gray-500 flex items-center gap-1"><input type="hidden" name="titleField" value="1" /><input name="titleOutstanding" type="checkbox" /> title outstanding</label>
                <label className="text-[11px] text-gray-500 flex items-center gap-1"><input name="markDelivered" type="checkbox" /> mark delivered</label>
                <button className="bg-green-700 text-white text-xs font-semibold px-3 py-2 rounded-lg">Update closeout</button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Sell / Closeout (when not yet sold) */}
      {!sold && (
        <div className={`${card} mt-4`}>
          <h2 className="text-white font-bold mb-1">Sell / Closeout</h2>
          <p className="text-gray-500 text-xs mb-3">Records the sale economics (sale, commission, known payoff as ledger events) and closeout facts. Manually-known payoff is captured, not reconciled to Extraco (that's B4). Nothing moves money.</p>
          <form action={sell} className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <input type="hidden" name="inventoryVehicleId" value={inv.id} />
            <label className="text-xs text-gray-500">Sale price ($)<br /><input name="salePrice" type="number" step="0.01" min="0" required className={input} /></label>
            <label className="text-xs text-gray-500">Sale date<br /><input name="saleDate" type="date" required className={input} /></label>
            <label className="text-xs text-gray-500">Sale type<br /><select name="saleType" className={input} defaultValue="retail"><option value="retail">retail</option><option value="wholesale">wholesale</option></select></label>
            <label className="text-xs text-gray-500">Proceeds account<br /><select name="proceedsAccount" className={input} defaultValue="*5600">{IN_SCOPE_ACCOUNTS.map((a) => <option key={a.ref} value={a.ref}>{a.ref}</option>)}</select></label>
            <label className="text-xs text-gray-500">Buyer ref<br /><input name="buyerRef" placeholder="reference only" className={input} /></label>
            <label className="text-xs text-gray-500">Commission/fees ($)<br /><input name="commission" type="number" step="0.01" min="0" className={input} /></label>
            <label className="text-xs text-gray-500">Known payoff ($)<br /><input name="payoff" type="number" step="0.01" min="0" className={input} /></label>
            <label className="text-xs text-gray-500">Payoff status<br /><select name="payoffStatus" className={input} defaultValue="unknown"><option value="unknown">unknown</option><option value="open">open</option><option value="paid">paid</option><option value="none">none</option></select></label>
            <label className="text-xs text-gray-500">Proceeds received?<br /><select name="proceedsReceived" className={input} defaultValue="unknown"><option value="unknown">unknown</option><option value="yes">yes</option><option value="no">no</option></select></label>
            <label className="text-xs text-gray-500 flex items-center gap-1 mt-4"><input name="titleOutstanding" type="checkbox" /> title outstanding</label>
            <label className="text-xs text-gray-500 flex items-center gap-1 mt-4"><input name="markDelivered" type="checkbox" /> delivered</label>
            <label className="text-xs text-gray-500 col-span-2 md:col-span-4">Notes<br /><input name="notes" className={input} /></label>
            <div className="col-span-2 md:col-span-4"><button className="bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Record sale</button></div>
          </form>
        </div>
      )}

      {/* Add expense */}
      <div className={`${card} mt-4`}>
        <h2 className="text-white font-bold mb-1">Add expense <span className="text-gray-600 text-sm font-normal">(manual · receipt-photo AI in B2)</span></h2>
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
      </div>

      {/* Returns / refunds / credits */}
      <div className={`${card} mt-4`}>
        <h2 className="text-white font-bold mb-1">Returns / refunds / credits</h2>
        <p className="text-gray-500 text-xs mb-3">Links to the original expense; never deletes it. Partial returns supported. Cash/card refunds carry a <b>pending → settled</b> lifecycle (economic reduction is recognized immediately; cash isn't counted until it settles). Vendor/store credits reduce cost but are NOT bank cash.</p>
        {returnable.length === 0 ? <p className="text-gray-500 text-sm">No returnable expenses yet.</p> : (
          <form action={returnRefund} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end mb-3">
            <input type="hidden" name="inventoryVehicleId" value={inv.id} />
            <label className="text-xs text-gray-500 col-span-2">Original expense<br /><select name="originalEventId" className={input}>{returnable.filter((r) => r.remainingCents > 0).map((r) => <option key={r.id} value={r.id}>{labelFor(r.economicCategory)} {r.vendor ? `· ${r.vendor}` : ''} · {money(r.amountCents)} (rem {money(r.remainingCents)})</option>)}</select></label>
            <label className="text-xs text-gray-500">Type<br /><select name="kind" className={input} defaultValue="card_refund">{REFUND_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></label>
            <label className="text-xs text-gray-500">Amount ($)<br /><input name="amount" type="number" step="0.01" min="0" required className={input} /></label>
            <label className="text-xs text-gray-500">Date<br /><input name="eventDate" type="date" required className={input} /></label>
            <label className="text-xs text-gray-500">Status<br /><select name="refundStatus" className={input} defaultValue="pending"><option value="expected">expected</option><option value="pending">pending</option><option value="settled">settled</option></select></label>
            <label className="text-xs text-gray-500">Destination acct<br /><select name="destination" className={input} defaultValue="">{[{ ref: '', label: '—' }, ...IN_SCOPE_ACCOUNTS].map((a) => <option key={a.ref} value={a.ref}>{a.ref || '—'}</option>)}</select></label>
            <label className="text-xs text-gray-500 flex items-center gap-1"><input name="allowExceed" type="checkbox" /> allow over-return</label>
            <label className="text-xs text-gray-500 col-span-2 md:col-span-3">Notes<br /><input name="memo" className={input} /></label>
            <div><button className="bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-lg w-full">Record return</button></div>
          </form>
        )}
        {returnEvents.length > 0 && (
          <table className="w-full text-sm"><tbody>
            {returnEvents.map((e) => (
              <tr key={e.id} className="border-b border-gray-800/50">
                <td className="py-1.5 text-gray-500 text-xs whitespace-nowrap">{e.eventDate}</td>
                <td className="py-1.5 text-gray-300">{labelFor(e.economicCategory)} <span className="text-gray-600 text-xs">{e.refundMethod}</span></td>
                <td className="py-1.5"><span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${e.refundStatus === 'settled' ? 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60' : 'bg-amber-950/40 text-amber-300 border-amber-900/60'}`}>{e.refundStatus}</span></td>
                <td className="py-1.5 text-right tabular-nums text-emerald-300">−{money(e.amountCents)} <span className="text-gray-600 text-xs">off cost</span></td>
                <td className="py-1.5 pl-2 text-right">{e.refundStatus !== 'settled' && (e.refundMethod === 'cash' || e.refundMethod === 'card') && (
                  <form action={settle} className="flex items-center gap-1 justify-end"><input type="hidden" name="inventoryVehicleId" value={inv.id} /><input type="hidden" name="eventId" value={e.id} /><input name="date" type="date" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white" required /><button className="text-emerald-400 text-[11px] underline">mark settled</button></form>
                )}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>

      {/* Event ledger */}
      <div className={`${card} mt-4`}>
        <h2 className="text-white font-bold mb-3">Event ledger <span className="text-gray-600 text-sm font-normal">(append-only)</span></h2>
        <table className="w-full text-sm">
          <thead><tr className="text-gray-600 text-xs uppercase tracking-wider"><th className="text-left font-normal py-1">Date</th><th className="text-left font-normal py-1">Economic</th><th className="text-left font-normal py-1">Cash-flow</th><th className="text-left font-normal py-1">Vendor</th><th className="text-left font-normal py-1">Acct</th><th className="text-right font-normal py-1">Amount</th><th className="text-left font-normal py-1 pl-2">Status</th><th className="py-1"></th></tr></thead>
          <tbody>
            {events.map((e) => {
              const voided = e.status === 'void' || reversedTargets.has(e.id) || Boolean(e.reversesEventId)
              return (
                <tr key={e.id} className={`border-b border-gray-800/60 ${voided ? 'opacity-45 line-through' : ''}`}>
                  <td className="py-1.5 text-gray-500 text-xs whitespace-nowrap">{e.eventDate}</td>
                  <td className="py-1.5 text-gray-200">{labelFor(e.economicCategory)}{e.reversesEventId && <span className="text-amber-400 text-xs no-underline"> ↩ reversal</span>}{e.originalEventId && <span className="text-gray-600 text-xs no-underline"> ↳ vs original</span>}</td>
                  <td className="py-1.5 text-gray-500 text-xs">{labelFor(e.cashflowCategory)}{e.refundStatus ? ` · ${e.refundStatus}` : ''}</td>
                  <td className="py-1.5 text-gray-400">{e.vendor ?? '—'}</td>
                  <td className="py-1.5 text-gray-500 text-xs">{e.paymentAccountRef ?? e.refundDestinationAccount ?? '—'}</td>
                  <td className="py-1.5 text-right tabular-nums text-gray-200">{money(e.amountCents)}</td>
                  <td className="py-1.5 pl-2"><span className="text-[10px] text-gray-500">{e.status}</span></td>
                  <td className="py-1.5 text-right">{!voided && !['acquisition', 'sale', 'return', 'refund', 'vendor_credit'].includes(e.economicCategory) && <form action={reverse}><input type="hidden" name="inventoryVehicleId" value={inv.id} /><input type="hidden" name="eventId" value={e.id} /><button className="text-gray-600 text-[11px] underline">reverse</button></form>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="text-gray-600 text-[11px] mt-2"><b>Reversal</b> = a mis-entered event corrected in the ledger (append-only). A <b>return/refund/credit</b> = a real-world return linked to the original — a different concept. Accounting treatment stays <b>unknown / confirm</b> (B6).</p>
      </div>
    </main>
  )
}
