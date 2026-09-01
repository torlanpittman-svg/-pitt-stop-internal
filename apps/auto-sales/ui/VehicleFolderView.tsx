/**
 * Auto-Sales — Vehicle Financial Folder (shared view). Rendered by the public employee route
 * (/auto-sales/[id], admin=false) AND the gated admin route (/admin/auto-sales/[id], admin=true).
 * Employee-safe operations (add expense, sell/closeout, return/refund, VIN resolve) use the shared
 * actions module. The destructive "undo"/reverse control renders ONLY when the admin route passes a
 * `reverseAction` (defined in the gated admin module) — so it is never reachable from the public
 * route. Advanced/accounting Details render only when admin. No money movement.
 */
import { notFound } from 'next/navigation'
import BackLink from '@/app/components/BackLink'
import { getVehicleFolder } from '@/apps/auto-sales/db'
import { IN_SCOPE_ACCOUNTS, REFUND_KINDS, labelFor, costRelevance, type EconomicCategory } from '@/apps/auto-sales/types'
import { autoSalesCutoverDate } from '@/apps/settings/db'
import { sellAction, returnRefundAction, settleAction, closeoutAction } from '@/apps/auto-sales/actions'
import VinResolver from './VinResolver'
import AddExpense from './AddExpense'

const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const COMPLETENESS: Record<string, { c: string; label: string }> = {
  complete: { c: 'text-emerald-300', label: 'Complete' }, partially_reconstructed: { c: 'text-amber-300', label: 'Partially reconstructed' },
  historical_incomplete: { c: 'text-amber-300', label: 'Historical costs incomplete' }, needs_review: { c: 'text-red-300', label: 'Needs review' },
}
const box = 'bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-white w-full'
const card = 'rounded-2xl bg-gray-900 border border-gray-800 p-4'

