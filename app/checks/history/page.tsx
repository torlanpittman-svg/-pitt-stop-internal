/**
 * /checks/history — full Check History (manager-only). Every check ever written, most-recent first,
 * with the accounting + print state the CFO/owner cares about. Each row links to a per-check detail
 * page for the complete audit timeline. Read-only; no bank/routing data is ever shown.
 */
import { redirect } from 'next/navigation'
import { managerActor } from '@/apps/checks/authz'
import { listRecentChecks } from '@/apps/checks/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fmt = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const qbBadge = (s: string) => s === 'recorded' ? 'bg-emerald-100 text-emerald-700' : s === 'failed' ? 'bg-red-100 text-red-700' : s === 'voided' ? 'bg-neutral-200 text-neutral-600' : 'bg-amber-100 text-amber-700'
const printBadge = (s: string) => s === 'printed' ? 'bg-emerald-100 text-emerald-700' : s === 'print_failed' ? 'bg-red-100 text-red-700' : 'bg-neutral-100 text-neutral-500'

export default async function CheckHistoryPage() {
  const actor = await managerActor()
  if (!actor) redirect('/auto-sales/login?next=/checks/history')

  const checks = await listRecentChecks(200)

  return (
    <div className="mx-auto min-h-screen max-w-3xl bg-neutral-50 px-4 pb-16 pt-6">
      <header className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-bold">Check History</h1>
        <a href="/checks" className="text-sm text-neutral-500 underline">← Write a Check</a>
      </header>

      {checks.length === 0 ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">No checks written yet.</p>
      ) : (
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {checks.map((c) => (
            <a key={c.id} href={`/checks/${c.id}`} className="block px-4 py-3 hover:bg-neutral-50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate">
                    <span className="font-semibold">#{c.checkNumber}</span> · {c.payeeName}
                    {c.entity === 'auto_sales' && <span className="ml-2 rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">Auto Sales</span>}
                  </div>
                  <div className="truncate text-xs text-neutral-500">
                    {c.checkDate} · {c.categoryLabel}{c.memo ? ` · ${c.memo}` : ''} · by {c.actorName ?? '—'}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={`rounded px-1.5 py-0.5 ${qbBadge(c.qbStatus)}`}>QB {c.qbStatus}{c.qboDocNumber ? ` · #${c.qboDocNumber}` : ''}</span>
                    <span className={`rounded px-1.5 py-0.5 ${printBadge(c.printStatus)}`}>{c.printStatus.replace('_', ' ')}{c.reprintCount > 0 ? ` · ${c.reprintCount} reprint${c.reprintCount > 1 ? 's' : ''}` : ''}</span>
                  </div>
                </div>
                <div className="whitespace-nowrap text-right font-semibold tabular-nums">{fmt(c.amountCents)}</div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
