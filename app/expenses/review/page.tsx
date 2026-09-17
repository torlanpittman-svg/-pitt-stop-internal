/**
 * Business Receipts — MANAGER queue. Manager-gated (receiptManager, FAIL-CLOSED; SEPARATE from
 * ADMIN_PASSWORD). Non-managers are redirected back to capture. Most receipts are now filed by employees
 * and never land here — this is the "Needs attention" exception queue (with the reason each one needs help)
 * plus separate lists of filed, legacy-approved, and rejected receipts, and a monthly receipt-coverage
 * summary that honestly separates purchases from cash actually paid.
 *
 * `?status=` filters the list (default: the attention queue). `?month=` scopes the summary.
 */
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { receiptManager } from '@/apps/expenses/authz'
import { listReceipts, queueCounts, monthlyExpenseReport, listInventoryVehiclesForPicker } from '@/apps/expenses/db'
import { toReviewCard } from '@/apps/expenses/view'
import { currentReportMonth } from '@/apps/auto-sales/report-db'
import { EXPENSE_CATEGORIES, BUSINESS_ENTITIES, formatMoney, isReceiptStatus, isBusinessMonth, type ReceiptStatus } from '@/apps/expenses/types'
import ReviewCard from '@/apps/expenses/ui/ReviewCard'

export const dynamic = 'force-dynamic'

const entityLabel = (k: string) => BUSINESS_ENTITIES.find((b) => b.key === k)?.label ?? k
const categoryLabel = (k: string) => EXPENSE_CATEGORIES.find((c) => c.key === k)?.label ?? k
// Everything awaiting attention (an exception, an unfinished capture, or one transiently locked for re-read).
const OPEN_STATES: ReceiptStatus[] = ['needs_review', 'processing', 'processing_failed']

export default async function ReviewQueuePage({ searchParams }: { searchParams: Promise<{ status?: string; month?: string }> }) {
  // FAIL-CLOSED manager gate (never dev-opens); non-managers are redirected to capture.
  if (!(await receiptManager())) redirect('/expenses')
  const sp = await searchParams
  const filter: ReceiptStatus[] = isReceiptStatus(sp.status) ? [sp.status] : OPEN_STATES
  const month = isBusinessMonth(sp.month) ? sp.month : currentReportMonth()
  const [rows, counts, report, vehicles] = await Promise.all([listReceipts(filter), queueCounts(), monthlyExpenseReport(month), listInventoryVehiclesForPicker()])

  const TABS: { key: ReceiptStatus | 'open'; label: string; n?: number }[] = [
    { key: 'open', label: 'Needs attention', n: counts.needs_review + counts.processing + counts.processing_failed },
    { key: 'filed', label: 'Filed', n: counts.filed },
    { key: 'approved', label: 'Approved (legacy)', n: counts.approved },
    { key: 'rejected', label: 'Rejected', n: counts.rejected },
  ]
  const activeKey = isReceiptStatus(sp.status) ? sp.status : 'open'

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-white">Receipts</h1>
        <Link href="/expenses" className="text-gray-500 text-sm">Capture</Link>
      </div>

      {/* Monthly receipt-COVERAGE summary — internal, NOT QuickBooks, NOT a bank reconciliation */}
      <section className="rounded-2xl bg-gray-900 border border-gray-800 p-4 mb-5">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold">{month} · receipts filed</h2>
          <span className="text-emerald-300 font-bold">{formatMoney(report.purchasesTotalCents)}</span>
        </div>
        <p className="text-gray-500 text-xs mt-1">{report.completeCount} complete receipt{report.completeCount === 1 ? '' : 's'} ({report.filedCount} filed{report.approvedCount ? ` · ${report.approvedCount} legacy approved` : ''}) · receipt coverage, not a full ledger</p>

        {/* Purchases are NOT the same as cash paid — split honestly. */}
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <div className="flex justify-between"><span className="text-gray-400">Business cash out</span><span className="text-gray-200">{formatMoney(report.businessCashOutflowCents)}</span></div>
          {report.personalReimbursableCents > 0 && <div className="flex justify-between"><span className="text-gray-400">Personal (reimburse?)</span><span className="text-amber-200">{formatMoney(report.personalReimbursableCents)}</span></div>}
          {report.unpaidCents > 0 && <div className="flex justify-between"><span className="text-gray-400">Not paid yet</span><span className="text-amber-200">{formatMoney(report.unpaidCents)}</span></div>}
          {report.unknownFundingCents > 0 && <div className="flex justify-between"><span className="text-gray-400">Unknown funding</span><span className="text-gray-300">{formatMoney(report.unknownFundingCents)}</span></div>}
        </div>

        {(report.needsReviewCount > 0 || report.processingFailedCount > 0 || report.uncategorizedCount > 0) && (
          <p className="text-amber-300/90 text-xs mt-2">
            Needs attention: {report.needsReviewCount} unresolved{report.processingFailedCount ? ` · ${report.processingFailedCount} unreadable` : ''}{report.uncategorizedCount ? ` · ${report.uncategorizedCount} uncategorized` : ''}
          </p>
        )}
        {Object.keys(report.byEntity).length > 0 && (
          <details className="mt-2"><summary className="text-gray-500 text-xs cursor-pointer list-none">By business ▾</summary>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {Object.entries(report.byEntity).map(([k, v]) => (
                <div key={k} className="flex justify-between"><span className="text-gray-400">{entityLabel(k)}</span><span className="text-gray-200">{formatMoney(v.totalCents)}</span></div>
              ))}
            </div>
          </details>
        )}
        {Object.keys(report.byCategory).length > 0 && (
          <details className="mt-2"><summary className="text-gray-500 text-xs cursor-pointer list-none">By category ▾</summary>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {Object.entries(report.byCategory).sort((a, b) => b[1].totalCents - a[1].totalCents).map(([k, v]) => (
                <div key={k} className="flex justify-between"><span className="text-gray-400">{categoryLabel(k)}</span><span className="text-gray-200">{formatMoney(v.totalCents)}</span></div>
              ))}
            </div>
          </details>
        )}
      </section>

      {/* Tabs */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {TABS.map((t) => {
          const href = t.key === 'open' ? '/expenses/review' : `/expenses/review?status=${t.key}`
          const active = activeKey === t.key
          return (
            <Link key={t.key} href={href} className={`px-3 py-1.5 rounded-full text-sm border ${active ? 'bg-gray-800 text-white border-gray-600' : 'bg-gray-900 text-gray-400 border-gray-800'}`}>
              {t.label}{t.n ? <span className="text-gray-500"> {t.n}</span> : null}
            </Link>
          )
        })}
      </div>

      {rows.length === 0
        ? <p className="text-gray-500 text-sm text-center py-12">Nothing here.</p>
        : <div className="space-y-4">{rows.map((r) => <ReviewCard key={r.id} r={toReviewCard(r)} vehicles={vehicles} />)}</div>}
    </main>
  )
}
