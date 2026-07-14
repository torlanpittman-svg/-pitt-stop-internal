'use client'

import { useState, useTransition } from 'react'
import type { InvoiceBatchRow, PittStopBatchStatus } from '@/apps/vehicle-entry/invoice-db'
import type { DealershipRow } from '@/apps/vehicle-entry/db'

type BatchWithCounts = InvoiceBatchRow & { vehicleCount: number; pendingCount: number }

const STATUS_LABELS: Record<PittStopBatchStatus, string> = {
  draft:     'Draft',
  active:    'Active',
  finalized: 'Finalized',
  closed:    'Closed',
  cancelled: 'Cancelled',
}

const STATUS_COLORS: Record<PittStopBatchStatus, string> = {
  draft:     'bg-gray-700 text-gray-300 border-gray-600',
  active:    'bg-green-900/60 text-green-300 border-green-700',
  finalized: 'bg-blue-900/60 text-blue-300 border-blue-700',
  closed:    'bg-gray-800 text-gray-500 border-gray-700',
  cancelled: 'bg-red-900/40 text-red-400 border-red-800',
}

function fmt(d: Date | string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function StatusBadge({ status }: { status: PittStopBatchStatus }) {
  const cls = STATUS_COLORS[status] ?? STATUS_COLORS.draft
  return (
    <span className={`inline-flex items-center border rounded-lg px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {STATUS_LABELS[status]}
    </span>
  )
}

export default function InvoiceBatchManager({
  initialBatches,
  dealerships,
}: {
  initialBatches: BatchWithCounts[]
  dealerships: DealershipRow[]
}) {
  const [batches, setBatches] = useState<BatchWithCounts[]>(initialBatches)
  const [showCreate, setShowCreate]   = useState(false)
  const [createForm, setCreateForm]   = useState({ dealershipId: '', quickbooksCustomerId: '' })
  const [createError, setCreateError] = useState<string | null>(null)
  const [syncMsg, setSyncMsg]         = useState<string | null>(null)
  const [isPending, startTransition]  = useTransition()

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreateError(null)
    const res = await fetch('/api/vehicle-entry/invoice-batches', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createForm),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setCreateError((j as { error?: string }).error ?? 'Failed to create batch')
      return
    }
    const created = await res.json()
    // Reload batches
    const listRes = await fetch('/api/vehicle-entry/invoice-batches')
    const updated = await listRes.json()
    setBatches(updated)
    setShowCreate(false)
    setCreateForm({ dealershipId: '', quickbooksCustomerId: '' })
    alert(`Created batch with invoice ${created.invoiceNumber}`)
  }

  async function handleStatusChange(batchId: string, newStatus: PittStopBatchStatus) {
    const res = await fetch(`/api/vehicle-entry/invoice-batches/${batchId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pittStopStatus: newStatus }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      alert((j as { error?: string }).error ?? 'Failed to update batch')
      return
    }
    const listRes = await fetch('/api/vehicle-entry/invoice-batches')
    const updated = await listRes.json()
    setBatches(updated)
  }

  async function handleSyncPending(batchId: string) {
    setSyncMsg(null)
    const res = await fetch(`/api/vehicle-entry/invoice-batches/${batchId}/sync-pending`, { method: 'POST' })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setSyncMsg('Error: ' + ((j as { error?: string }).error ?? 'unknown'))
      return
    }
    const j = await res.json()
    const s = j.summary as Record<string, number> ?? {}
    const parts = Object.entries(s).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
    setSyncMsg(`Synced ${j.processed} vehicles: ${parts.join(', ') || 'none'}`)
    // Refresh counts
    const listRes = await fetch('/api/vehicle-entry/invoice-batches')
    const updated = await listRes.json()
    setBatches(updated)
  }

  const activeDealerIds = new Set(
    batches.filter(b => b.pittStopStatus === 'active').map(b => b.dealershipId)
  )

  return (
    <div className="space-y-6">
      {/* Create button */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
        >
          + New Batch
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4"
        >
          <h2 className="text-white font-semibold">Create Invoice Batch</h2>
          <p className="text-gray-400 text-sm">
            Creates a new draft batch and a new mock QB invoice. Activate it to start receiving vehicles.
          </p>

          <div className="space-y-1">
            <label className="text-gray-400 text-xs uppercase tracking-wide">Dealership</label>
            <select
              value={createForm.dealershipId}
              onChange={e => setCreateForm(f => ({ ...f, dealershipId: e.target.value }))}
              required
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select dealership…</option>
              {dealerships.filter(d => d.active).map(d => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.stockPrefix})
                  {activeDealerIds.has(d.id) ? ' — has active batch' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-gray-400 text-xs uppercase tracking-wide">QB Customer ID</label>
            <input
              type="text"
              value={createForm.quickbooksCustomerId}
              onChange={e => setCreateForm(f => ({ ...f, quickbooksCustomerId: e.target.value }))}
              placeholder="e.g. STERLING-AUTO-001"
              required
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-3 text-base font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-gray-500 text-xs px-1">Phase 1: any string. Phase 2+: real QB customer ID.</p>
          </div>

          {createError && (
            <div className="bg-red-900/40 border border-red-700 rounded-xl px-4 py-3 text-red-300 text-sm">
              {createError}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setShowCreate(false); setCreateError(null) }}
              className="flex-1 py-3 rounded-xl border border-gray-600 text-gray-300 font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold"
            >
              Create
            </button>
          </div>
        </form>
      )}

      {/* Sync message */}
      {syncMsg && (
        <div className="bg-gray-800 border border-gray-600 rounded-xl px-4 py-3 text-sm text-gray-300 flex items-start gap-2">
          <span className="text-green-400">✓</span>
          <span>{syncMsg}</span>
          <button onClick={() => setSyncMsg(null)} className="ml-auto text-gray-600 hover:text-gray-400 text-xs">dismiss</button>
        </div>
      )}

      {/* Batch list */}
      {batches.length === 0 ? (
        <div className="bg-gray-800 border border-gray-700 rounded-xl px-6 py-16 text-center">
          <p className="text-gray-400 text-lg font-medium">No invoice batches yet</p>
          <p className="text-gray-600 text-sm mt-2">Create a batch for each dealership to enable QB sync.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {batches.map(batch => (
            <div
              key={batch.id}
              className="bg-gray-800 border border-gray-700 rounded-xl p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-semibold">{batch.dealershipName}</span>
                    <StatusBadge status={batch.pittStopStatus as PittStopBatchStatus} />
                    {batch.pendingCount > 0 && (
                      <span className="bg-orange-900/60 border border-orange-700 text-orange-300 text-xs px-2 py-0.5 rounded-full font-medium">
                        {batch.pendingCount} pending
                      </span>
                    )}
                  </div>
                  <div className="mt-2 space-y-0.5 text-sm text-gray-400">
                    {batch.quickbooksInvoiceNumber && (
                      <div>Invoice: <span className="text-gray-200 font-mono">{batch.quickbooksInvoiceNumber}</span></div>
                    )}
                    {batch.quickbooksCustomerId && (
                      <div>Customer ID: <span className="text-gray-400 font-mono text-xs">{batch.quickbooksCustomerId}</span></div>
                    )}
                    <div>Started: {fmt(batch.batchStartDate)}</div>
                    <div>{batch.vehicleCount} vehicle{batch.vehicleCount !== 1 ? 's' : ''} synced</div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 shrink-0">
                  {batch.pittStopStatus === 'draft' && (
                    <button
                      onClick={() => startTransition(() => { handleStatusChange(batch.id, 'active') })}
                      disabled={isPending}
                      className="text-xs px-3 py-1.5 rounded-lg bg-green-800 hover:bg-green-700 text-green-200 font-semibold transition-colors disabled:opacity-50"
                    >
                      Activate
                    </button>
                  )}
                  {batch.pittStopStatus === 'active' && (
                    <>
                      <button
                        onClick={() => startTransition(() => { handleSyncPending(batch.id) })}
                        disabled={isPending || batch.pendingCount === 0}
                        className="text-xs px-3 py-1.5 rounded-lg bg-blue-800 hover:bg-blue-700 text-blue-200 font-semibold transition-colors disabled:opacity-50"
                      >
                        Sync {batch.pendingCount > 0 ? `${batch.pendingCount} pending` : 'pending'}
                      </button>
                      <button
                        onClick={() => {
                          if (confirm('Finalize this batch? No new vehicles can be added after finalization.')) {
                            startTransition(() => { handleStatusChange(batch.id, 'finalized') })
                          }
                        }}
                        disabled={isPending}
                        className="text-xs px-3 py-1.5 rounded-lg border border-gray-600 hover:border-gray-400 text-gray-300 font-semibold transition-colors disabled:opacity-50"
                      >
                        Finalize
                      </button>
                    </>
                  )}
                  {batch.pittStopStatus === 'finalized' && (
                    <button
                      onClick={() => {
                        if (confirm('Close this batch? This is the final state.')) {
                          startTransition(() => { handleStatusChange(batch.id, 'closed') })
                        }
                      }}
                      disabled={isPending}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-600 hover:border-gray-400 text-gray-300 font-semibold transition-colors disabled:opacity-50"
                    >
                      Close
                    </button>
                  )}
                  {(batch.pittStopStatus === 'draft') && (
                    <button
                      onClick={() => {
                        if (confirm('Cancel this draft batch?')) {
                          startTransition(() => { handleStatusChange(batch.id, 'cancelled') })
                        }
                      }}
                      disabled={isPending}
                      className="text-xs px-3 py-1.5 rounded-lg border border-red-800 hover:border-red-600 text-red-400 font-semibold transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
