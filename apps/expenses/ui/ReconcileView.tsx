/**
 * Reconcile — the shared, READ-ONLY view (server component). Rendered at /expenses/reconcile (managers: the
 * receipt-side queues) and /admin/finance/reconcile (owner/admin: plus bank-transaction and expected-bill
 * detail). Items are things to REVIEW, not proof of an error.
 */
import Link from 'next/link'
import { REVIEW_KIND_LABEL, type Queue, type Reconciliation, type ReviewKind, type SourceStatus } from '@/apps/expenses/reconcile'

const money = (c: number | null) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const KIND_TONE: Record<ReviewKind, string> = {
  timing: 'border-sky-900/60 bg-sky-950/30 text-sky-300',
  source_unavailable: 'border-gray-700 bg-gray-800/60 text-gray-300',
  to_review: 'border-amber-900/60 bg-amber-950/30 text-amber-300',
  discrepancy: 'border-red-900/60 bg-red-950/30 text-red-300',
}
const SOURCE_TONE: Record<SourceStatus['state'], string> = { ok: 'text-emerald-300', stale: 'text-amber-300', partial: 'text-sky-300', unavailable: 'text-gray-400' }
const SOURCE_WORD: Record<SourceStatus['state'], string> = { ok: 'Current', stale: 'Out of date', partial: 'Partial', unavailable: 'Not available' }

export default function ReconcileView({ data, basePath, backHref, backLabel, ownerHref, children }: {
  data: Reconciliation; basePath: string; backHref: string; backLabel: string
  children?: React.ReactNode   // owner-only sections rendered above the queues
  ownerHref?: string   // where the owner sees the bank + bill detail (shown only when this view is restricted)
}) {
  const days = data.days
  const open = data.queues.filter((q) => !q.restricted).reduce((s, q) => s + q.count, 0)
  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-white">Reconcile</h1>
        <Link href={backHref} className="text-gray-400 text-sm py-2">‹ {backLabel}</Link>
      </div>
      <p className="text-gray-400 text-sm">{open} item{open === 1 ? '' : 's'} to look at from the last {data.days} days. These are things to review, not proof of a mistake.</p>
      <nav aria-label="Time window" className="flex gap-2 mt-3 mb-5">
        {[30, 60, 90].map((d) => (
          <Link key={d} href={`${basePath}?days=${d}`} aria-current={d === days ? 'page' : undefined}
            className={`px-3 py-2 rounded-full text-sm border ${d === days ? 'bg-gray-800 text-white border-gray-600' : 'bg-gray-900 text-gray-400 border-gray-800'}`}>{d} days</Link>
        ))}
      </nav>

      <section aria-labelledby="sources-title" className="rounded-2xl bg-gray-900 border border-gray-800 p-4 mb-5">
        <h2 id="sources-title" className="text-white font-semibold">How current each source is</h2>
        <ul className="mt-2 space-y-3">
          {data.sources.map((s) => (
            <li key={s.key}>
              <p className="text-sm"><span className="text-gray-200 font-semibold">{s.label}</span> <span className={`${SOURCE_TONE[s.state]} text-xs`}>· {SOURCE_WORD[s.state]}</span></p>
              <p className="text-gray-400 text-xs mt-0.5 break-words">{s.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      {children}

      <div className="space-y-4">
        {data.queues.map((q) => <QueueCard key={q.key} q={q} ownerHref={ownerHref} />)}
      </div>
      <p className="text-gray-600 text-xs mt-6">A receipt, its bank payment, its job and its QuickBooks record are four views of one purchase. Linking them here never adds an expense.</p>
    </main>
  )
}

function QueueCard({ q, ownerHref }: { q: Queue; ownerHref?: string }) {
  return (
    <section aria-labelledby={`q-${q.key}`} className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={`q-${q.key}`} className="text-white font-semibold">{q.title}</h2>
        {!q.restricted && <p className="shrink-0 text-sm text-gray-300 tabular-nums">{q.count}{q.totalCents != null && q.count > 0 ? ` · ${money(q.totalCents)}` : ''}</p>}
      </div>
      <p className="text-gray-500 text-xs mt-1">{q.explain}</p>
      {q.restricted && <p className="text-gray-400 text-sm mt-3">Bank and bill detail is on the owner’s finance page{ownerHref ? <> — <Link href={ownerHref} className="underline text-indigo-300">open the owner view</Link> (admin password)</> : null}.</p>}
      {!q.restricted && q.count === 0 && <p className="text-gray-500 text-sm mt-3">Nothing to review.</p>}
      {!q.restricted && q.count > 0 && (
        <>
          <p className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
            {(Object.keys(q.byKind) as ReviewKind[]).map((k) => <span key={k} className={`rounded-full border px-2 py-0.5 ${KIND_TONE[k]}`}>{q.byKind[k]} · {REVIEW_KIND_LABEL[k]}</span>)}
          </p>
          <details className="mt-2" open={q.count <= 5}>
            <summary className="text-indigo-300 text-sm cursor-pointer py-2">Show {q.items.length < q.count ? `the latest ${q.items.length} of ${q.count}` : `all ${q.count}`}</summary>
            <ul className="mt-1 divide-y divide-gray-800">
              {q.items.map((i) => (
                <li key={i.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm text-gray-100 break-words">{i.href ? <Link href={i.href} className="underline decoration-gray-600">{i.title}</Link> : i.title}</p>
                    <p className="shrink-0 text-sm text-gray-200 tabular-nums">{money(i.amountCents)}</p>
                  </div>
                  <p className="text-gray-500 text-xs break-words">{[i.date, i.detail].filter(Boolean).join(' · ')}</p>
                  <p className="text-xs mt-1"><span className={`rounded-full border px-2 py-0.5 text-[11px] ${KIND_TONE[i.kind]}`}>{REVIEW_KIND_LABEL[i.kind]}</span></p>
                  <p className="text-gray-400 text-xs mt-1 break-words">{i.why}</p>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
