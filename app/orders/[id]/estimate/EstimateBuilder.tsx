'use client'

import { useState, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import NavHeader from '@/app/components/NavHeader'
import EstimateActions from '@/app/estimates/EstimateActions'
import OrderPhotos from '@/app/components/OrderPhotos'
import { saveEstimateEdit, describeEdit, type EstimateEdit, type EstimateViewData, type PartView, type ServiceView } from './save-feedback'
import ServicePicker from './ServicePicker'
import { ReviewNotices } from './PartsReview'
import { PartEditor, ServiceEditor } from './ItemEditor'

/**
 * Estimate — "Simple list". One list of services and parts (tap a row to edit it), one Add item
 * button, review warnings only when something needs a decision, and the Work Total. Less frequent
 * actions live in the ⋯ menu. Shared by standalone estimates and job-linked estimates.
 *
 * Saving: editors use explicit Save/Cancel; committed actions (remove, labor decisions, match
 * choices) save immediately. "Saved" appears only after the server confirms (save-feedback.ts); a
 * failure stays visible with Retry, and leaving with unsaved or failed changes asks first.
 * Fees are handled by the billing engine and never appear in the Work Total.
 */
type View = EstimateViewData
interface VehicleDetails { vin: string | null; color: string | null; licensePlate: string | null; bodyClass: string | null }
interface Header {
  vehicleDetails: VehicleDetails; id: string; customer: string; vehicle: string; requested: string[]; standalone?: boolean; notes?: string | null
  /** Cancelled estimate/Job: shown read-only, kept for history. */
  cancelled?: boolean
  /** Created as a quote and never moved to the Work Board (Back goes to Estimates even once cancelled). */
  quoteOnly?: boolean
}
type Pane = { kind: 'list' } | { kind: 'add' } | { kind: 'review' } | { kind: 'customer' } | { kind: 'cancel' }
  | { kind: 'service'; id: string; rematch?: boolean } | { kind: 'part'; id: string }
const LIST: Pane = { kind: 'list' }

const dollars = (c: number) => (c / 100).toFixed(2)
const parseDollars = (s: string): number => Math.max(0, Math.round((parseFloat(s.replace(/[^0-9.]/g, '')) || 0) * 100))
const BTN = 'rounded-xl font-semibold text-sm px-4 py-3 min-h-11 active:opacity-80 disabled:opacity-40'

// ── Work Total field (flat / unpriced estimates): commits on blur / Enter, never per-keystroke ──
function PriceInput({ cents, onCommit, busy }: { cents: number | null; onCommit: (c: number) => void; busy: boolean }) {
  const [text, setText] = useState(cents != null ? dollars(cents) : '')
  const [editing, setEditing] = useState(false)
  // Keep in sync when the server value changes and we're not actively editing.
  if (!editing && cents != null && text !== dollars(cents)) setText(dollars(cents))
  const commit = () => {
    setEditing(false)
    // An empty field is "untouched" — never coerce it to $0.
    if (text.trim() === '') return
    const c = parseDollars(text)
    if (c !== (cents ?? -1)) onCommit(c)
  }
  return (
    <div className="flex items-center rounded-lg border border-gray-700 bg-gray-950 px-2 focus-within:border-blue-500">
      <span className="text-gray-400 text-lg">$</span>
      <input
        aria-label="Work Total" value={text} inputMode="decimal" placeholder="0.00" disabled={busy}
        onFocus={(e) => { setEditing(true); e.currentTarget.select() }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        className="bg-transparent text-right text-white tabular-nums outline-none text-2xl font-bold w-32 py-1.5"
      />
    </div>
  )
}

function NameEditor({ label, initial, busy, onSave, onCancel }: {
  label: string; initial: string; busy: boolean; onSave: (value: string) => void; onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const value = text.replace(/\s+/g, ' ').trim()
  const save = () => { if (!value) return; if (value === initial) onCancel(); else onSave(value) }
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save() }}>
      <label className="block"><span className="text-gray-400 text-sm">{label}</span>
        <input value={text} autoFocus maxLength={200} disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
          className="mt-1.5 w-full bg-gray-950 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-lg font-semibold focus:border-blue-500 focus:outline-none" />
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={`${BTN} border border-gray-600 text-gray-200`}>Cancel</button>
        <button type="submit" disabled={busy || !value} className={`${BTN} flex-1 bg-blue-600 text-white`}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>
  )
}

