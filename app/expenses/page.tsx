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
import { getJobRef, jobLabel } from '@/apps/expenses/job-expenses'

export const dynamic = 'force-dynamic'

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  // FAIL-CLOSED: require a verified session even if no PIN is configured. Anonymous → login.
  const uploader = await receiptUploader()
  const sp = await searchParams
  if (!uploader) redirect(`/auto-sales/login?next=${encodeURIComponent(sp.job ? `/expenses?job=${sp.job}` : '/expenses')}`)
  // Opened from a customer job ("Add expense / receipt") → that job, its customer and vehicle are preselected.
  const jobRef = sp.job ? await getJobRef(sp.job).catch(() => null) : null
  const job = jobRef ? { id: jobRef.id, label: jobLabel(jobRef) } : null
  const manager = await receiptManager()
  const [counts, vehicles] = await Promise.all([
    manager ? queueCounts().catch(() => null) : Promise.resolve(null),
    listInventoryVehiclesForPicker().catch(() => []),
  ])
  const attention = counts ? counts.needs_review + counts.processing_failed : 0

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-white">{job ? 'Add job expense' : 'Receipts'}</h1>
        {job ? <Link href={`/orders/${job.id}`} className="text-gray-400 text-sm py-2">‹ Back to job</Link> : <Link href="/" className="text-gray-500 text-sm py-2">Home</Link>}
      </div>
      <p className="text-gray-500 text-sm mb-5">{job
        ? 'Snap the receipt or upload the PDF. It is saved as one expense and attached to this job — no customer price needed.'
        : 'Snap a receipt, answer three quick questions, and it’s filed — no manager sign-off needed. Anything unclear gets flagged for a manager.'}</p>
      {sp.job && !job && <p role="alert" className="text-amber-300 text-sm mb-4">That job could not be found, so this receipt will not be attached to a job. You can pick one on the last step.</p>}

      <CaptureExpense vehicles={vehicles} job={job} />

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
      {manager && (
        <Link href="/expenses/reconcile" className="mt-3 flex items-center justify-between rounded-2xl bg-gray-900 border border-gray-800 px-4 py-4">
          <span className="text-white font-semibold">Reconcile</span>
          <span className="text-sm text-gray-500">Receipts vs bank, jobs, bills ›</span>
        </Link>
      )}
    </main>
  )
}
