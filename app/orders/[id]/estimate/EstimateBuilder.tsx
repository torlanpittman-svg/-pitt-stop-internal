'use client'

import { useState, useCallback } from 'react'
import NavHeader from '@/app/components/NavHeader'
import SwipeRow from '@/app/components/SwipeRow'

/**
 * Simplified mobile Estimate — "what are we doing, and what are we charging?".
 * One visible service + one editable price, plus one authoritative Work Total.
 * No cost / labor-guide / tax / approval clutter (that infrastructure still exists
 * for the future richer desktop view). Fees are handled separately by the billing
 * engine and never appear here.
 */
interface ServiceView { id: string; title: string; priceCents: number | null; suggestedCents: number | null }
interface View { exists: boolean; flat: boolean; workTotalCents: number; services: ServiceView[] }
interface Header { id: string; customer: string; vehicle: string; requested: string[] }

const dollars = (c: number) => (c / 100).toFixed(2)
const parseDollars = (s: string): number => Math.max(0, Math.round((parseFloat(s.replace(/[^0-9.]/g, '')) || 0) * 100))

// ── Inline price field: commits on blur / Enter, never per-keystroke ──────────────
function PriceInput({ cents, onCommit, busy, big }: { cents: number | null; onCommit: (c: number) => void; busy: boolean; big?: boolean }) {
  const [text, setText] = useState(cents != null ? dollars(cents) : '')
  const [editing, setEditing] = useState(false)
  // Keep in sync when the server value changes and we're not actively editing.
  if (!editing && cents != null && text !== dollars(cents)) setText(dollars(cents))
  const commit = () => { setEditing(false); const c = parseDollars(text); if (c !== (cents ?? -1)) onCommit(c) }
  return (
    <div className="flex items-center">
      <span className={`text-gray-500 ${big ? 'text-lg' : ''}`}>$</span>
      <input
        value={text} inputMode="decimal" placeholder="0.00" disabled={busy}
        onFocus={(e) => { setEditing(true); e.currentTarget.select() }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        className={`bg-transparent text-right text-white tabular-nums outline-none focus:border-b focus:border-gray-500 ${big ? 'text-2xl font-bold w-32' : 'text-base w-20'}`}
      />
    </div>
  )
}

// Foreground card style for Estimate service rows (shared SwipeRow provides the swipe).
const ROW_CONTENT = 'flex items-center gap-3 bg-gray-900 border border-gray-800 px-4 py-3.5'

export default function EstimateBuilder({ header, initialView }: { header: Header; initialView: View }) {
  const [view, setView] = useState<View>(initialView)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newPrice, setNewPrice] = useState('')

  const post = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${header.id}/estimate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Action failed'); return }
      if (d.view) setView(d.view)
    } catch { setErr('Network error') } finally { setBusy(false) }
  }, [header.id])

  const services = view.services
  const isFlat = view.flat

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: `/orders/${header.id}`, label: 'Job' }} />
      <div className="max-w-xl mx-auto px-4 py-5">
        <div className="mb-4">
          <h1 className="text-2xl font-bold">Estimate</h1>
          <p className="text-gray-400 text-sm">{header.customer} · {header.vehicle}</p>
        </div>
        {err && <p className="text-red-400 text-sm mb-3">{err}</p>}

        {/* Services */}
        <div className="space-y-2">
          {services.map((s) => (
            <SwipeRow key={s.id} busy={busy} contentClassName={ROW_CONTENT} onRemove={() => post({ action: 'remove_service', serviceId: s.id })}>
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate">{s.title}</p>
                {!isFlat && s.suggestedCents != null && s.priceCents !== s.suggestedCents && (
                  <button onClick={() => post({ action: 'set_service_price', serviceId: s.id, cents: s.suggestedCents })}
                    className="text-gray-500 text-xs active:opacity-70">Suggested ${dollars(s.suggestedCents)}</button>
                )}
              </div>
              {!isFlat && (
                <PriceInput cents={s.priceCents} busy={busy}
                  onCommit={(c) => post({ action: 'set_service_price', serviceId: s.id, cents: c })} />
              )}
            </SwipeRow>
          ))}
          {services.length === 0 && <p className="text-gray-600 text-sm py-4 text-center">No services yet.</p>}
        </div>

        {/* Add service */}
        <div className="mt-3 flex gap-2">
          <input className="flex-1 bg-gray-900 border border-gray-800 text-white rounded-xl px-3 py-2.5 text-sm"
            placeholder="+ Add service" value={newName} onChange={(e) => setNewName(e.target.value)} />
          {!isFlat && (
            <input className="w-24 bg-gray-900 border border-gray-800 text-white rounded-xl px-3 py-2.5 text-sm"
              placeholder="$ price" inputMode="decimal" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
          )}
          <button
            onClick={() => {
              const title = newName.trim(); if (!title) return
              const payload: Record<string, unknown> = { action: 'add_service', title }
              if (!isFlat && newPrice.trim()) payload.cents = parseDollars(newPrice)
              post(payload); setNewName(''); setNewPrice('')
            }}
            disabled={busy || !newName.trim()}
            className="bg-gray-800 border border-gray-700 rounded-xl px-4 text-sm font-semibold disabled:opacity-40">Add</button>
        </div>

        {/* Work Total (authoritative) */}
        <div className="mt-6 rounded-2xl bg-gray-900 border border-gray-800 px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white font-bold text-lg">Work Total</p>
              {isFlat && <p className="text-gray-500 text-xs">Flat price · edit a service price to itemize</p>}
            </div>
            <PriceInput cents={view.workTotalCents} busy={busy} big
              onCommit={(c) => post({ action: 'set_work_total', cents: c })} />
          </div>
          {isFlat && services.length > 0 && (
            <button onClick={() => post({ action: 'itemize' })} disabled={busy}
              className="mt-3 text-blue-400 text-sm font-semibold active:opacity-70 disabled:opacity-40">Set individual prices →</button>
          )}
          <p className="text-gray-600 text-xs mt-3">Work price only. Shop supplies, card charge, and tax are added on the invoice.</p>
        </div>
      </div>
    </main>
  )
}
