/**
 * Business Receipts — capture landing (employee surface, EMPLOYEE_PIN gated by proxy.ts).
 *
 * Any signed-in employee can snap/upload a receipt; it goes to the manager review queue. Managers also
 * see a compact link into the queue with the pending count. Capture never approves or books anything.
 */
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { receiptManager, receiptUploader } from '@/apps/expenses/authz'
import { queueCounts, listInventoryVehiclesForPicker } from '@/apps/expenses/db'
import CaptureExpense from '@/apps/expenses/ui/CaptureExpense'

export const dynamic = 'force-dynamic'

export default async function ExpensesPage() {
  // FAIL-CLOSED: require a verified session even if no PIN is configured. Anonymous → login.
  const uploader = await receiptUploader()
  if (!uploader) redirect('/auto-sales/login?next=/expenses')
  const manager = await receiptManager()
  const [counts, vehicles] = await Promise.all([
    manager ? queueCounts().catch(() => null) : Promise.resolve(null),
    listInventoryVehiclesForPicker().catch(() => []),
  ])
  const attention = counts ? counts.needs_review + counts.processing_failed : 0

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-white">Receipts</h1>
        <Link href="/" className="text-gray-500 text-sm">Home</Link>
      </div>
      <p className="text-gray-500 text-sm mb-5">Snap a receipt, answer three quick questions, and it’s filed — no manager sign-off needed. Anything unclear gets flagged for a manager.</p>

      <CaptureExpense vehicles={vehicles} />

      {manager && (
        <Link href="/expenses/review" className="mt-5 flex items-center justify-between rounded-2xl bg-gray-900 border border-gray-800 px-4 py-4">
          <span className="text-white font-semibold">Needs attention</span>
          <span className="text-sm">
            {attention > 0
              ? <span className="text-amber-300">{attention} to look at ›</span>
              : <span className="text-gray-500">All caught up ›</span>}
          </span>
        </Link>
      )}
    </main>
  )
}
