'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import NavHeader from '@/app/components/NavHeader'
import EstimateActions from '@/app/estimates/EstimateActions'
import SwipeRow from '@/app/components/SwipeRow'
import OrderPhotos from '@/app/components/OrderPhotos'

/**
 * Simplified mobile Estimate — "what are we doing, and what are we charging?".
 * One visible service + one editable price, plus one authoritative Work Total.
 * No cost / labor-guide / tax / approval clutter (that infrastructure still exists
 * for the future richer desktop view). Fees are handled separately by the billing
 * engine and never appear here.
 */
interface ServiceView { id: string; title: string; priceCents: number | null; suggestedCents: number | null }
interface View { exists: boolean; flat: boolean; workTotalCents: number; services: ServiceView[]; incomplete: boolean; referenceCents: number | null }
interface VehicleDetails { vin: string | null; color: string | null; licensePlate: string | null; bodyClass: string | null }
interface Header { vehicleDetails: VehicleDetails; id: string; customer: string; vehicle: string; requested: string[]; standalone?: boolean; notes?: string | null }

const dollars = (c: number) => (c / 100).toFixed(2)
const parseDollars = (s: string): number => Math.max(0, Math.round((parseFloat(s.replace(/[^0-9.]/g, '')) || 0) * 100))

// ── Inline price field: commits on blur / Enter, never per-keystroke ──────────────
function PriceInput({ cents, onCommit, busy, big }: { cents: number | null; onCommit: (c: number) => void; busy: boolean; big?: boolean }) {
  const [text, setText] = useState(cents != null ? dollars(cents) : '')
  const [editing, setEditing] = useState(false)
  // Keep in sync when the server value changes and we're not actively editing.
  if (!editing && cents != null && text !== dollars(cents)) setText(dollars(cents))
  const commit = () => {
    setEditing(false)
    // An empty field is "untouched" — never coerce it to $0. This keeps an unpriced service
    // distinct from an explicitly-entered $0 (a free service): typing "0" commits $0; focusing
    // and leaving a blank field commits nothing.
    if (text.trim() === '') return
    const c = parseDollars(text)
    if (c !== (cents ?? -1)) onCommit(c)
  }
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
  const [editingBusy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const busy = editingBusy || actionBusy
  const [err, setErr] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newPrice, setNewPrice] = useState('')
  // Explicit save-state so the manager can always tell whether an edit is saving, saved, or failed —
  // and can recover a failed save (Retry) rather than silently losing it.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const lastPayload = useRef<Record<string, unknown> | null>(null)

  const post = useCallback(async (payload: Record<string, unknown>) => {
    lastPayload.current = payload
    setBusy(true); setErr(null); setSaveState('saving')
    try {
      const res = await fetch(`/api/workflow/orders/${header.id}/estimate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        // keepalive lets a price save initiated on blur finish even if the page is then unloaded
        // (tab close / hard refresh / mobile backgrounding). It is a backstop, NOT a guarantee — the
        // save-state banner + Retry below are the authoritative "did it save?" signal.
        keepalive: true,
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Action failed'); setSaveState('error'); return }
      if (d.view) setView(d.view)
      setSaveState('saved')
    } catch { setErr('Network error'); setSaveState('error') } finally { setBusy(false) }
  }, [header.id])

  // A successful save shows "Saved" briefly, then returns to idle. An error stays until resolved.
  useEffect(() => {
    if (saveState !== 'saved') return
    const t = setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1600)
    return () => clearTimeout(t)
  }, [saveState])

  const retryLastSave = useCallback(() => { if (lastPayload.current) void post(lastPayload.current) }, [post])

  const services = view.services
  const isFlat = view.flat
  const hasPricedService = services.some((s) => (s.priceCents ?? 0) > 0)
  // The itemized Work Total is DERIVED (the sum of the service prices) — show it read-only once
  // any service is priced, so editing it can never silently redistribute money across services.
  // A flat Job, or a fresh itemized Job with no prices yet, can still take a quick single Work
  // Total (which is stored as a flat price).
  const totalEditable = isFlat || !hasPricedService

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={header.standalone ? { href: '/estimates', label: 'Estimates' } : { href: `/orders/${header.id}`, label: 'Job' }} />
      <div className="max-w-xl mx-auto px-4 py-5">
        <div className="mb-4">
          <h1 className="text-2xl font-bold">Estimate</h1>
          <p className="text-gray-400 text-sm">{header.customer} · {header.vehicle}</p>
          {header.notes && <p className="text-gray-500 text-sm mt-2 whitespace-pre-wrap">{header.notes}</p>}
        </div>
        {/* Save-state banner — always tells the manager whether the last edit is saving, saved, or
            failed, and offers Retry so a failed save is never silently lost. Sticky so it's visible
            even after scrolling on mobile. */}
        {saveState !== 'idle' && (
          <div
            role="status"
            aria-live="polite"
            className={`sticky top-2 z-20 mb-3 rounded-xl px-4 py-2.5 text-sm flex items-center justify-between gap-3 border ${
              saveState === 'saving' ? 'border-gray-700 bg-gray-800 text-gray-200'
                : saveState === 'saved' ? 'border-green-800/70 bg-green-950/40 text-green-300'
                : 'border-red-800/70 bg-red-950/40 text-red-300'
            }`}
          >
            <span className="font-medium">
              {saveState === 'saving' && 'Saving…'}
              {saveState === 'saved' && 'Saved ✓'}
              {saveState === 'error' && `Couldn’t save — your change isn’t stored${err ? ` (${err})` : ''}.`}
            </span>
            {saveState === 'error' && (
              <button onClick={retryLastSave} disabled={busy}
                className="shrink-0 rounded-lg bg-red-600 text-white font-semibold px-3 py-1.5 active:opacity-80 disabled:opacity-50">
                Retry
              </button>
            )}
          </div>
        )}

        <section aria-label="Vehicle information" className="mb-5 rounded-2xl border border-gray-800 bg-gray-900 p-4">
          <h2 className="font-semibold text-white mb-3">Vehicle information</h2>
          <dl className="space-y-3 text-sm">
            <div><dt className="text-gray-500">Vehicle</dt><dd className="text-gray-200">{header.vehicle}</dd></div>
            <div><dt className="text-gray-500">VIN</dt><dd className="font-mono text-base text-white select-all break-all">{header.vehicleDetails.vin || 'Not recorded'}</dd></div>
            <div className="grid grid-cols-2 gap-4">
              <div><dt className="text-gray-500">Color</dt><dd className="text-gray-200 break-words">{header.vehicleDetails.color || 'Not recorded'}</dd></div>
              <div><dt className="text-gray-500">License plate</dt><dd className="text-gray-200 select-all break-words">{header.vehicleDetails.licensePlate || 'Not recorded'}</dd></div>
            </div>
            {header.vehicleDetails.bodyClass && <div><dt className="text-gray-500">Body style</dt><dd className="text-gray-200">{header.vehicleDetails.bodyClass}</dd></div>}
          </dl>
          <div className="mt-4"><OrderPhotos orderId={header.id} /></div>
        </section>

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

        {/* Incomplete-pricing banner: a flat amount was agreed, but not every service is priced yet.
            We keep the agreed amount as a clearly-labeled REFERENCE and never present the partial
            running sum as the customer total. */}
        {view.incomplete && view.referenceCents != null && (
          <div className="mt-4 rounded-2xl border border-amber-800/70 bg-amber-950/30 px-4 py-3">
            <p className="text-amber-300 text-sm font-semibold">Pricing incomplete</p>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-amber-200/80">Agreed amount (reference)</span>
              <span className="text-amber-100 font-bold tabular-nums">${dollars(view.referenceCents)}</span>
            </div>
            <p className="text-amber-200/60 text-xs mt-2">Enter a price for every service so the breakdown adds up. Until then the amounts below are a partial total, not the agreed amount — the invoice can’t be created yet.</p>
          </div>
        )}

        {/* Reconcile banner: every service is now priced, but the itemized total differs from the
            agreed amount. Show the difference explicitly and require the manager to accept the new
            total — completing itemization never silently replaces the agreed amount. */}
        {!view.incomplete && view.referenceCents != null && (
          <div className="mt-4 rounded-2xl border border-amber-800/70 bg-amber-950/30 px-4 py-3">
            <p className="text-amber-300 text-sm font-semibold">Itemized total differs from the agreed amount</p>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-amber-200/80">Agreed amount</span>
              <span className="text-amber-100 tabular-nums">${dollars(view.referenceCents)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-amber-200/80">Itemized total</span>
              <span className="text-amber-100 font-bold tabular-nums">${dollars(view.workTotalCents)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-amber-200/80">Difference</span>
              <span className="text-amber-100 tabular-nums">{view.workTotalCents >= view.referenceCents ? '+' : '−'}${dollars(Math.abs(view.workTotalCents - view.referenceCents))}</span>
            </div>
            <button onClick={() => post({ action: 'accept_total' })} disabled={busy}
              className="mt-3 w-full bg-amber-600 text-white font-semibold text-sm py-2.5 rounded-xl active:opacity-80 disabled:opacity-40">
              Use itemized total ${dollars(view.workTotalCents)}
            </button>
            <p className="text-amber-200/60 text-xs mt-2">Or edit a service price above so the breakdown matches the agreed amount. The invoice can’t be created until this is resolved.</p>
          </div>
        )}

        {/* Work Total */}
        <div className="mt-4 rounded-2xl bg-gray-900 border border-gray-800 px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white font-bold text-lg">{view.incomplete ? 'Itemized so far' : 'Work Total'}</p>
              {isFlat && <p className="text-gray-500 text-xs">Flat price · edit a service price to itemize</p>}
              {view.incomplete && <p className="text-amber-400/80 text-xs">Partial — some services still need a price</p>}
              {!isFlat && !view.incomplete && hasPricedService && <p className="text-gray-500 text-xs">Sum of service prices · edit a service to change it</p>}
            </div>
            {totalEditable ? (
              <PriceInput cents={view.workTotalCents} busy={busy} big
                onCommit={(c) => post({ action: 'set_work_total', cents: c })} />
            ) : (
              <div className="flex items-center">
                <span className="text-gray-500 text-lg">$</span>
                <span className={`text-2xl font-bold tabular-nums w-32 text-right pr-px ${view.incomplete ? 'text-amber-300' : 'text-white'}`}>{dollars(view.workTotalCents)}</span>
              </div>
            )}
          </div>
          {isFlat && services.length > 0 && (
            <button onClick={() => post({ action: 'itemize' })} disabled={busy}
              className="mt-3 text-blue-400 text-sm font-semibold active:opacity-70 disabled:opacity-40">Set individual prices →</button>
          )}
          <p className="text-gray-600 text-xs mt-3">Work price only. Shop supplies, card charge, and tax are included in the customer total separately.</p>
        </div>
        {header.standalone && <EstimateActions key={JSON.stringify(view)} id={header.id} editorBusy={editingBusy} onBusyChange={setActionBusy} />}
      </div>
    </main>
  )
}
