/**
 * /checks/[id] — inspect a single check (manager-only): every field, the resolved customer-vehicle /
 * Auto Sales link, the QuickBooks reference, print/reprint state, and the full append-only audit
 * timeline. Controlled actions (reprint, retry QuickBooks) reuse the same guarded endpoints as the
 * write flow — a reprint never creates a second QuickBooks transaction. Read-only accounting data;
 * no bank/routing secrets.
 */
import { redirect, notFound } from 'next/navigation'
import { managerActor } from '@/apps/checks/authz'
import { getCheckView, checkEventHistory } from '@/apps/checks/db'
import { resolveLinkLabel } from '@/apps/checks/links'
import CheckDetailActions from './CheckDetailActions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fmt = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default async function CheckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await managerActor()
  const { id } = await params
  if (!actor) redirect(`/auto-sales/login?next=/checks/${id}`)

  const check = await getCheckView(id)
  if (!check) notFound()

  const [events, linkLabel] = await Promise.all([
    checkEventHistory(id),
    resolveLinkLabel({ linkedJobId: check.linkedJobId, linkedVehicleId: check.linkedVehicleId }),
  ])

  const rows: Array<[string, React.ReactNode]> = [
    ['Check #', <span className="font-semibold">{check.checkNumber}</span>],
    ['Date', check.checkDate],
    ['Pay to', check.payeeName],
    ['Amount', <span className="font-bold">{fmt(check.amountCents)}</span>],
    ['Purpose', check.memo || '—'],
    ['Category', check.categoryLabel + (check.entity === 'auto_sales' ? ' (Auto Sales — separate books)' : '')],
    ...(linkLabel ? [[check.linkedJobId ? 'Customer vehicle' : 'Auto Sales vehicle', linkLabel] as [string, React.ReactNode]] : []),
    ['Bank account', check.bankLabel],
    ['QuickBooks', check.qbStatus === 'recorded'
      ? `Recorded · Purchase ${check.qboTxnId ?? ''}${check.qboDocNumber ? ` · DocNumber #${check.qboDocNumber}` : ''}`
      : check.qbStatus === 'failed' ? `Failed${check.qbError ? ` · ${check.qbError}` : ''}` : check.qbStatus],
    ['Print status', check.printStatus.replace('_', ' ') + (check.reprintCount > 0 ? ` · ${check.reprintCount} reprint(s)` : '') + (check.printedAt ? ` · ${new Date(check.printedAt).toLocaleString()}` : '')],
    ['Created by', check.actorName ?? '—'],
    ['Created', new Date(check.createdAt).toLocaleString()],
  ]

  return (
    <div className="mx-auto min-h-screen max-w-lg bg-neutral-50 px-4 pb-16 pt-6">
      <header className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-bold">Check #{check.checkNumber}</h1>
        <a href="/checks/history" className="text-sm text-neutral-500 underline">← History</a>
      </header>

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <dl className="space-y-3 text-sm">
          {rows.map(([label, value], i) => (
            <div key={i} className="flex items-start justify-between gap-4">
              <dt className="shrink-0 text-neutral-500">{label}</dt>
              <dd className="break-words text-right">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <CheckDetailActions
        checkId={check.id}
        checkNumber={check.checkNumber}
        qbStatus={check.qbStatus}
        printStatus={check.printStatus}
      />

      <div className="mt-6">
        <p className="mb-2 text-xs uppercase tracking-wide text-neutral-400">Audit timeline</p>
        <ol className="space-y-2">
          {events.map((e) => (
            <li key={e.id} className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{e.action}</span>
                <span className="text-xs text-neutral-400">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
              <div className="text-xs text-neutral-500">
                {e.actor ?? 'system'}
                {e.detail ? ` · ${JSON.stringify(e.detail)}` : ''}
              </div>
            </li>
          ))}
          {events.length === 0 && <li className="text-sm text-neutral-400">No events recorded.</li>}
        </ol>
      </div>
    </div>
  )
}
