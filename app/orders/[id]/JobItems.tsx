'use client'

/**
 * Job page item editing (manager/admin, retail Jobs). The SAME records, editors and save path as the
 * Estimate / Invoice page: the estimate view from GET /estimate, ServiceEditor / PartEditor opened in a
 * full-screen sheet, and every change through saveEstimateEdit (server-confirmed, Retry on failure).
 * Nothing here prices or classifies on its own, so the two screens can never drift apart.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { describeEdit, saveEstimateEdit, type EstimateEdit, type EstimateViewData, type PartView } from './estimate/save-feedback'
import { PartEditor, ServiceEditor } from './estimate/ItemEditor'
import { partSwipeRemove } from './estimate/ItemRows'

type Pane = null | { kind: 'service'; id: string } | { kind: 'part'; id: string; confirmRemove?: boolean }
const BTN = 'rounded-xl font-semibold text-sm px-4 py-3 min-h-11 active:opacity-80 disabled:opacity-40'

export interface JobItems {
  /** The estimate view once loaded (null before / when unavailable). */
  view: EstimateViewData | null
  busy: boolean
  openService: (id: string) => void
  openPart: (id: string, confirmRemove?: boolean) => void
  removeService: (id: string) => void
  /** Swipe → Remove for a part (asks about linked labor first, like the editor). */
  removePart: (p: PartView) => () => void
  /** Re-read the view (after a change made elsewhere on the page, e.g. Add Service / parts tracker). */
  refresh: () => void
  /** Status line + the editor sheet; render once anywhere in the page. */
  ui: ReactNode
}