export default async function VehicleFolderView({ id, admin, reverseAction }: { id: string; admin: boolean; reverseAction?: (fd: FormData) => Promise<void> }) {
  const [folder, cutover] = await Promise.all([getVehicleFolder(id), autoSalesCutoverDate()])
  if (!folder) notFound()
  const { inv, vehicle, events, summary, result, returnable, daysOnLot, attachments } = folder
  const returnableForReceipt = returnable.filter((r) => r.remainingCents > 0).map((r) => ({ id: r.id, label: `${labelFor(r.economicCategory)}${r.vendor ? ` · ${r.vendor}` : ''} · ${money(r.amountCents)}` }))
  const cm = COMPLETENESS[inv.financialCompleteness] ?? COMPLETENESS.needs_review
  const reversedTargets = new Set(events.filter((e) => e.reversesEventId).map((e) => e.reversesEventId))
  // Returns/credits — includes UNMATCHED (originalEventId null, flagged for review) so they stay visible.
  const returnEvents = events.filter((e) => ['return', 'refund', 'vendor_credit'].includes(e.economicCategory) && !e.reversesEventId && e.status !== 'void')
  const isFlagged = (e: typeof events[number]) => { const ev = e.evidence as any; return Boolean(ev?.unmatched || ev?.review || ev?.match?.unmatched) }
  const sold = result.sold || inv.status === 'sale_pending'
  const closeoutBadge = result.closeoutStatus === 'sold_incomplete' ? { c: 'bg-amber-950/40 text-amber-300 border-amber-900/60', label: 'SOLD · closeout incomplete' }
    : result.closeoutStatus === 'sold_complete' ? { c: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60', label: 'Sold' }
    : result.closeoutStatus === 'sale_pending' ? { c: 'bg-blue-950/40 text-blue-300 border-blue-900/60', label: 'Sale pending' } : null
  const today = new Date().toISOString().slice(0, 10)
  const base = admin ? '/admin/auto-sales' : '/auto-sales'
  const active = events.filter((e) => e.status !== 'void' && !e.reversesEventId && !reversedTargets.has(e.id))
  const grossAdded = active.filter((e) => e.economicCategory !== 'acquisition' && costRelevance(e.economicCategory as EconomicCategory) === 'cost_add' && (e.status === 'verified' || e.status === 'reconciled')).reduce((t, e) => t + e.amountCents, 0)
  const returnsTotal = active.filter((e) => costRelevance(e.economicCategory as EconomicCategory) === 'cost_contra' && (e.status === 'verified' || e.status === 'reconciled')).reduce((t, e) => t + e.amountCents, 0)

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-xl mx-auto px-4 py-6">
      <BackLink href={base} label="Inventory" />

      {/* Header: the car */}
      <div className="mt-2">
        <h1 className="text-2xl font-bold text-white leading-tight">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unidentified vehicle'}</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          {[vehicle.color, inv.stockNumber].filter(Boolean).join(' · ')}
          {closeoutBadge && <span className={`ml-2 text-[11px] px-2 py-0.5 rounded-full border ${closeoutBadge.c}`}>{closeoutBadge.label}</span>}
        </p>
        {vehicle.vin && <p className="text-gray-600 text-xs font-mono mt-0.5">VIN {vehicle.vin}</p>}
      </div>

      {/* Needs-VIN → Add / Scan VIN */}
      {!vehicle.vin && <div className="mt-4"><VinResolver inventoryVehicleId={inv.id} backfill={{ year: vehicle.year, make: vehicle.make, model: vehicle.model }} /></div>}

      {/* Money at a glance */}
      <div className={`${card} mt-4`}>
        <div className="space-y-1.5 text-[15px]">
          <div className="flex justify-between"><span className="text-gray-400">Paid for it</span><span className="text-white tabular-nums">{money(summary.acquisitionCostCents)}</span></div>
          {grossAdded > 0 && <div className="flex justify-between"><span className="text-gray-400">Added costs</span><span className="text-white tabular-nums">+{money(grossAdded)}</span></div>}
          {returnsTotal > 0 && <div className="flex justify-between"><span className="text-gray-400">Returns / credits</span><span className="text-emerald-300 tabular-nums">−{money(returnsTotal)}</span></div>}
          <div className="flex justify-between border-t border-gray-700 pt-1.5 mt-1"><span className="text-white font-semibold">In it so far</span><span className="text-white font-bold text-lg tabular-nums">{money(summary.knownInvestmentCents)}</span></div>
          {summary.refundPendingCents > 0 && <div className="flex justify-between text-xs"><span className="text-amber-400/90">Refund pending (not received yet)</span><span className="text-amber-400/90 tabular-nums">{money(summary.refundPendingCents)}</span></div>}
        </div>
        {admin && summary.historicalIncomplete && (
          <details className="mt-2">
            <summary className="text-amber-400/90 text-xs cursor-pointer list-none">⚠ Older costs may be incomplete</summary>
            <p className="text-gray-500 text-xs mt-1">This vehicle was on the lot before we started tracking every cost ({cutover}). “In it so far” is what we can prove — real costs may be higher. Costs from {cutover} forward are complete.</p>
          </details>
        )}
      </div>

      {/* Result when sold */}
      {result.sold && (
        <div className={`${card} mt-4 ${result.confidence === 'limited' ? 'border-amber-900/40' : 'border-emerald-900/40'}`}>
          <div className="flex items-center justify-between">
            <span className="text-gray-400 text-sm">{result.resultLabel}</span>
            <span className={`text-2xl font-bold tabular-nums ${(result.indicativeProfitCents ?? 0) < 0 ? 'text-red-400' : 'text-emerald-300'}`}>{money(result.indicativeProfitCents)}</span>
          </div>
          <p className="text-gray-500 text-xs mt-1">Sold {money(summary.proceedsCents)} − in it {money(summary.knownInvestmentCents)}{summary.sellingCostsCents > 0 ? ` − selling ${money(summary.sellingCostsCents)}` : ''}</p>
          {admin && result.confidence === 'limited' && <p className="text-amber-300/80 text-xs mt-1">Estimate only — older costs may be missing.</p>}
          {result.unresolved.length > 0 && (
            <div className="mt-3 rounded-xl border border-amber-900/50 bg-amber-950/15 p-3">
              <p className="text-amber-300 text-sm font-semibold">Still to finish:</p>
              <ul className="text-gray-300 text-sm mt-1 list-disc pl-5">{result.unresolved.map((u, i) => <li key={i}>{u}</li>)}</ul>
              <details className="mt-2"><summary className="text-gray-400 text-xs cursor-pointer">Update ▾</summary>
                <form action={closeoutAction} className="grid grid-cols-2 gap-2 mt-2">
                  <input type="hidden" name="inventoryVehicleId" value={inv.id} />
                  <label className="text-xs text-gray-500">Money received?<br /><select name="proceedsReceived" className={box} defaultValue=""><option value="">—</option><option value="yes">yes</option><option value="no">no</option></select></label>
                  <label className="text-xs text-gray-500">Payoff<br /><select name="payoffStatus" className={box} defaultValue=""><option value="">—</option><option value="paid">paid</option><option value="open">open</option><option value="none">none</option></select></label>
                  <label className="text-xs text-gray-500 flex items-center gap-2"><input type="hidden" name="titleField" value="1" /><input name="titleOutstanding" type="checkbox" className="w-5 h-5" /> title done</label>
                  <label className="text-xs text-gray-500 flex items-center gap-2"><input name="markDelivered" type="checkbox" className="w-5 h-5" /> delivered</label>
                  <button className="col-span-2 bg-green-700 text-white font-semibold py-3 rounded-xl">Update</button>
                </form>
              </details>
            </div>
          )}
        </div>
      )}

      {/* Primary actions */}
      <div className="mt-5 space-y-3">
        {/* ONE unified Add Expense: Take Photo / Upload / Enter Manually (+ smart return matching) */}
        <AddExpense vehicleId={inv.id} returnable={returnableForReceipt} />

        {/* Mark sold */}
        {!sold && (
          <details className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
            <summary className="px-4 py-4 cursor-pointer list-none text-white font-bold text-lg flex items-center justify-between">Mark Sold <span className="text-gray-500 text-sm">▾</span></summary>
            <form action={sellAction} className="px-4 pb-4 space-y-3">
              <input type="hidden" name="inventoryVehicleId" value={inv.id} />
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-gray-500">Sold for<br /><input name="salePrice" type="number" step="0.01" min="0" inputMode="decimal" required className={box} /></label>
                <label className="text-xs text-gray-500">Date<br /><input name="saleDate" type="date" defaultValue={today} required className={box} /></label>
              </div>
              <details className="rounded-xl border border-gray-800 bg-gray-900/60"><summary className="px-3 py-2 text-gray-400 text-sm cursor-pointer list-none">More details (optional) ▾</summary>
                <div className="px-3 pb-3 grid grid-cols-2 gap-2">
                  <label className="text-xs text-gray-500">Retail/wholesale<br /><select name="saleType" className={box} defaultValue="retail"><option value="retail">retail</option><option value="wholesale">wholesale</option></select></label>
                  <label className="text-xs text-gray-500">Proceeds to<br /><select name="proceedsAccount" className={box} defaultValue="*5600">{IN_SCOPE_ACCOUNTS.map((a) => <option key={a.ref} value={a.ref}>{a.ref}</option>)}</select></label>
                  <label className="text-xs text-gray-500">Buyer<br /><input name="buyerRef" className={box} /></label>
                  <label className="text-xs text-gray-500">Commission<br /><input name="commission" type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
                  <label className="text-xs text-gray-500">Known payoff<br /><input name="payoff" type="number" step="0.01" min="0" inputMode="decimal" className={box} /></label>
                  <label className="text-xs text-gray-500">Payoff status<br /><select name="payoffStatus" className={box} defaultValue="unknown"><option value="unknown">unknown</option><option value="open">open</option><option value="paid">paid</option><option value="none">none</option></select></label>
                  <label className="text-xs text-gray-500">Money received?<br /><select name="proceedsReceived" className={box} defaultValue="unknown"><option value="unknown">unknown</option><option value="yes">yes</option><option value="no">no</option></select></label>
                  <label className="text-xs text-gray-500 flex items-center gap-2 mt-4"><input name="titleOutstanding" type="checkbox" className="w-5 h-5" /> title outstanding</label>
                  <label className="text-xs text-gray-500 flex items-center gap-2 mt-4"><input name="markDelivered" type="checkbox" className="w-5 h-5" /> delivered</label>
                  <label className="text-xs text-gray-500 col-span-2">Notes<br /><input name="notes" className={box} /></label>
                </div>
              </details>
              <button className="w-full bg-indigo-600 active:bg-indigo-700 text-white text-lg font-bold py-4 rounded-2xl">Record Sale</button>
            </form>
          </details>
        )}

        {/* Return / refund (only if there's something to return) */}
        {returnable.some((r) => r.remainingCents > 0) && (
          <details className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
            <summary className="px-4 py-4 cursor-pointer list-none text-white font-semibold flex items-center justify-between">Return / Refund a part <span className="text-gray-500 text-sm">▾</span></summary>
            <form action={returnRefundAction} className="px-4 pb-4 space-y-3">
              <input type="hidden" name="inventoryVehicleId" value={inv.id} />
              <label className="text-xs text-gray-500">Which purchase?<br /><select name="originalEventId" className={box}>{returnable.filter((r) => r.remainingCents > 0).map((r) => <option key={r.id} value={r.id}>{labelFor(r.economicCategory)}{r.vendor ? ` · ${r.vendor}` : ''} · {money(r.amountCents)} (left {money(r.remainingCents)})</option>)}</select></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-gray-500">Type<br /><select name="kind" className={box} defaultValue="card_refund">{REFUND_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></label>
                <label className="text-xs text-gray-500">Amount<br /><input name="amount" type="number" step="0.01" min="0" inputMode="decimal" required className={box} /></label>
                <label className="text-xs text-gray-500">Date<br /><input name="eventDate" type="date" defaultValue={today} required className={box} /></label>
                <label className="text-xs text-gray-500">Got the money?<br /><select name="refundStatus" className={box} defaultValue="pending"><option value="pending">not yet</option><option value="settled">received</option><option value="expected">expected</option></select></label>
              </div>
              <details className="rounded-xl border border-gray-800 bg-gray-900/60"><summary className="px-3 py-2 text-gray-400 text-sm cursor-pointer list-none">More ▾</summary>
                <div className="px-3 pb-3 space-y-2">
                  <label className="text-xs text-gray-500">Back to account<br /><select name="destination" className={box} defaultValue="">{[{ ref: '', label: '—' }, ...IN_SCOPE_ACCOUNTS].map((a) => <option key={a.ref} value={a.ref}>{a.ref || '—'}</option>)}</select></label>
                  <label className="text-xs text-gray-500">Note<br /><input name="memo" className={box} /></label>
                  <label className="text-xs text-gray-500 flex items-center gap-2"><input name="allowExceed" type="checkbox" className="w-5 h-5" /> allow over-return</label>
                </div>
              </details>
              <button className="w-full bg-amber-600 active:bg-amber-700 text-white text-lg font-bold py-4 rounded-2xl">Record Return</button>
            </form>
          </details>
        )}
      </div>

      {/* Returns list (if any) */}
      {returnEvents.length > 0 && (
        <div className={`${card} mt-4`}>
          <p className="text-gray-400 text-sm font-semibold mb-2">Returns &amp; credits</p>
          <div className="space-y-2">
            {returnEvents.map((e) => {
              const ev = e.evidence as any
              return (
              <div key={e.id} className="text-sm">
                <div className="flex items-center justify-between">
                  <div><span className="text-gray-300">{labelFor(e.economicCategory)}</span> <span className="text-gray-600 text-xs">{e.eventDate}{e.vendor ? ` · ${e.vendor}` : ''}</span>
                    {e.refundStatus && <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full border ${e.refundStatus === 'settled' ? 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60' : 'bg-amber-950/40 text-amber-300 border-amber-900/60'}`}>{e.refundStatus === 'settled' ? (e.refundMethod === 'cash' || e.refundMethod === 'card' ? 'received' : 'credit') : e.refundStatus}</span>}
                    {isFlagged(e) && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border bg-amber-950/40 text-amber-300 border-amber-900/60" title="No matched original purchase — needs review">review</span>}</div>
                  <div className="text-right">
                    <span className="text-emerald-300 tabular-nums">−{money(e.amountCents)}</span>
                    {e.refundStatus !== 'settled' && (e.refundMethod === 'cash' || e.refundMethod === 'card') && (
                      <form action={settleAction} className="mt-1 flex items-center gap-1 justify-end"><input type="hidden" name="inventoryVehicleId" value={inv.id} /><input type="hidden" name="eventId" value={e.id} /><input name="date" type="date" defaultValue={today} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white" required /><button className="text-emerald-400 text-xs underline">received</button></form>
                    )}
                  </div>
                </div>
                {/* Admin audit: matched original, match reasons, unmatched status (read-only). */}
                {admin && (ev?.match || e.originalEventId) && (
                  <p className="text-gray-600 text-[11px] mt-0.5">
                    {e.originalEventId ? `linked to original ${e.originalEventId.slice(0, 8)}` : 'unmatched — no original linked'}
                    {ev?.match?.kind ? ` · ${ev.match.kind}` : ''}
                    {Array.isArray(ev?.match?.reasons) && ev.match.reasons.length ? ` · ${ev.match.reasons[0]}` : ''}
                    {ev?.match?.referencedReceipt ? ` · ref #${ev.match.referencedReceipt}` : ''}
                  </p>
                )}
              </div>
            )})}
          </div>
        </div>
      )}

      {/* History (ledger) — hidden by default. "Undo" (reverse) only rendered when admin passes the action. */}
      <details className="rounded-2xl bg-gray-900 border border-gray-800 mt-4 overflow-hidden">
        <summary className="px-4 py-4 cursor-pointer list-none text-gray-300 font-semibold flex items-center justify-between">History <span className="text-gray-500 text-sm">{events.length} events ▾</span></summary>
        <div className="px-4 pb-4 space-y-2">
          {events.map((e) => {
            const voided = e.status === 'void' || reversedTargets.has(e.id) || Boolean(e.reversesEventId)
            return (
              <div key={e.id} className={`flex items-center justify-between text-sm border-b border-gray-800/60 pb-1.5 ${voided ? 'opacity-45 line-through' : ''}`}>
                <div className="min-w-0">
                  <span className="text-gray-200">{labelFor(e.economicCategory)}</span>
                  {e.reversesEventId && <span className="text-amber-400 text-xs no-underline"> ↩</span>}
                  {attachments[e.id] && (attachments[e.id].url
                    ? <a href={attachments[e.id].url!} target="_blank" rel="noopener" className="text-indigo-300 no-underline ml-1" title="View receipt">📎</a>
                    : <span className="ml-1" title="receipt on file">📎</span>)}
                  <span className="block text-gray-600 text-xs">{e.eventDate}{e.vendor ? ` · ${e.vendor}` : ''}</span>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-gray-200 tabular-nums">{money(e.amountCents)}</span>
                  {reverseAction && !voided && !['acquisition', 'sale', 'return', 'refund', 'vendor_credit'].includes(e.economicCategory) && <form action={reverseAction} className="inline"><input type="hidden" name="inventoryVehicleId" value={inv.id} /><input type="hidden" name="eventId" value={e.id} /><button className="text-gray-600 text-[11px] underline ml-2">undo</button></form>}
                </div>
              </div>
            )
          })}
          <p className="text-gray-600 text-[11px] pt-1">Nothing here is ever deleted{reverseAction ? '. “Undo” adds a correcting entry' : ''}; returns stay linked to the original purchase.</p>
        </div>
      </details>

      {/* Details / advanced — admin only (read-only accounting facts) */}
      {admin && (
        <details className="mt-4">
          <summary className="text-gray-500 text-sm cursor-pointer">Details</summary>
          <div className={`${card} mt-2`}>
            <dl className="text-sm space-y-1">
              <div className="flex justify-between"><dt className="text-gray-500">Stock #</dt><dd className="text-gray-300">{inv.stockNumber ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Acquired</dt><dd className="text-gray-300">{inv.acquiredAt ?? '—'} · {daysOnLot ?? '—'} days on lot</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Status</dt><dd className="text-gray-300 capitalize">{inv.status.replace('_', ' ')}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Tracking</dt><dd className="text-gray-300">{inv.preCutover ? `pre-cutover (${cutover})` : `from ${inv.trackingStartDate}`}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Completeness</dt><dd className={`font-semibold ${cm.c}`}>{cm.label}</dd></div>
            </dl>
          </div>
        </details>
      )}
    </main>
  )
}
