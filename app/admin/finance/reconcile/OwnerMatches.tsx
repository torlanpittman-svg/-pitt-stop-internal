/**
 * Owner reconciliation sections (server component; /admin is ADMIN_PASSWORD-gated by proxy.ts):
 * counted-once totals, cash movements that are not purchases, expected bills vs actual payments, suggested
 * matches to confirm, and the matches already confirmed. The forms post to the server actions passed in.
 */
import type { OwnerReconciliation, RecordView, BillState } from '@/apps/finance/reconcile-links'
import type { VehicleMatchRiskView } from '@/apps/expenses/vehicle-link'

const money = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const card = 'rounded-2xl bg-gray-900 border border-gray-800 p-4'
const btn = 'rounded-xl px-3 py-3 text-sm font-semibold min-h-11'
const SOURCE_LABEL: Record<string, string> = { receipt: 'receipts', bank_txn: 'bank / card', check: 'written checks', qb_purchase: 'QuickBooks', vehicle_event: 'vehicle ledger' }
const BILL_TONE: Record<BillState, string> = { paid_confirmed: 'text-emerald-300', payment_suggested: 'text-amber-300', not_seen: 'text-amber-300', not_observable: 'text-sky-300', cannot_check: 'text-gray-400' }
const BILL_WORD: Record<BillState, string> = { paid_confirmed: 'Paid (confirmed)', payment_suggested: 'Payment found — confirm', not_seen: 'No payment seen', not_observable: 'Not yet observable', cannot_check: 'Can’t be checked' }

function Rec({ r }: { r: RecordView }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-gray-100 break-words">{r.title} <span className="text-gray-300 tabular-nums">· {money(r.amountCents)}</span></p>
      <p className="text-xs text-gray-500 break-words">{[r.date, r.detail].filter(Boolean).join(' · ')}</p>
    </div>
  )
}
type Action = (fd: FormData) => Promise<void>

/**
 * A receipt and a typed vehicle expense matched on the SAME vehicle: today they count once. There is no plain
 * "undo" for this — the owner picks one of three explicit outcomes (the server refuses anything else).
 */
function VehicleMatchResolve({ linkId, risk, resolve }: { linkId: string; risk: VehicleMatchRiskView; resolve: Action }) {
  const differ = risk.receiptCents != null && risk.receiptCents !== risk.eventCents
  return (
    <details className="mt-1 rounded-xl border border-amber-900/50 bg-amber-950/15">
      <summary className="px-3 py-2 text-amber-200 text-xs cursor-pointer min-h-11 flex items-center">Change this match… (it keeps this purchase counted once on {risk.vehicleLabel})</summary>
      <div className="px-3 pb-3 space-y-2">
        <p className="text-amber-100 text-sm">Both records are on <span className="font-semibold">{risk.vehicleLabel}</span>. While they are matched, the vehicle counts this purchase <span className="font-semibold">once</span> ({money(risk.eventCents)}). Undoing the match on its own would count it twice — {money(risk.eventCents)} + {money(risk.receiptCents)} — in the vehicle’s investment and profit.</p>
        <form action={resolve}><input type="hidden" name="id" value={linkId} /><input type="hidden" name="resolution" value="keep_matched" />
          <button className={`${btn} w-full bg-indigo-600 text-white`}>Keep matched — count it once</button></form>
        <form action={resolve}><input type="hidden" name="id" value={linkId} /><input type="hidden" name="resolution" value="different_purchases" />
          <button className={`${btn} w-full border border-gray-700 text-gray-200`}>They are two different purchases — count both</button>
          <p className="text-gray-500 text-xs mt-1">The vehicle’s investment goes up by {money(risk.receiptCents)}. Recorded as “not the same purchase”, so it is not asked again.</p></form>
        {risk.canRemoveDuplicate ? (
          <form action={resolve}><input type="hidden" name="id" value={linkId} /><input type="hidden" name="resolution" value="remove_duplicate" />
            <button className={`${btn} w-full border border-gray-700 text-gray-200`}>Remove the duplicate vehicle entry — keep the receipt</button>
            <p className="text-gray-500 text-xs mt-1">The expense typed on the vehicle is reversed with a correcting entry (it stays in the vehicle’s History) and the receipt carries the purchase. Still counted once{differ ? ` — at the receipt’s amount, ${money(risk.receiptCents)} instead of ${money(risk.eventCents)}` : ''}.</p></form>
        ) : (
          <p className="text-gray-500 text-xs">The duplicate vehicle entry cannot be removed here: {risk.removeBlockedWhy}</p>
        )}
        <p className="text-gray-600 text-xs">Nothing is deleted. Every choice is recorded. No QuickBooks record is changed.</p>
      </div>
    </details>
  )
}