function Chevron() {
  return <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-400"><path d="m9 18 6-6-6-6" /></svg>
}

/** One tappable line: name, a short sub-line, the price (or what's missing), and a chevron. */
function Row({ id, label, title, badge, sub, price, attention, onOpen }: {
  id: string; label: string; title: string; badge?: ReactNode; sub: ReactNode; price: ReactNode; attention?: string | null; onOpen?: () => void
}) {
  if (!onOpen) {   // read-only (cancelled estimate)
    return (
      <li className="flex min-h-16 items-center gap-3 px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 min-w-0">{badge}<span className="font-semibold text-white break-words min-w-0">{title}</span></span>
          <span className="mt-0.5 block text-xs text-gray-400 break-words">{sub}</span>
        </span>
        <span className="shrink-0 text-right tabular-nums">{price}</span>
      </li>
    )
  }
  return (
    <li>
      <button type="button" data-row={id} onClick={onOpen} aria-label={label}
        className="flex w-full min-h-16 items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/60 active:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 min-w-0">{badge}<span className="font-semibold text-white break-words min-w-0">{title}</span></span>
          <span className="mt-0.5 block text-xs text-gray-400 break-words">{sub}</span>
          {attention && <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-amber-300"><span aria-hidden>●</span>{attention}</span>}
        </span>
        <span className="shrink-0 text-right tabular-nums">{price}</span>
        <Chevron />
      </button>
    </li>
  )
}

function serviceAttention(s: ServiceView): string | null {
  if (s.matchState === 'choose') return 'Choose the service'
  if (s.matchState === 'unmatched' && s.partLike) return s.partLike === 'part' ? 'Looks like a part' : 'Part or labor?'
  if (s.matchState === 'unmatched') return 'Not matched to a catalog service'
  return null
}

export default function EstimateBuilder({ header, initialView }: { header: Header; initialView: View }) {
  const [view, setView] = useState<View>(initialView)
  const viewRef = useRef(view)
  const [editingBusy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const busy = editingBusy || actionBusy
  const [err, setErr] = useState<string | null>(null)
  // Explicit save-state so the manager can always tell whether an edit is saving, saved, or failed —
  // and can recover a failed save (Retry) rather than silently losing it.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // What the status line says ("Removing “Wax”…", "“Wax” removed · Saved", "Couldn’t remove …").
  const [saveMsg, setSaveMsg] = useState('')
  // True once any edit in this visit was confirmed by the server — the header then keeps "Saved".
  const [savedOnce, setSavedOnce] = useState(false)
  // What Retry re-runs: the last request again, or the editor's own Save (which resumes a multi-step save).
  const retryRef = useRef<(() => void) | null>(null)
  // True when that retry belongs to an editor draft (so Cancel may discard it); committed actions never are.
  const retryIsDraft = useRef(false)
  const postRef = useRef<(payload: EstimateEdit, retry?: () => void) => Promise<boolean>>(async () => false)
  const saveCustomerNameRef = useRef<(name: string) => Promise<boolean>>(async () => false)
  const closePaneRef = useRef<() => void>(() => {})
  const cancelEstimateRef = useRef<() => Promise<void>>(async () => {})
  const [customer, setCustomer] = useState(header.customer)
  // Cancelled = read-only history. Set from the page, or once the server confirms "Cancel estimate".
  const [cancelled, setCancelled] = useState(!!header.cancelled)
  const standalone = !!header.standalone && !cancelled
  // Bumped after a customer rename so EstimateActions reloads (the send/convert revision changed).
  const [customerRev, setCustomerRev] = useState(0)
  const [pane, setPane] = useState<Pane>(LIST)
  const paneRef = useRef(pane)
  const [editorDirty, setEditorDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [discardAsk, setDiscardAsk] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [vehicleOpen, setVehicleOpen] = useState(false)
  const opener = useRef<string | null>(null)
  const paneHeading = useRef<HTMLHeadingElement>(null)

  // Every estimate edit is sent at once. "Saved" is shown ONLY after the server confirms the
  // change (see save-feedback.ts); a failure says what wasn't stored and offers Retry.
  const post = useCallback(async (payload: EstimateEdit, retry?: () => void): Promise<boolean> => {
    retryRef.current = retry ?? (() => { void postRef.current(payload) })
    retryIsDraft.current = !!retry
    const labels = describeEdit(payload, viewRef.current)
    setBusy(true); setErr(null); setSaveState('saving'); setSaveMsg(labels.saving)
    try {
      const out = await saveEstimateEdit(header.id, payload)
      if (!out.ok) { setErr(out.error); setSaveMsg(labels.failed); setSaveState('error'); return false }
      setView(out.view); setSaveMsg(labels.saved); setSaveState('saved'); setSavedOnce(true)
      // An item that's now gone (removed, converted to a part) closes its editor.
      const open = paneRef.current
      if ((open.kind === 'service' && !out.view.services.some((x) => x.id === open.id)) || (open.kind === 'part' && !(out.view.parts ?? []).some((x) => x.id === open.id))) closePaneRef.current()
      return true
    } finally { setBusy(false) }
  }, [header.id])

  // A successful save shows its message briefly, then the header settles on "Saved". An error stays.
  useEffect(() => {
    if (saveState !== 'saved') return
    const t = setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2500)
    return () => clearTimeout(t)
  }, [saveState])

  // Leaving while a save is in flight, after one failed, or with unsaved editor changes would lose
  // work silently — warn on reload/close and on in-app links (Back, Home, search results).
  const guardLeave = saveState === 'saving' || saveState === 'error' || editorDirty
  useEffect(() => {
    if (!guardLeave) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.target === '_blank' || e.defaultPrevented) return
      const msg = saveState === 'saving' ? 'A change is still saving. Leave anyway?'
        : saveState === 'error' ? 'A change did not save. Leave without saving it?'
        : 'You have unsaved changes. Leave without saving them?'
      if (!window.confirm(msg)) { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('beforeunload', warn)
    document.addEventListener('click', onClick, true)
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', onClick, true) }
  }, [guardLeave, saveState])

  // Panes (Add, an item editor, Review, Customer) take over the screen. Each one adds a history
  // entry so the phone's Back button returns to the list instead of leaving the estimate; Back with
  // unsaved editor changes asks first.
  const openPane = useCallback((p: Pane, from?: string) => {
    opener.current = from ?? null
    setMenuOpen(false); setDiscardAsk(false); setEditorDirty(false)
    if (paneRef.current.kind === 'list') window.history.pushState({ ...window.history.state, estimatePane: true }, '')
    setPane(p)
  }, [])
  const closePane = useCallback(() => {
    dirtyRef.current = false; setEditorDirty(false); setDiscardAsk(false)
    if (window.history.state?.estimatePane) window.history.back()
    else setPane(LIST)
  }, [])
  useEffect(() => {
    const onPop = () => {
      if (paneRef.current.kind === 'list') return
      if (dirtyRef.current) {
        window.history.pushState({ ...window.history.state, estimatePane: true }, '')
        setDiscardAsk(true)
        return
      }
      setPane(LIST)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // Focus: the pane heading on open; the row (or Add button) that opened it on return.
  useEffect(() => {
    if (pane.kind !== 'list') { paneHeading.current?.focus(); return }
    const id = opener.current
    if (!id) return
    opener.current = null
    const el = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)
    el?.focus()
  }, [pane])
  // The ⋯ menu closes on an outside tap.
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.('[data-estimate-menu]')) setMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuOpen])

  const onEditorClose = useCallback((outcome: 'saved' | 'cancelled' | 'removed') => {
    // Cancelling discards the draft — including one whose save failed — so clear that failure. A failed
    // committed action (remove, labor decision, match) is not a draft: it stays visible with Retry.
    if (outcome === 'cancelled' && retryIsDraft.current) {
      retryRef.current = null; retryIsDraft.current = false
      setSaveState((s) => (s === 'error' ? 'idle' : s))
    }
    closePane()
  }, [closePane])

  // Customer name correction (standalone estimates) — same records/ids, via the estimate's locked action route.
  const saveCustomerName = useCallback(async (name: string): Promise<boolean> => {
    retryIsDraft.current = true
    retryRef.current = () => { void saveCustomerNameRef.current(name).then((ok) => { if (ok && paneRef.current.kind === 'customer') closePaneRef.current() }) }
    setBusy(true); setErr(null); setSaveState('saving'); setSaveMsg('Saving customer name…')
    try {
      const res = await fetch(`/api/estimates/${header.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'customer_name', name }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d.error ?? `The server returned an error (${res.status}).`); setSaveMsg('Couldn’t save the customer name — the old name is still saved.'); setSaveState('error'); return false }
      setCustomer(d.customerName || name); setCustomerRev((n) => n + 1)
      setSaveMsg('Customer name saved'); setSaveState('saved'); setSavedOnce(true)
      return true
    } catch { setErr('No connection — check the internet and try again.'); setSaveMsg('Couldn’t save the customer name — the old name is still saved.'); setSaveState('error'); return false } finally { setBusy(false) }
  }, [header.id])
  // Cancel a standalone estimate directly (soft cancel; never via the Work Board; nothing is sent and any
  // QuickBooks estimate is left as it is). Committed action: a failure stays visible with Retry.
  const cancelEstimate = useCallback(async (): Promise<void> => {
    retryIsDraft.current = false
    retryRef.current = () => { void cancelEstimateRef.current() }
    setBusy(true); setErr(null); setSaveState('saving'); setSaveMsg('Cancelling estimate…')
    try {
      const res = await fetch(`/api/estimates/${header.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.cancelled !== true) { setErr(d.error ?? `The server returned an error (${res.status}).`); setSaveMsg('Couldn’t cancel the estimate — it’s still open.'); setSaveState('error'); return }
      setCancelled(true); setSaveMsg('Estimate cancelled'); setSaveState('saved'); setSavedOnce(true)
      if (paneRef.current.kind === 'cancel') closePaneRef.current()
    } catch { setErr('No connection — check the internet and try again.'); setSaveMsg('Couldn’t cancel the estimate — it’s still open.'); setSaveState('error') } finally { setBusy(false) }
  }, [header.id])
  // Keep the latest values/handlers for event-driven code (popstate, Retry, save confirmations).
  useLayoutEffect(() => {
    viewRef.current = view; paneRef.current = pane; dirtyRef.current = editorDirty
    postRef.current = post; saveCustomerNameRef.current = saveCustomerName; closePaneRef.current = closePane; cancelEstimateRef.current = cancelEstimate
  })
  const retryLastSave = useCallback(() => { retryRef.current?.() }, [])

  const services = view.services
  const parts = view.parts ?? []
  const issues = view.review?.issues ?? []
  const isFlat = view.flat
  const hasPricedService = services.some((s) => (s.priceCents ?? 0) > 0)
  // The itemized Work Total is DERIVED (the sum of the line prices) — read-only once any service is
  // priced, so editing it can never silently redistribute money. A flat Job, or a fresh itemized Job
  // with no prices yet, can still take a quick single Work Total (stored as a flat price).
  const totalEditable = isFlat || !hasPricedService
  const editorPane = pane.kind === 'service' || pane.kind === 'part' || pane.kind === 'customer'

  // ── Header pieces ──────────────────────────────────────────────────────────────────────────────
  const saveBadge = (
    <span role="status" aria-live="polite" className="min-h-5 text-xs">
      {saveState === 'saving' ? <span className="inline-flex items-center gap-1.5 text-gray-300"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gray-300 animate-pulse" />Saving…</span>
        : saveState === 'error' ? <span className="inline-flex items-center gap-1 font-semibold text-red-300"><span aria-hidden>!</span>Not saved</span>
        : saveState === 'saved' ? <span className="inline-flex max-w-[13rem] items-center gap-1 text-green-400 truncate"><span aria-hidden>✓</span>{saveMsg || 'Saved'}</span>
        : savedOnce ? <span className="inline-flex items-center gap-1 text-green-400/80"><span aria-hidden>✓</span>Saved</span> : null}
    </span>
  )
  const errorCard = saveState === 'error' && (
    <div role="alert" className="sticky top-16 z-20 mb-4 rounded-xl border border-red-800/70 bg-red-950/90 px-4 py-3 text-sm text-red-200 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="font-semibold">{saveMsg || 'Couldn’t save your change.'}</p>
        {err && <p className="text-red-300/80 text-xs mt-0.5 break-words">{err}</p>}
        {editorPane && <p className="text-red-300/70 text-xs mt-1">What you typed is still here.</p>}
      </div>
      <button onClick={retryLastSave} disabled={busy} className="shrink-0 min-h-11 rounded-lg bg-red-600 text-white font-semibold px-4 active:opacity-80 disabled:opacity-50">Retry</button>
    </div>
  )

  // ── Panes ──────────────────────────────────────────────────────────────────────────────────────
  const paneTitle = pane.kind === 'add' ? 'Add item' : pane.kind === 'review' ? 'Needs review' : pane.kind === 'customer' ? 'Customer name' : pane.kind === 'cancel' ? 'Cancel estimate'
    : pane.kind === 'part' ? 'Edit part' : 'Edit item'
  const paneSvc = pane.kind === 'service' ? services.find((s) => s.id === pane.id) : undefined
  const panePart = pane.kind === 'part' ? parts.find((p) => p.id === pane.id) : undefined
  const paneBody = pane.kind === 'list' ? null : (
    <section aria-labelledby="estimate-pane-title">
      <div className="mb-4 flex items-center justify-between gap-3">
        <button type="button" onClick={() => { if (editorDirty) setDiscardAsk(true); else onEditorClose('cancelled') }} disabled={editingBusy && editorPane}
          className="-ml-1 inline-flex min-h-11 items-center gap-1 px-1 text-sm font-semibold text-blue-400 active:opacity-70 disabled:opacity-40">
          <span aria-hidden>←</span>Estimate
        </button>
        {saveBadge}
      </div>
      <h2 id="estimate-pane-title" ref={paneHeading} tabIndex={-1} className="mb-1 text-xl font-bold outline-none">{paneTitle}</h2>
      <p className="mb-5 text-sm text-gray-400 break-words">{customer} · {header.vehicle}</p>
      {discardAsk && (
        <div role="alertdialog" aria-label="Unsaved changes" className="mb-4 rounded-xl border border-amber-800/70 bg-amber-950/40 px-4 py-3">
          <p className="text-amber-100 text-sm font-semibold">You have unsaved changes.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => setDiscardAsk(false)} className={`${BTN} flex-1 bg-blue-600 text-white`}>Keep editing</button>
            <button type="button" onClick={() => onEditorClose('cancelled')} className={`${BTN} border border-gray-600 text-gray-200`}>Discard</button>
          </div>
        </div>
      )}
      {errorCard}
      {pane.kind === 'add' && (
        <ServicePicker orderId={header.id} mode="add" busy={busy} isFlat={isFlat} vehicleLabel={header.vehicle} onSave={post} onAdded={closePane} />
      )}
      {pane.kind === 'service' && paneSvc && (
        <ServiceEditor key={paneSvc.id} service={paneSvc} orderId={header.id} vehicleLabel={header.vehicle} isFlat={isFlat} busy={busy} post={post}
          startRematch={pane.rematch} onDirtyChange={setEditorDirty} onClose={onEditorClose} />
      )}
      {pane.kind === 'part' && panePart && (
        <PartEditor key={panePart.id} part={panePart} parts={parts} services={services} busy={busy} post={post} onDirtyChange={setEditorDirty} onClose={onEditorClose} />
      )}
      {pane.kind === 'review' && (
        issues.length === 0
          ? <p className="text-green-400 text-sm">Nothing needs review. <button type="button" onClick={closePane} className="ml-1 min-h-11 font-semibold text-blue-400">Back to estimate</button></p>
          : <>
              <p className="mb-3 text-gray-400 text-sm">Drafts keep saving. Sending or invoicing waits until these are resolved. Each choice saves right away.</p>
              <ReviewNotices issues={issues} services={services} parts={parts} busy={busy} post={post} onChooseOdor={(id) => setPane({ kind: 'service', id, rematch: true })} />
            </>
      )}
      {pane.kind === 'cancel' && (
        <div role="group" aria-label="Confirm cancelling this estimate" className="rounded-xl border border-red-900/70 bg-red-950/30 px-4 py-3 space-y-3">
          <p className="text-red-100 text-sm">Cancel this estimate? It moves to <span className="font-semibold">Cancelled</span> in Estimates history and stays there read-only. It does not go on the Work Board.</p>
          <p className="text-gray-300 text-sm">Nothing is sent to the customer, and a QuickBooks estimate that was already created is left exactly as it is. This can’t be undone in the app.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { void cancelEstimate() }} disabled={busy} className={`${BTN} bg-red-600 text-white`}>{saveState === 'saving' ? 'Cancelling…' : 'Cancel estimate'}</button>
            <button type="button" onClick={() => onEditorClose('cancelled')} disabled={busy} className={`${BTN} border border-gray-600 text-gray-200`}>Keep estimate</button>
          </div>
        </div>
      )}
      {pane.kind === 'customer' && (
        <>
          <NameEditor label="Customer name" initial={customer} busy={busy}
            onSave={(name) => { void saveCustomerName(name).then((ok) => { if (ok) closePane() }) }} onCancel={() => onEditorClose('cancelled')} />
        </>
      )}
    </section>
  )

  // ── List ───────────────────────────────────────────────────────────────────────────────────────
  const partPrice = (p: PartView) => p.supply === 'customer' ? <span className="text-gray-400 text-sm">No charge</span>
    : p.lineCents != null ? <span className="font-semibold text-white">${dollars(p.lineCents)}</span>
    : cancelled ? <span className="text-gray-400 text-sm">Not priced</span> : <span className="text-amber-300 text-sm font-semibold">Add price</span>
  const servicePrice = (s: ServiceView) => isFlat ? <span className="text-gray-400 text-xs">In flat total</span>
    : s.priceCents != null ? <span className="font-semibold text-white">${dollars(s.priceCents)}</span>
    : cancelled ? <span className="text-gray-400 text-sm">Not priced</span> : <span className="text-amber-300 text-sm font-semibold">Add price</span>
  const issueTarget = (code: string, ids: string[]): (() => void) => {
    if ((code === 'odor_choice' || code === 'name_choice') && ids.length === 1) return () => openPane({ kind: 'service', id: ids[0], rematch: true }, `svc:${ids[0]}`)
    const needing = parts.filter((p) => p.laborStatus === 'needs_review')
    if (code === 'part_labor' && needing.length === 1) return () => openPane({ kind: 'part', id: needing[0].id }, `part:${needing[0].id}`)
    return () => openPane({ kind: 'review' }, 'review')
  }

  const list = (
    <>
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-2xl font-bold">Estimate</h1>
        <div className="flex items-center gap-1">
          {saveBadge}
          <div className="relative" data-estimate-menu>
            <button type="button" data-row="menu" onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="More estimate options"
              className="grid h-11 w-11 place-items-center rounded-lg text-gray-300 hover:bg-gray-900 active:bg-gray-800 text-xl leading-none">⋯</button>
            {menuOpen && (
              <div role="menu" aria-label="Estimate options" onKeyDown={(e) => { if (e.key === 'Escape') setMenuOpen(false) }}
                className="absolute right-0 top-12 z-30 w-64 rounded-xl border border-gray-800 bg-gray-900 p-1.5 shadow-xl shadow-black/40">
                {standalone && <MenuItem onClick={() => openPane({ kind: 'customer' }, 'customer')}>Edit customer name</MenuItem>}
                <MenuItem onClick={() => { setVehicleOpen(true); setMenuOpen(false) }}>Vehicle details &amp; photos</MenuItem>
                {!cancelled && issues.length > 0 && <MenuItem onClick={() => openPane({ kind: 'review' }, 'review')}>Review items ({issues.length})</MenuItem>}
                <a role="menuitem" href="/quick-entry/services" className="flex min-h-11 items-center rounded-lg px-3 text-sm text-gray-200 hover:bg-gray-800">Manage prefilled services</a>
                {standalone && <MenuItem danger onClick={() => openPane({ kind: 'cancel' }, 'menu')}>Cancel estimate…</MenuItem>}
              </div>
            )}
          </div>
        </div>
      </div>

      {standalone ? (
        <button type="button" data-row="customer" onClick={() => openPane({ kind: 'customer' }, 'customer')} aria-label={`Edit customer name ${customer}`}
          className="-ml-1 mt-1 inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg px-1 text-left text-lg font-semibold text-white hover:bg-gray-900">
          <span className="break-words min-w-0">{customer}</span>
          <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-blue-400"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
        </button>
      ) : <p className="mt-1 text-lg font-semibold text-white break-words">{customer}</p>}

      <details open={vehicleOpen} onToggle={(e) => setVehicleOpen(e.currentTarget.open)} className="group mt-1 mb-5">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 [&::-webkit-details-marker]:hidden">
          <span className="break-words min-w-0">{header.vehicle}</span><span className="text-gray-500">·</span><span className="text-blue-400 shrink-0">Vehicle details</span>
          <span aria-hidden className="text-gray-400 transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="mt-2 rounded-2xl border border-gray-800 bg-gray-900 p-4">
          <dl className="space-y-3 text-sm">
            <div><dt className="text-gray-400">VIN</dt><dd className="font-mono text-base text-white select-all break-all">{header.vehicleDetails.vin || 'Not recorded'}</dd></div>
            <div className="grid grid-cols-2 gap-4">
              <div><dt className="text-gray-400">Color</dt><dd className="text-gray-200 break-words">{header.vehicleDetails.color || 'Not recorded'}</dd></div>
              <div><dt className="text-gray-400">License plate</dt><dd className="text-gray-200 select-all break-words">{header.vehicleDetails.licensePlate || 'Not recorded'}</dd></div>
            </div>
            {header.vehicleDetails.bodyClass && <div><dt className="text-gray-400">Body style</dt><dd className="text-gray-200">{header.vehicleDetails.bodyClass}</dd></div>}
          </dl>
          <div className="mt-4"><OrderPhotos orderId={header.id} /></div>
        </div>
      </details>
      {header.notes && <p className="-mt-3 mb-5 text-gray-400 text-sm whitespace-pre-wrap">{header.notes}</p>}

      {errorCard}
      {cancelled && (
        <div role="note" className="mb-4 rounded-xl border border-gray-700 bg-gray-900 px-4 py-3">
          <p className="text-sm font-semibold text-gray-100">Cancelled</p>
          <p className="text-xs text-gray-400 mt-0.5">Kept for history. Nothing on this estimate can be changed, sent, or moved to the Work Board.</p>
        </div>
      )}

      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="font-semibold text-gray-200">Work &amp; parts</h2>
        {!cancelled && (services.length + parts.length) > 0 && <span className="text-xs text-gray-400">Tap a line to edit</span>}
      </div>
      <ul aria-label="Services and parts" className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900 divide-y divide-gray-800">
        {services.map((s) => (
          <Row key={s.id} id={`svc:${s.id}`} label={`Edit ${s.title}`} title={s.title}
            sub={[s.detail, s.matchState === 'custom' ? 'Custom service' : s.catalogName && s.catalogName !== s.title ? s.catalogName : null].filter(Boolean).join(' · ') || 'Service'}
            attention={cancelled ? null : serviceAttention(s)} price={servicePrice(s)} onOpen={cancelled ? undefined : () => openPane({ kind: 'service', id: s.id }, `svc:${s.id}`)} />
        ))}
        {parts.map((p) => (
          <Row key={p.id} id={`part:${p.id}`} label={`Edit part ${p.description}`} title={p.description}
            badge={<span className="shrink-0 rounded-md bg-sky-900/50 px-1.5 py-0.5 text-[11px] font-semibold text-sky-200">Part</span>}
            sub={[p.supply === 'customer' ? 'Customer-supplied' : 'Special order', `Qty ${p.quantity}`, p.supply === 'shop' && p.sellPriceCents != null && p.quantity !== 1 ? `$${dollars(p.sellPriceCents)} each` : null].filter(Boolean).join(' · ')}
            attention={p.laborStatus === 'needs_review' ? 'Installation labor not reviewed' : null} price={partPrice(p)}
            onOpen={cancelled ? undefined : () => openPane({ kind: 'part', id: p.id }, `part:${p.id}`)} />
        ))}
        {services.length + parts.length === 0 && <li className="px-4 py-6 text-center text-sm text-gray-400">No items yet. Add the first service or part.</li>}
      </ul>

      {/* Required reviews — only when relevant. Drafts still save; send / invoice wait for these. */}
      {!cancelled && issues.length > 0 && (
        <div role="region" aria-label="Needs review before sending" className="mt-3 space-y-2">
          {issues.map((i) => (
            <div key={i.code} className="flex items-center gap-3 rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-2.5">
              <span aria-hidden className="text-amber-300">⚠</span>
              <p className="min-w-0 flex-1 text-sm text-amber-100">{i.message}</p>
              <button type="button" data-row={i.code === 'odor_choice' || i.code === 'name_choice' ? undefined : 'review'} onClick={issueTarget(i.code, i.ids)}
                className="shrink-0 min-h-11 rounded-lg px-3 text-sm font-semibold text-amber-200 hover:bg-amber-900/40">Review</button>
            </div>
          ))}
        </div>
      )}

      {!cancelled && (
        <button type="button" data-row="add" onClick={() => openPane({ kind: 'add' }, 'add')} disabled={busy}
          className="mt-4 flex w-full min-h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 text-base font-semibold text-white active:opacity-80 disabled:opacity-50">
          <span aria-hidden className="text-xl leading-none">+</span>Add item
        </button>
      )}

      {/* Incomplete pricing: a flat amount was agreed, but not every line is priced yet. The agreed
          amount stays a clearly-labeled REFERENCE; the partial sum is never presented as the total. */}
      {!cancelled && view.incomplete && view.referenceCents != null && (
        <div className="mt-4 rounded-2xl border border-amber-800/70 bg-amber-950/30 px-4 py-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <p className="text-amber-300 font-semibold">Pricing incomplete</p>
            <span className="text-amber-100 tabular-nums">Agreed ${dollars(view.referenceCents)}</span>
          </div>
          <p className="text-amber-200/70 text-xs mt-1">Price every line so the breakdown adds up. Until then the total below is partial, not the agreed amount — the invoice can’t be created yet.</p>
        </div>
      )}

      {/* Every line priced, but the itemized total differs from the agreed amount: show the
          difference and require an explicit choice — itemizing never silently replaces it. */}
      {!cancelled && !view.incomplete && view.referenceCents != null && (
        <div className="mt-4 rounded-2xl border border-amber-800/70 bg-amber-950/30 px-4 py-3">
          <p className="text-amber-300 text-sm font-semibold">Itemized total differs from the agreed amount</p>
          <dl className="mt-1 space-y-0.5 text-sm">
            <div className="flex justify-between"><dt className="text-amber-200/80">Agreed amount</dt><dd className="text-amber-100 tabular-nums">${dollars(view.referenceCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-amber-200/80">Itemized total</dt><dd className="text-amber-100 font-bold tabular-nums">${dollars(view.workTotalCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-amber-200/80">Difference</dt><dd className="text-amber-100 tabular-nums">{view.workTotalCents >= view.referenceCents ? '+' : '−'}${dollars(Math.abs(view.workTotalCents - view.referenceCents))}</dd></div>
          </dl>
          <button onClick={() => post({ action: 'accept_total' })} disabled={busy} className={`${BTN} mt-3 w-full bg-amber-600 text-white`}>Use itemized total ${dollars(view.workTotalCents)}</button>
          <p className="text-amber-200/60 text-xs mt-2">Or edit a line price so the breakdown matches the agreed amount. The invoice can’t be created until this is resolved.</p>
        </div>
      )}

      {/* Work Total */}
      <div className="mt-4 rounded-2xl border border-gray-800 bg-gray-900 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-white font-bold text-lg">{view.incomplete ? 'Itemized so far' : 'Work total'}</p>
            <p className="text-gray-400 text-xs">
              {isFlat ? 'Flat price' : view.incomplete ? 'Partial — some lines still need a price' : 'Sum of line prices'} · before shop supplies, card charge, and tax
            </p>
          </div>
          {totalEditable && !cancelled ? (
            <PriceInput cents={view.workTotalCents} busy={busy} onCommit={(c) => post({ action: 'set_work_total', cents: c })} />
          ) : (
            <span className={`text-2xl font-bold tabular-nums ${view.incomplete ? 'text-amber-300' : 'text-white'}`}>${dollars(view.workTotalCents)}</span>
          )}
        </div>
        {!cancelled && isFlat && services.length > 0 && (
          <button onClick={() => post({ action: 'itemize' })} disabled={busy}
            className="mt-2 min-h-11 px-1 -ml-1 text-blue-400 text-sm font-semibold active:opacity-70 disabled:opacity-40">Set individual prices →</button>
        )}
      </div>
    </>
  )

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={header.standalone || header.quoteOnly ? { href: '/estimates', label: 'Estimates' } : { href: `/orders/${header.id}`, label: 'Job' }} />
      <div className="max-w-xl mx-auto px-4 py-5">
        {pane.kind === 'list' ? list : paneBody}
        {/* Kept mounted (hidden in panes) so its loaded totals and confirmations survive opening an editor. */}
        {standalone && (
          <div hidden={pane.kind !== 'list'}>
            <EstimateActions key={`${customerRev}:${JSON.stringify(view)}`} id={header.id} editorBusy={editingBusy} onBusyChange={setActionBusy} />
          </div>
        )}
      </div>
    </main>
  )
}

function MenuItem({ onClick, children, danger }: { onClick: () => void; children: ReactNode; danger?: boolean }) {
  return <button type="button" role="menuitem" onClick={onClick} className={`flex w-full min-h-11 items-center rounded-lg px-3 text-left text-sm hover:bg-gray-800 ${danger ? 'text-red-300' : 'text-gray-200'}`}>{children}</button>
}