export function useJobItems({ orderId, enabled, vehicleLabel, customerLabel, onSaved }: {
  orderId: string; enabled: boolean; vehicleLabel: string; customerLabel: string
  /** A change was confirmed by the server — refetch the Job (services/parts split, totals). */
  onSaved: () => void
}): JobItems {
  const [view, setView] = useState<EstimateViewData | null>(null)
  const viewRef = useRef<EstimateViewData | null>(null)
  const [rev, setRev] = useState(0)
  const [busy, setBusy] = useState(false)
  const [pane, setPane] = useState<Pane>(null)
  const paneRef = useRef<Pane>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [discardAsk, setDiscardAsk] = useState(false)
  const [status, setStatus] = useState<{ kind: 'saving' | 'saved' | 'error'; msg: string; err?: string } | null>(null)
  const retryRef = useRef<(() => void) | null>(null)
  const retryIsDraft = useRef(false)
  const postRef = useRef<(e: EstimateEdit, retry?: () => void) => Promise<boolean>>(async () => false)
  const onSavedRef = useRef(onSaved)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (!enabled) return
    let ok = true
    fetch(`/api/workflow/orders/${orderId}/estimate`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (ok && d?.ok && d.view) setView(d.view as EstimateViewData) })
      .catch(() => { /* keep the plain list; the estimate page still works */ })
    return () => { ok = false }
  }, [orderId, enabled, rev])
  const refresh = useCallback(() => setRev((n) => n + 1), [])

  const closePane = useCallback(() => {
    dirtyRef.current = false; setDirty(false); setDiscardAsk(false)
    if (window.history.state?.jobItemPane) window.history.back()
    else setPane(null)
  }, [])
  const closeRef = useRef(closePane)

  const post = useCallback(async (payload: EstimateEdit, retry?: () => void): Promise<boolean> => {
    retryRef.current = retry ?? (() => { void postRef.current(payload) })
    retryIsDraft.current = !!retry
    const labels = describeEdit(payload, viewRef.current ?? { exists: true, flat: false, workTotalCents: 0, services: [], incomplete: false, referenceCents: null })
    setBusy(true); setStatus({ kind: 'saving', msg: labels.saving })
    try {
      const out = await saveEstimateEdit(orderId, payload)
      if (!out.ok) { setStatus({ kind: 'error', msg: labels.failed, err: out.error }); return false }
      setView(out.view); setStatus({ kind: 'saved', msg: labels.saved })
      onSavedRef.current()
      const open = paneRef.current
      if (open && ((open.kind === 'service' && !out.view.services.some((x) => x.id === open.id)) || (open.kind === 'part' && !(out.view.parts ?? []).some((x) => x.id === open.id)))) closeRef.current()
      return true
    } finally { setBusy(false) }
  }, [orderId])

  useLayoutEffect(() => {
    viewRef.current = view; paneRef.current = pane; dirtyRef.current = dirty
    postRef.current = post; onSavedRef.current = onSaved; closeRef.current = closePane
  })
  useEffect(() => {
    if (status?.kind !== 'saved') return
    const t = setTimeout(() => setStatus((s) => (s?.kind === 'saved' ? null : s)), 2500)
    return () => clearTimeout(t)
  }, [status])

  // The sheet adds a history entry so the phone's Back returns to the Job; unsaved changes ask first.
  const openPane = useCallback((p: Exclude<Pane, null>) => {
    setDiscardAsk(false); setDirty(false)
    if (!paneRef.current) window.history.pushState({ ...window.history.state, jobItemPane: true }, '')
    setPane(p)
  }, [])
  useEffect(() => {
    const onPop = () => {
      if (!paneRef.current) return
      if (dirtyRef.current) { window.history.pushState({ ...window.history.state, jobItemPane: true }, ''); setDiscardAsk(true); return }
      setPane(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => { if (pane) heading.current?.focus() }, [pane])

  const onEditorClose = useCallback((outcome: 'saved' | 'cancelled' | 'removed') => {
    if (outcome === 'cancelled' && retryIsDraft.current) {
      retryRef.current = null; retryIsDraft.current = false
      setStatus((s) => (s?.kind === 'error' ? null : s))
    }
    closePane()
  }, [closePane])

  const openService = useCallback((id: string) => openPane({ kind: 'service', id }), [openPane])
  const openPart = useCallback((id: string, confirmRemove?: boolean) => openPane({ kind: 'part', id, confirmRemove }), [openPane])
  const removeService = useCallback((id: string) => { void post({ action: 'remove_service', serviceId: id }) }, [post])
  const removePart = useCallback((p: PartView) => partSwipeRemove(p,
    () => { void post({ action: 'remove_part', partId: p.id, labor: { action: 'keep' } }) },
    () => openPart(p.id, true)), [post, openPart])

  const services = view?.services ?? []
  const parts = view?.parts ?? []
  const svc = pane?.kind === 'service' ? services.find((s) => s.id === pane.id) : undefined
  const part = pane?.kind === 'part' ? parts.find((p) => p.id === pane.id) : undefined

  const statusLine = status && (
    <div role={status.kind === 'error' ? 'alert' : 'status'} aria-live="polite"
      className={`rounded-xl border px-4 py-3 text-sm flex items-center justify-between gap-3 ${status.kind === 'error' ? 'border-red-800/70 bg-red-950/90 text-red-200' : status.kind === 'saved' ? 'border-green-800/60 bg-green-950/60 text-green-300' : 'border-gray-700 bg-gray-900 text-gray-300'}`}>
      <div className="min-w-0">
        <p className="font-semibold">{status.kind === 'saved' ? `✓ ${status.msg}` : status.msg}</p>
        {status.err && <p className="text-red-300/80 text-xs mt-0.5 break-words">{status.err}</p>}
      </div>
      {status.kind === 'error' && <button onClick={() => retryRef.current?.()} disabled={busy} className="shrink-0 min-h-11 rounded-lg bg-red-600 text-white font-semibold px-4 active:opacity-80 disabled:opacity-50">Retry</button>}
    </div>
  )

  const ui = (
    <>
      {/* Committed actions from the list (swipe → Remove) report here; the sheet shows its own copy. */}
      {!pane && statusLine && <div className="fixed inset-x-0 bottom-4 z-40 mx-auto w-full max-w-xl px-4">{statusLine}</div>}
      {pane && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-950 text-white" role="dialog" aria-modal="true" aria-labelledby="job-item-title">
          <div className="max-w-xl mx-auto px-4 py-5">
            <button type="button" onClick={() => { if (dirty) setDiscardAsk(true); else onEditorClose('cancelled') }} disabled={busy && !!(svc || part)}
              className="-ml-1 mb-4 inline-flex min-h-11 items-center gap-1 px-1 text-sm font-semibold text-blue-400 active:opacity-70 disabled:opacity-40">
              <span aria-hidden>←</span>Job
            </button>
            <h2 id="job-item-title" ref={heading} tabIndex={-1} className="mb-1 text-xl font-bold outline-none">{pane.kind === 'part' ? 'Edit part' : 'Edit item'}</h2>
            <p className="mb-5 text-sm text-gray-400 break-words">{customerLabel} · {vehicleLabel}</p>
            {discardAsk && (
              <div role="alertdialog" aria-label="Unsaved changes" className="mb-4 rounded-xl border border-amber-800/70 bg-amber-950/40 px-4 py-3">
                <p className="text-amber-100 text-sm font-semibold">You have unsaved changes.</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => setDiscardAsk(false)} className={`${BTN} flex-1 bg-blue-600 text-white`}>Keep editing</button>
                  <button type="button" onClick={() => onEditorClose('cancelled')} className={`${BTN} border border-gray-600 text-gray-200`}>Discard</button>
                </div>
              </div>
            )}
            {statusLine && <div className="mb-4">{statusLine}</div>}
            {svc && view && (
              <ServiceEditor key={svc.id} service={svc} orderId={orderId} vehicleLabel={vehicleLabel} isFlat={view.flat} busy={busy} post={post}
                onDirtyChange={setDirty} onClose={onEditorClose} />
            )}
            {part && (
              <PartEditor key={part.id} part={part} parts={parts} services={services} busy={busy} post={post}
                onDirtyChange={setDirty} onClose={onEditorClose} confirmRemove={pane.kind === 'part' && !!pane.confirmRemove} />
            )}
            {!svc && !part && <p className="text-gray-400 text-sm">This item is no longer on the Job.</p>}
          </div>
        </div>
      )}
    </>
  )

  return { view: enabled ? view : null, busy, openService, openPart, removeService, removePart, refresh, ui }
}