export default function OwnerMatches({ data, decide, clear, resolve, vehicleRisks = {} }: { data: OwnerReconciliation; decide: Action; clear: Action; resolve?: Action; vehicleRisks?: Record<string, VehicleMatchRiskView> }) {
  const L = data.ledger
  const single = Object.entries(L.singleSourceBySource).filter(([, v]) => v.count > 0)
  return (
    <div className="space-y-4 mb-5">
      <section aria-labelledby="once-title" className={card}>
        <h2 id="once-title" className="text-white font-semibold">Purchases counted once · last {data.days} days</h2>
        <p className="text-2xl font-bold text-white tabular-nums mt-1">{money(L.countedOnceCents)}</p>
        <p className="text-gray-400 text-xs mt-1">{L.groups.length} purchases. A purchase that appears in several places (receipt, bank, check, QuickBooks, vehicle ledger) is counted one time once the records are matched.</p>
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-gray-400">If every list were simply added up</dt><dd className="text-gray-200 tabular-nums">{money(L.naiveSumCents)}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-400">Kept from double counting by confirmed matches</dt><dd className="text-emerald-300 tabular-nums">{money(L.duplicateCents)}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-400">Purchases confirmed in 2+ places</dt><dd className="text-gray-200 tabular-nums">{L.multiSourceCount}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-400">Purchases seen in only one place</dt><dd className="text-amber-200 tabular-nums">{L.singleSourceCount}</dd></div>
        </dl>
        {single.length > 0 && (
          <p className="text-amber-200/90 text-xs mt-3 break-words">Not matched to anything else yet: {single.map(([k, v]) => `${v.count} in ${SOURCE_LABEL[k]} (${money(v.cents)})`).join(' · ')}. Some of these are the same purchase in two lists — until they are matched below, this total is higher than what was really spent. It is a working figure, not the books.</p>
        )}
        {L.disagreeCount > 0 && <p role="alert" className="text-red-300 text-xs mt-2">{L.disagreeCount} matched purchase{L.disagreeCount === 1 ? ' has' : 's have'} amounts that disagree between sources.</p>}
        <p className="text-gray-600 text-xs mt-3">Job costs are separate: assigning a purchase to a customer job never adds to this figure.</p>
      </section>

      {data.cashMovements.length > 0 && (
        <section aria-labelledby="moves-title" className={card}>
          <h2 id="moves-title" className="text-white font-semibold">Money out that is not a purchase</h2>
          <p className="text-gray-500 text-xs mt-1">Left the bank, but is not counted above — counting it would count things twice or call a transfer an expense.</p>
          <ul className="mt-2 space-y-1">
            {data.cashMovements.map((m) => (
              <li key={m.txnClass} className="flex justify-between gap-3 text-sm"><span className="text-gray-300 break-words min-w-0">{m.label} <span className="text-gray-500">· {m.count}</span></span><span className="shrink-0 text-gray-200 tabular-nums">{money(m.cents)}</span></li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="bills-title" className={card}>
        <h2 id="bills-title" className="text-white font-semibold">Expected bills and their actual payments</h2>
        <p className="text-gray-500 text-xs mt-1">An expected bill is a forecast. When its payment posts, the payment is the actual — the two are matched, never added together. Forecast for these bills: {money(data.billsExpectedCents)} · confirmed paid: {money(data.billsPaidConfirmedCents)}.</p>
        {data.bills.length === 0 && <p className="text-gray-500 text-sm mt-3">No confirmed recurring bills.</p>}
        <ul className="mt-2 divide-y divide-gray-800">
          {data.bills.map((b) => (
            <li key={b.obligationId} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-gray-100 break-words min-w-0">{b.vendor} <span className="text-gray-500">· {b.frequency ?? 'no frequency'} · expected {money(b.expectedCents)}</span></p>
                <p className={`shrink-0 text-xs ${BILL_TONE[b.state]}`}>{BILL_WORD[b.state]}</p>
              </div>
              <p className="text-gray-400 text-xs mt-1 break-words">{b.explain}</p>
              {b.payment && <div className="mt-2 rounded-xl border border-gray-800 p-2"><Rec r={b.payment} /></div>}
              {b.state === 'payment_suggested' && b.payment && (
                <div className="mt-2 flex gap-2">
                  <form action={decide} className="flex-1"><input type="hidden" name="kind" value="bill_payment" /><input type="hidden" name="aId" value={b.obligationId} /><input type="hidden" name="bId" value={b.payment.id} /><input type="hidden" name="status" value="confirmed" /><input type="hidden" name="amount" value={b.payment.amountCents ?? ''} />
                    <button className={`${btn} w-full bg-indigo-600 text-white`}>This payment is this bill</button></form>
                  <form action={decide} className="flex-1"><input type="hidden" name="kind" value="bill_payment" /><input type="hidden" name="aId" value={b.obligationId} /><input type="hidden" name="bId" value={b.payment.id} /><input type="hidden" name="status" value="dismissed" />
                    <button className={`${btn} w-full border border-gray-700 text-gray-200`}>Not this bill</button></form>
                </div>
              )}
              {b.state === 'paid_confirmed' && b.linkId && <form action={clear} className="mt-2"><input type="hidden" name="id" value={b.linkId} /><button className="text-gray-400 text-xs underline py-2 min-h-11">Undo this match</button></form>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="sug-title" className={card}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="sug-title" className="text-white font-semibold">Matches to confirm</h2>
          <p className="shrink-0 text-sm text-gray-300 tabular-nums">{data.suggestionsTotal}</p>
        </div>
        <p className="text-gray-500 text-xs mt-1">Two records that look like the same purchase. Nothing is matched until you confirm it; confirmed matches are saved and are not asked again.{data.suggestionsTotal > data.suggestions.length ? ` Showing the first ${data.suggestions.length}.` : ''}</p>
        {data.suggestions.length === 0 && <p className="text-gray-500 text-sm mt-3">Nothing to confirm.</p>}
        <ul className="mt-2 divide-y divide-gray-800">
          {data.suggestions.map((s) => (
            <li key={`${s.kind}|${s.a.id}|${s.b.id}`} className="py-3 space-y-2">
              <p className="text-xs"><span className="text-gray-400">{s.kindLabel}</span> <span className={`ml-1 rounded-full border px-2 py-0.5 text-[11px] ${s.ambiguous ? 'border-amber-900/60 bg-amber-950/30 text-amber-300' : s.strength === 'strong' ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300' : 'border-gray-700 text-gray-300'}`}>{s.ambiguous ? 'More than one candidate — check carefully' : s.strength === 'strong' ? 'Strong evidence' : 'Possible'}</span></p>
              <Rec r={s.a} /><Rec r={s.b} />
              <p className="text-gray-500 text-xs break-words">Why: {s.reasons.join(', ') || 'similar amount and date'}</p>
              <div className="flex gap-2">
                <form action={decide} className="flex-1"><input type="hidden" name="kind" value={s.kind} /><input type="hidden" name="aId" value={s.a.id} /><input type="hidden" name="bId" value={s.b.id} /><input type="hidden" name="status" value="confirmed" /><input type="hidden" name="amount" value={s.a.amountCents ?? ''} /><input type="hidden" name="evidence" value={JSON.stringify(s.evidence)} />
                  <button className={`${btn} w-full bg-indigo-600 text-white`}>Same purchase</button></form>
                <form action={decide} className="flex-1"><input type="hidden" name="kind" value={s.kind} /><input type="hidden" name="aId" value={s.a.id} /><input type="hidden" name="bId" value={s.b.id} /><input type="hidden" name="status" value="dismissed" />
                  <button className={`${btn} w-full border border-gray-700 text-gray-200`}>Not the same</button></form>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="conf-title" className={card}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="conf-title" className="text-white font-semibold">Confirmed matches</h2>
          <p className="shrink-0 text-sm text-gray-300 tabular-nums">{data.confirmed.length}</p>
        </div>
        <p className="text-gray-500 text-xs mt-1">Saved decisions. Undoing one keeps its history and returns the pair to the list above.</p>
        {data.confirmed.length === 0 && <p className="text-gray-500 text-sm mt-3">No matches have been confirmed yet.</p>}
        <details className="mt-2" open={data.confirmed.length > 0 && data.confirmed.length <= 5}>
          <summary className="text-indigo-300 text-sm cursor-pointer py-2">{data.confirmed.length > 0 ? `Show ${data.confirmed.length}` : 'Nothing to show'}</summary>
          <ul className="divide-y divide-gray-800">
            {data.confirmed.map((c) => (
              <li key={`${c.kind}|${c.a.id}|${c.b.id}`} className="py-3 space-y-1">
                <p className="text-xs text-gray-400">{c.kindLabel} · confirmed by {c.decidedBy ?? 'unknown'}{c.decidedAt ? ` on ${c.decidedAt.slice(0, 10)}` : ''}</p>
                <Rec r={c.a} /><Rec r={c.b} />
                {c.linkId && vehicleRisks[c.linkId] && resolve
                  ? <VehicleMatchResolve linkId={c.linkId} risk={vehicleRisks[c.linkId]} resolve={resolve} />
                  : c.linkId
                    ? <form action={clear}><input type="hidden" name="id" value={c.linkId} /><button className="text-gray-400 text-xs underline py-2 min-h-11">Undo this match</button></form>
                    : <p className="text-gray-600 text-xs">Receipt-to-bank matches are undone on the Finance page.</p>}
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section aria-labelledby="cov-title" className={card}>
        <h2 id="cov-title" className="text-white font-semibold">What each source can and cannot show</h2>
        <ul className="mt-2 space-y-2">
          {data.coverage.map((s) => (
            <li key={s.key}><p className="text-sm text-gray-200">{s.label} <span className={`text-xs ${s.state === 'ok' ? 'text-emerald-300' : s.state === 'stale' ? 'text-amber-300' : s.state === 'partial' ? 'text-sky-300' : 'text-gray-400'}`}>· {s.state === 'ok' ? 'Available' : s.state === 'stale' ? 'Behind' : s.state === 'partial' ? 'Partial' : 'Not available'}</span></p><p className="text-gray-400 text-xs break-words">{s.detail}</p></li>
          ))}
        </ul>
      </section>
    </div>
  )
}
