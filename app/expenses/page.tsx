/**
 * Business Receipts — capture landing (employee surface, EMPLOYEE_PIN gated by proxy.ts).
 *
 * Any signed-in employee can snap/upload a receipt; it goes to the manager review queue. Managers also
 * see a compact link into the queue with the pending count. Capture never approves or books anything.
 */
import Link from 'next/link'
import { authorizedManager } from '@/apps/auth/employee-guard'
import { queueCounts } from '@/apps/expenses/db'
import CaptureExpense from '@/apps/expenses/ui/CaptureExpense'

export const dynamic = 'force-dynamic'

export default async function ExpensesPage() {
  const manager = await authorizedManager()
  const counts = manager ? await queueCounts().catch(() => null) : null

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-white">Receipts</h1>
        <Link href="/" className="text-gray-500 text-sm">Home</Link>
      </div>
      <p className="text-gray-500 text-sm mb-5">Snap a photo of any business receipt — parts, supplies, fuel, subs. A manager reviews and files it.</p>

      <CaptureExpense />

      {manager && (
        <Link href="/expenses/review" className="mt-5 flex items-center justify-between rounded-2xl bg-gray-900 border border-gray-800 px-4 py-4">
          <span className="text-white font-semibold">Review queue</span>
          <span className="text-sm">
            {counts && counts.needs_review > 0
              ? <span className="text-amber-300">{counts.needs_review} to review{counts.processing_failed ? ` · ${counts.processing_failed} unreadable` : ''} ›</span>
              : <span className="text-gray-500">All caught up ›</span>}
          </span>
        </Link>
      )}
    </main>
  )
}
