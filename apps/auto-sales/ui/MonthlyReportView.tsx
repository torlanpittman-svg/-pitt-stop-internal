/**
 * Auto-Sales — Monthly accountant report (in-app + printable). Renders the LIVE report (recomputed from
 * source) with a status badge vs. the latest finalized snapshot. Sections: A month summary, B acquired,
 * C sold, D month-end inventory. Managers can finalize (snapshot). Print CSS collapses chrome for the
 * accountant package; a CSV export link produces the detailed rows. Management/estimated figures only —
 * no QuickBooks posting; taxes/fees separately stated; missing data flagged (never silently zeroed).
 */
import Link from 'next/link'
import { loadMonthlyReport, reportStatus, currentReportMonth, isValidMonth, reportingTimezone } from '@/apps/auto-sales/report-db'
import { authorizedManager } from '@/apps/auth/employee-guard'
import FinalizeReport from './FinalizeReport'

const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return d.toISOString().slice(0, 7)
}

const STATE_BADGE: Record<string, { c: string; label: string }> = {
  live: { c: 'bg-gray-800 text-gray-300 border-gray-700', label: 'LIVE / DRAFT' },
  finalized: { c: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60', label: 'FINALIZED' },
  changed: { c: 'bg-amber-950/40 text-amber-300 border-amber-900/60', label: 'CHANGED — needs re-finalize' },
}

export default async function MonthlyReportView({ month: rawMonth, print = false }: { month?: string; print?: boolean }) {
  const month = rawMonth && isValidMonth(rawMonth) ? rawMonth : currentReportMonth()
  const [report, manager] = await Promise.all([loadMonthlyReport(month), authorizedManager()])
  const status = await reportStatus(report)
  const s = report.summary
  const badge = STATE_BADGE[status.state]
  const finalizedAt = status.latest ? new Date(status.latest.createdAt).toISOString().slice(0, 16).replace('T', ' ') : null

  const th = 'text-left text-gray-500 font-medium px-2 py-1'
  const td = 'px-2 py-1 tabular-nums'
  const wrap = print ? 'bg-white text-gray-900 min-h-screen p-6 text-[12px]' : 'min-h-screen bg-gray-950 text-gray-200 px-4 py-6 max-w-5xl mx-auto'
  const cardCls = print ? 'border border-gray-300 rounded p-3 mb-4' : 'rounded-2xl bg-gray-900 border border-gray-800 p-4 mb-4'

  const SummaryRow = ({ label, value, note }: { label: string; value: string; note?: string }) => (
    <div className="flex justify-between py-0.5"><span className={print ? 'text-gray-700' : 'text-gray-400'}>{label}{note ? <span className="text-gray-500 text-xs"> ({note})</span> : null}</span><span className="tabular-nums font-medium">{value}</span></div>
  )

  return (
    <main className={wrap}>
      {/* Header + controls */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          {!print && <Link href="/admin/auto-sales" className="text-gray-500 text-sm print:hidden">← Auto Sales</Link>}
          <h1 className={`text-2xl font-bold ${print ? 'text-black' : 'text-white'}`}>Auto Sales — Monthly Report</h1>
          <p className={print ? 'text-gray-700' : 'text-gray-400'}>{month} · timezone {report.tz}</p>
          <p className="text-gray-500 text-xs mt-0.5">Generated {report.generatedAt.slice(0, 16).replace('T', ' ')} UTC · management/estimated figures · not posted to QuickBooks</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className={`text-[11px] px-2 py-1 rounded-full border ${badge.c}`}>{badge.label}</span>
          {finalizedAt && <span className="text-gray-500 text-[11px]">finalized {finalizedAt} by {status.latest?.generatedBy ?? '—'}{status.finalizedCount > 1 ? ` · ${status.finalizedCount} versions` : ''}</span>}
          {!print && (
            <div className="flex items-center gap-2 print:hidden">
              <Link href={`/admin/auto-sales/report?month=${shiftMonth(month, -1)}`} className="text-gray-400 text-sm px-2 py-1 rounded border border-gray-700">← {shiftMonth(month, -1)}</Link>
              <Link href={`/admin/auto-sales/report?month=${shiftMonth(month, 1)}`} className="text-gray-400 text-sm px-2 py-1 rounded border border-gray-700">{shiftMonth(month, 1)} →</Link>
            </div>
          )}
          {!print && (
            <div className="flex items-center gap-2 print:hidden">
              <a href={`/api/auto-sales/report/csv?month=${month}`} className="text-indigo-300 text-sm underline">CSV</a>
              <Link href={`/admin/auto-sales/report/print?month=${month}`} className="text-indigo-300 text-sm underline" target="_blank">Print</Link>
              <FinalizeReport month={month} canFinalize={!!manager} state={status.state} />
            </div>
          )}
        </div>
      </div>

      {/* Data-quality flags */}
      {report.flags.length > 0 && (
        <div className={`${print ? 'border border-amber-400 bg-amber-50' : 'rounded-2xl border border-amber-900/50 bg-amber-950/15'} p-3 my-4`}>
          <p className={`text-sm font-semibold ${print ? 'text-amber-800' : 'text-amber-300'}`}>Data flags</p>
          <ul className={`text-sm mt-1 list-disc pl-5 ${print ? 'text-amber-900' : 'text-amber-200/90'}`}>{report.flags.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}

      {/* A — Month summary */}
      <section className={cardCls}>
        <h2 className={`font-bold mb-2 ${print ? 'text-black' : 'text-white'}`}>A · Month summary</h2>
        <div className="grid md:grid-cols-2 gap-x-8 text-[15px]">
          <div>
            <SummaryRow label="Beginning inventory" value={`${s.beginningInventoryCount} · ${money(s.beginningInventoryValueCents)}`} />
            <SummaryRow label="Vehicles acquired" value={`${s.acquiredCount}`} />
            <SummaryRow label="Acquisition price (acquired)" value={money(s.acquiredPriceTotalCents)} />
            <SummaryRow label="Acquisition-related costs added" value={money(s.acquisitionRelatedAddedCents)} />
            <SummaryRow label="Repairs / reconditioning added" value={money(s.reconAddedCents)} />
            <SummaryRow label="Ending inventory" value={`${s.endingInventoryCount} · ${money(s.endingInventoryValueCents)}`} />
          </div>
          <div>
            <SummaryRow label="Vehicles sold" value={`${s.soldCount}`} />
            <SummaryRow label="Vehicle sales price" value={money(s.salesPriceTotalCents)} />
            <SummaryRow label="Taxes collected" value={money(s.taxCollectedCents)} note="pass-through" />
            <SummaryRow label="Customer fees collected" value={money(s.feesCollectedCents)} />
            <SummaryRow label="Discounts / allowances" value={money(s.discountsCents)} />
            <SummaryRow label="Total transaction amount" value={money(s.totalTransactionCents)} />
            <SummaryRow label="Amount received" value={money(s.amountReceivedCents)} />
            <SummaryRow label="Receivables remaining" value={money(s.receivablesRemainingCents)} />
            <SummaryRow label="Cost basis of vehicles sold" value={money(s.costBasisOfSoldCents)} />
            <SummaryRow label="Estimated gross profit on sold" value={money(s.estGrossProfitOnSoldCents)} />
          </div>
        </div>
        <div className={`mt-2 pt-2 border-t ${print ? 'border-gray-300' : 'border-gray-800'} grid md:grid-cols-3 gap-x-8 text-sm`}>
          <SummaryRow label="Missing acquisition price" value={`${s.missingAcquisitionPriceCount} · ${money(s.missingAcquisitionPriceValueCents)}`} />
          <SummaryRow label="Sold w/ incomplete info" value={`${s.soldIncompleteCount}`} />
          <SummaryRow label="Reversed / corrected sales" value={`${s.reversedSalesCount}`} />
        </div>
      </section>

      {/* B — Acquired */}
      <section className={cardCls}>
        <h2 className={`font-bold mb-2 ${print ? 'text-black' : 'text-white'}`}>B · Vehicles acquired ({report.acquired.length})</h2>
        {report.acquired.length === 0 ? <p className="text-gray-500 text-sm">None.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm border-collapse">
            <thead><tr>{['Stock', 'Vehicle', 'VIN', 'Acquired', 'Acq. price', 'Acq. costs', 'Recon (mo)', 'Recon (total)', 'Status', 'Flags'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>{report.acquired.map((r) => (
              <tr key={r.id} className={print ? 'border-t border-gray-200' : 'border-t border-gray-800'}>
                <td className={td}>{r.stockNumber ?? '—'}</td><td className={td}>{r.ymm}</td><td className={`${td} font-mono text-xs`}>{r.vin ?? '—'}</td>
                <td className={td}>{r.acquisitionDate ?? '—'}</td><td className={td}>{money(r.acquisitionPriceCents)}</td><td className={td}>{money(r.acquisitionRelatedCents)}</td>
                <td className={td}>{money(r.reconThisMonthCents)}</td><td className={td}>{money(r.reconToDateCents)}</td><td className={td}>{r.status}</td>
                <td className={`${td} text-amber-500 text-xs`}>{r.flags.join('; ')}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {/* C — Sold */}
      <section className={cardCls}>
        <h2 className={`font-bold mb-2 ${print ? 'text-black' : 'text-white'}`}>C · Vehicles sold ({report.sold.length})</h2>
        {report.sold.length === 0 ? <p className="text-gray-500 text-sm">None.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm border-collapse">
            <thead><tr>{['Stock', 'Vehicle', 'VIN', 'Acq.', 'Sold', 'Buyer', 'Cost', 'Sale', 'Tax', 'Fees', 'Disc.', 'Total', 'Rec\'d', 'Balance', 'Est. GP', 'Pay', 'By', 'Flags'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>{report.sold.map((r) => (
              <tr key={r.id} className={print ? 'border-t border-gray-200' : 'border-t border-gray-800'}>
                <td className={td}>{r.stockNumber ?? '—'}</td><td className={td}>{r.ymm}</td><td className={`${td} font-mono text-xs`}>{r.vin ?? '—'}</td>
                <td className={td}>{r.acquisitionDate ?? '—'}</td><td className={td}>{r.saleDate ?? '—'}</td><td className={td}>{r.buyer ?? '—'}</td>
                <td className={td}>{money(r.totalInvestedCents)}</td><td className={td}>{money(r.salePriceCents)}</td><td className={td}>{money(r.taxCents)}</td>
                <td className={td}>{money(r.feesCents)}</td><td className={td}>{money(r.discountCents)}</td><td className={td}>{money(r.totalTransactionCents)}</td>
                <td className={td}>{money(r.amountReceivedCents)}</td><td className={td}>{money(r.balanceRemainingCents)}</td>
                <td className={`${td} font-semibold ${r.estGrossProfitCents < 0 ? 'text-red-400' : print ? 'text-emerald-700' : 'text-emerald-300'}`}>{money(r.estGrossProfitCents)}</td>
                <td className={td}>{r.paymentMethod ?? '—'}</td><td className={td}>{r.salesperson ?? '—'}</td>
                <td className={`${td} text-amber-500 text-xs`}>{r.flags.join('; ')}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {/* D — Month-end inventory */}
      <section className={cardCls}>
        <h2 className={`font-bold mb-2 ${print ? 'text-black' : 'text-white'}`}>D · Month-end inventory ({report.endingInventory.length})</h2>
        {report.endingInventory.length === 0 ? <p className="text-gray-500 text-sm">None held at month end.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm border-collapse">
            <thead><tr>{['Stock', 'Vehicle', 'VIN', 'Acquired', 'Days', 'Acq. price', 'Acq. costs', 'Recon', 'Total cost', 'Status', 'Flags'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>{report.endingInventory.map((r) => (
              <tr key={r.id} className={print ? 'border-t border-gray-200' : 'border-t border-gray-800'}>
                <td className={td}>{r.stockNumber ?? '—'}</td><td className={td}>{r.ymm}</td><td className={`${td} font-mono text-xs`}>{r.vin ?? '—'}</td>
                <td className={td}>{r.acquisitionDate ?? '—'}</td><td className={td}>{r.daysInInventory ?? '—'}</td><td className={td}>{money(r.acquisitionPriceCents)}</td>
                <td className={td}>{money(r.acquisitionRelatedCents)}</td><td className={td}>{money(r.reconditioningCents)}</td><td className={td}>{money(r.totalInvestedCents)}</td>
                <td className={td}>{r.status}</td><td className={`${td} text-amber-500 text-xs`}>{r.flags.join('; ')}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <p className="text-gray-500 text-[11px] mt-2">Estimated gross profit = (selling price − discount) − acquisition price − acquisition-related − reconditioning. Taxes &amp; customer fees are excluded and shown separately. Report is reproducible from stored source data (content hash {report.contentHash}).</p>
    </main>
  )
}
