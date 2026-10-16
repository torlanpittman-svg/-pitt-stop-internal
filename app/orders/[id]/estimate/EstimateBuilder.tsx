'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import NavHeader from '@/app/components/NavHeader'
import EstimateActions from '@/app/estimates/EstimateActions'
import SwipeRow from '@/app/components/SwipeRow'
import OrderPhotos from '@/app/components/OrderPhotos'
import { saveEstimateEdit, describeEdit, type EstimateEdit, type EstimateViewData, type ServiceView } from './save-feedback'
import ServicePicker from './ServicePicker'
import { PartsList, ReviewNotices } from './PartsReview'

/**
 * Simplified mobile Estimate — "what are we doing, and what are we charging?".
 * One visible service + one editable price, plus one authoritative Work Total.
 * No cost / labor-guide / tax / approval clutter (that infrastructure still exists
 * for the future richer desktop view). Fees are handled separately by the billing
 * engine and never appear here.
 */
type View = EstimateViewData
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
const EDIT_BTN = 'shrink-0 text-blue-400 text-sm font-semibold px-2 py-1 -my-1 active:opacity-70 disabled:opacity-40'

// ── Inline detail editor (area / component) — may be cleared ─────────────────────────
function DetailEditor({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (v: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial)
  return (
    <form className="flex flex-wrap items-center gap-2 w-full mt-2" onSubmit={(e) => { e.preventDefault(); if (text.trim() === initial.trim()) onCancel(); else onSave(text) }}>
      <input aria-label="Area or component" value={text} autoFocus maxLength={120} disabled={busy} placeholder="e.g. passenger seat"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
        className="flex-1 min-w-[10rem] bg-gray-950 border border-gray-600 text-white rounded-lg px-3 py-2 text-base" />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 text-white font-semibold text-sm px-4 py-2 active:opacity-80 disabled:opacity-40">Save</button>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg border border-gray-600 text-gray-200 text-sm px-4 py-2 active:opacity-80 disabled:opacity-40">Cancel</button>
      </div>
    </form>
  )
}

/** What the service is matched to + exactly what the invoice line says. */
function MatchLine({ s, busy, onChange }: { s: ServiceView; busy: boolean; onChange: () => void }) {
  if (s.matchState === 'choose') {
    return <button type="button" onClick={onChange} disabled={busy} className="mt-1 rounded-lg bg-amber-600/25 border border-amber-700/60 px-2.5 py-1 text-amber-200 text-xs font-semibold">Which odor treatment? Choose…</button>
  }
  if (s.matchState === 'unmatched' && s.partLike) {
    return <p className="mt-1 text-amber-300/90 text-xs font-semibold">{s.partLike === 'part' ? 'Looks like a part' : 'Part or labor?'} — review below</p>
  }
  if (s.matchState === 'unmatched') {
    return <button type="button" onClick={onChange} disabled={busy} className="mt-0.5 min-h-10 inline-flex items-center text-amber-300/90 text-xs font-semibold">Not matched to a catalog service — choose…</button>
  }
  return (
    <div className="mt-0.5 min-w-0">
      <p className="text-gray-500 text-xs line-clamp-2 break-words">
        {s.matchState === 'custom' ? 'Custom · ' : s.catalogName && s.catalogName !== s.title ? `${s.catalogName} · ` : ''}{s.description}
      </p>
      {s.matchState === 'matched' && s.qbMapped === false && <p className="text-gray-600 text-[11px]">QuickBooks item pending review — bills as Labor</p>}
      {s.overlapAcknowledged && <p className="text-gray-600 text-[11px]">Kept alongside Complete Odor Treatment on purpose</p>}
    </div>
  )
}

// ── Inline name editor (customer name, service name): explicit Save / Cancel ─────────
// 16px text so iOS doesn't zoom; Enter saves, Escape cancels. Saving the unchanged value just closes.
function NameEditor({ label, initial, busy, onSave, onCancel }: {
  label: string; initial: string; busy: boolean; onSave: (value: string) => void; onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const value = text.replace(/\s+/g, ' ').trim()
  const save = () => { if (!value) return; if (value === initial) onCancel(); else onSave(value) }
  return (
    <form className="flex flex-wrap items-center gap-2 w-full" onSubmit={(e) => { e.preventDefault(); save() }}>
      <input aria-label={label} value={text} autoFocus maxLength={200} disabled={busy}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
        className="flex-1 min-w-[10rem] bg-gray-950 border border-gray-600 text-white rounded-lg px-3 py-2 text-base" />
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !value}
          className="rounded-lg bg-blue-600 text-white font-semibold text-sm px-4 py-2 active:opacity-80 disabled:opacity-40">Save</button>
        <button type="button" onClick={onCancel} disabled={busy}
          className="rounded-lg border border-gray-600 text-gray-200 text-sm px-4 py-2 active:opacity-80 disabled:opacity-40">Cancel</button>
      </div>
    </form>
  )
}

export default function EstimateBuilder({ header, initialView }: { header: Header; initialView: View }) {
  const [view, setView] = useState<View>(initialView)
  const [editingBusy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const busy = editingBusy || actionBusy
  const [err, setErr] = useState<string | null>(null)
  // Explicit save-state so the manager can always tell whether an edit is saving, saved, or failed —
  // and can recover a failed save (Retry) rather than silently losing it.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // What the status line says ("Removing “Wax”…", "“Wax” removed · Saved", "Couldn’t remove …").
  const [saveMsg, setSaveMsg] = useState('')
  // True once any edit in this visit was confirmed by the server — idle then reads "All changes saved".
  const [savedOnce, setSavedOnce] = useState(false)
  // The last attempted save, kept so a failed one can be retried (estimate edit payload or customer name).
  const lastSave = useRef<{ payload: EstimateEdit } | { customerName: string } | null>(null)
  const [customer, setCustomer] = useState(header.customer)
  const [editingCustomer, setEditingCustomer] = useState(false)
  // Bumped after a customer rename so EstimateActions reloads (the send/convert revision changed).
  const [customerRev, setCustomerRev] = useState(0)
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null)
  const [rematchId, setRematchId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  // Every estimate edit saves immediately. "Saved" is shown ONLY after the server confirms the
  // change (see save-feedback.ts); a failure says what wasn't stored and offers Retry.
  const post = useCallback(async (payload: EstimateEdit): Promise<boolean> => {
    lastSave.current = { payload }
    const labels = describeEdit(payload, view)
    setBusy(true); setErr(null); setSaveState('saving'); setSaveMsg(labels.saving)
    try {
      const out = await saveEstimateEdit(header.id, payload)
      if (!out.ok) { setErr(out.error); setSaveMsg(labels.failed); setSaveState('error'); return false }
      setView(out.view); setSaveMsg(labels.saved); setSaveState('saved'); setSavedOnce(true)
      return true
    } finally { setBusy(false) }
  }, [header.id, view])

  // Leaving while a save is in flight or after one failed would lose the change silently — warn.
  useEffect(() => {
    if (saveState !== 'saving' && saveState !== 'error') return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [saveState])

  // A successful save shows "Saved" briefly, then returns to idle. An error stays until resolved.
  useEffect(() => {
    if (saveState !== 'saved') return
    const t = setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2500)
    return () => clearTimeout(t)
  }, [saveState])

  // Customer name correction (standalone estimates) — same records/ids, via the estimate's locked action route.
  const saveCustomerName = useCallback(async (name: string): Promise<void> => {
    lastSave.current = { customerName: name }
    setBusy(true); setErr(null); setSaveState('saving'); setSaveMsg('Saving customer name…')
    try {
      const res = await fetch(`/api/estimates/${header.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'customer_name', name }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d.error ?? `The server returned an error (${res.status}).`); setSaveMsg('Couldn’t save the customer name — the old name is still saved.'); setSaveState('error'); return }
      setCustomer(d.customerName || name); setEditingCustomer(false); setCustomerRev((n) => n + 1)
      setSaveMsg('Customer name saved'); setSaveState('saved'); setSavedOnce(true)
    } catch { setErr('No connection — check the internet and try again.'); setSaveMsg('Couldn’t save the customer name — the old name is still saved.'); setSaveState('error') } finally { setBusy(false) }
  }, [header.id])

  const saveServiceName = useCallback(async (serviceId: string, title: string) => {
    if (await post({ action: 'rename_service', serviceId, title })) setEditingServiceId(null)
  }, [post])

  const retryLastSave = useCallback(() => {
    const last = lastSave.current
    if (!last) return
    if ('payload' in last) void post(last.payload)
    else void saveCustomerName(last.customerName)
  }, [post, saveCustomerName])

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
          {editingCustomer ? (
            <div className="mt-2">
              <NameEditor label="Customer name" initial={customer} busy={busy}
                onSave={saveCustomerName} onCancel={() => setEditingCustomer(false)} />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <p className="text-gray-400 min-w-0 break-words">{customer} · {header.vehicle}</p>
              {header.standalone && (
                <button onClick={() => setEditingCustomer(true)} disabled={busy} aria-label="Edit customer name" className={EDIT_BTN}>Edit</button>
              )}
            </div>
          )}
          {header.notes && <p className="text-gray-500 text-sm mt-2 whitespace-pre-wrap">{header.notes}</p>}
        </div>
        {/* Save status — edits save automatically. Saving/Saved are a quiet line (Saved appears only
            after the server confirms); a failure is a prominent red card that says what wasn't stored,
            why, and offers Retry. Sticky so it stays visible after scrolling on mobile. */}
        <div role="status" aria-live="polite" className="sticky top-2 z-20 mb-3 min-h-[1.75rem]">
          {saveState === 'error' ? (
            <div className="rounded-xl border border-red-800/70 bg-red-950/60 px-4 py-2.5 text-sm text-red-200 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">{saveMsg || 'Couldn’t save your change.'}</p>
                {err && <p className="text-red-300/80 text-xs mt-0.5 break-words">{err}</p>}
              </div>
              <button onClick={retryLastSave} disabled={busy}
                className="shrink-0 rounded-lg bg-red-600 text-white font-semibold px-3 py-1.5 active:opacity-80 disabled:opacity-50">
                Retry
              </button>
            </div>
          ) : (saveState !== 'idle' || savedOnce) && (
            <p className={`inline-flex items-center gap-1.5 rounded-full bg-gray-950/90 px-2.5 py-1 text-xs ${saveState === 'saved' ? 'text-green-400' : 'text-gray-400'}`}>
              {saveState === 'saving' && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-pulse" />}
              {saveState === 'saved' && <span aria-hidden>✓</span>}
              {saveState === 'saving' ? saveMsg || 'Saving…' : saveState === 'saved' ? saveMsg || 'Saved' : 'All changes saved'}
            </p>
          )}
        </div>

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
          {services.map((s) => rematchId === s.id ? (
            <ServicePicker key={s.id} orderId={header.id} mode="rematch" service={s} busy={busy} isFlat={isFlat} vehicleLabel={header.vehicle} canManage
              onSave={post} onClose={() => setRematchId(null)} />
          ) : editingServiceId === s.id ? (
            <div key={s.id} className={`${ROW_CONTENT} rounded-2xl`}>
              <NameEditor label="Service name" initial={s.title} busy={busy}
                onSave={(title) => saveServiceName(s.id, title)} onCancel={() => setEditingServiceId(null)} />
            </div>
          ) : (
            <SwipeRow key={s.id} busy={busy} contentClassName={ROW_CONTENT} onRemove={() => post({ action: 'remove_service', serviceId: s.id })}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1 min-w-0">
                  <p className="font-semibold truncate">{s.title}</p>
                  <button onClick={() => setEditingServiceId(s.id)} disabled={busy} aria-label={`Edit service name ${s.title}`} className={EDIT_BTN}>Edit</button>
                </div>
                <MatchLine s={s} busy={busy} onChange={() => setRematchId(s.id)} />
                {detailId === s.id ? (
                  <DetailEditor initial={s.detail ?? ''} busy={busy} onCancel={() => setDetailId(null)}
                    onSave={(detail) => { void post({ action: 'set_detail', serviceId: s.id, detail }).then((ok) => { if (ok) setDetailId(null) }) }} />
                ) : (
                  <div className="flex gap-3 text-xs mt-0.5">
                    <button onClick={() => setDetailId(s.id)} disabled={busy} className="text-blue-400/90 font-semibold min-h-10 px-1 inline-flex items-center" aria-label={`Area or component for ${s.title}`}>{s.detail ? `Area: ${s.detail}` : '+ Area'}</button>
                    {s.matchState !== 'choose' && s.matchState !== 'unmatched' && <button onClick={() => setRematchId(s.id)} disabled={busy} className="text-blue-400/90 font-semibold min-h-10 px-1 inline-flex items-center" aria-label={`Change service for ${s.title}`}>Change</button>}
                  </div>
                )}
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

        {/* Parts (special order) with installation-labor review */}
        <div className="mt-3"><PartsList parts={view.parts ?? []} services={services} busy={busy} post={post} /></div>

        {/* Add service / part — shortcuts, rushed wording interpreted, full catalog, custom */}
        <div className="mt-3">
          <ServicePicker orderId={header.id} mode="add" busy={busy} isFlat={isFlat} vehicleLabel={header.vehicle} canManage onSave={post} />
        </div>

        {/* Needs review before sending / invoicing (drafts still save) */}
        {view.review && view.review.issues.length > 0 && (
          <div className="mt-4"><ReviewNotices issues={view.review.issues} services={services} busy={busy} post={post} onChooseOdor={(id) => setRematchId(id)} /></div>
        )}

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
        {header.standalone && <EstimateActions key={`${customerRev}:${JSON.stringify(view)}`} id={header.id} editorBusy={editingBusy} onBusyChange={setActionBusy} />}
      </div>
    </main>
  )
}
