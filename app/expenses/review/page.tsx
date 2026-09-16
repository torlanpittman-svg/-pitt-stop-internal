/**
 * Business Receipts — MANAGER review queue. Manager-gated (authorizedManager; SEPARATE from
 * ADMIN_PASSWORD). Non-managers are redirected back to capture. Shows each receipt needing attention
 * with the original image alongside editable fields, plus a monthly summary of what's been approved.
 *
 * `?status=` filters the list (default: needs_review + processing_failed). `?month=` scopes the summary.
 */
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { authorizedManager } from '@/apps/auth/employee-guard'
import { listReceipts, queueCounts, monthlyExpenseReport } from '@/apps/expenses/db'
import { toReviewCard } from '@/apps/expenses/view'
import { currentReportMonth } from '@/apps/auto-sales/report-db'
import { EXPENSE_CATEGORIES, BUSINESS_ENTITIES, formatMoney, isReceiptStatus, isBusinessMonth, type ReceiptStatus } from '@/apps/expenses/types'
import ReviewCard from '@/apps/expenses/ui/ReviewCard'

export const dynamic = 'force-dynamic'

const entityLabel = (k: string) => BUSINESS_ENTITIES.find((b) => b.key === k)?.label ?? k
const categoryLabel = (k: string) => EXPENSE_CATEGORIES.find((c) => c.key === k)?.label ?? k

export default async function ReviewQueuePage({ searchParams }: { searchParams: Promise<{ status?: string; month?: string }> }) {
  if (!(await authorizedManager())) redirect('/expenses')
  const sp = await searchParams
  const filter: ReceiptStatus[] = isReceiptStatus(sp.status) ? [sp.status] : ['needs_review', 'processing_failed']
  const month = isBusinessMonth(sp.month) ? sp.month : currentReportMonth()
  const [rows, counts, report] = await Promise.all([listReceipts(filter), queueCounts(), monthlyExpenseReport(month)])

  const TABS: { key: ReceiptStatus | 'open'; label: string; n?: number }[] = [
    { key: 'open', label: 'To review', n: counts.needs_review + counts.processing_failed },
    { key: 'approved', label: 'Approved', n: counts.approved },
    { key: 'rejected', label: 'Rejected', n: counts.rejected },
  ]
  const activeKey = isReceiptStatus(sp.status) ? sp.status : 'open'

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-white">Receipt Review</h1>
        <Link href="/expenses" className="text-gray-500 text-sm">Capture</Link>
      </div>

      {/* Monthly summary — internal, NOT QuickBooks */}
      <section className="rounded-2xl bg-gray-900 border border-gray-800 p-4 mb-5">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold">{month} · approved</h2>
          <span className="text-emerald-300 font-bold">{formatMoney(report.approvedTotalCents)}</span>
        </div>
        <p className="text-gray-500 text-xs mt-1">{report.approvedCount} approved receipt{report.approvedCount === 1 ? '' : 's'} · export-ready (internal, not yet in QuickBooks)</p>
        {(report.needsReviewCount > 0 || report.processingFailedCount > 0 || report.uncategorizedCount > 0) && (
          <p className="text-amber-300/90 text-xs mt-2">
            Needs attention: {report.needsReviewCount} unreviewed{report.processingFailedCount ? ` · ${report.processingFailedCount} unreadable` : ''}{report.uncategorizedCount ? ` · ${report.uncategorizedCount} uncategorized` : ''}
          </p>
        )}
        {Object.keys(report.byEntity).length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {Object.entries(report.byEntity).map(([k, v]) => (
              <div key={k} className="flex justify-between"><span className="text-gray-400">{entityLabel(k)}</span><span className="text-gray-200">{formatMoney(v.totalCents)}</span></div>
            ))}
          </div>
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
      <div className="flex gap-2 mb-4">
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
        : <div className="space-y-4">{rows.map((r) => <ReviewCard key={r.id} r={toReviewCard(r)} />)}</div>}
    </main>
  )
}
