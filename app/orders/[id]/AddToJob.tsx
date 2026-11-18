'use client'

/**
 * Job screen → "+ Add": one menu (Service · Part · Expense) and the add-part form.
 *
 * Both are native modal <dialog>s — the browser provides the top layer, focus containment, Escape and
 * an inert page behind, the same way ServiceRemoveConfirm does. On a phone the menu is a bottom sheet and
 * the part form fills the screen; on a wider screen both are centered cards.
 *
 * Nothing here saves or prices anything: the menu only reports the choice, and the form hands a validated
 * draft (validatePartDraft — the server re-validates every add) plus the chosen "Assign to" value back to
 * JobItemsPanel, which sends it through the existing POST /parts `add`.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { validatePartDraft, UNCONFIRMED_ADD_MSG, type DraftProblem, type PartAssignOption, type PartDraft, type PartInput } from '@/apps/parts/job-items-view'

export type AddChoice = 'service' | 'part' | 'expense'

const INPUT = 'w-full bg-gray-950 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-base placeholder:text-gray-500 focus:border-blue-500 focus:outline-none disabled:opacity-60'
const CHOICE = 'flex w-full min-h-14 items-center justify-between rounded-xl border border-gray-700 bg-gray-950/60 px-4 text-left text-base font-semibold text-white active:bg-gray-800 focus-visible:border-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60'
const BACKDROP = 'backdrop:bg-black/70 backdrop:overflow-hidden [overscroll-behavior:contain]'

/**
 * Open a mounted <dialog> as a modal once. The parent unmounts it to dismiss it after a save (the browser
 * drops a removed dialog from the top layer); the parent then puts focus back on "+ Add" itself.
 */
function useModal(ref: React.RefObject<HTMLDialogElement | null>, focus?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dlg = ref.current
    if (dlg && !dlg.open) { dlg.showModal(); focus?.current?.focus() }
  }, [ref, focus])
}

/** The "+ Add" menu. Reports the choice (or a cancel) AFTER the dialog has closed and focus is back on the opener. */
export function AddMenu({ choices, onPick, onCancel }: {
  choices: readonly AddChoice[]
  onPick: (c: AddChoice) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const first = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  useModal(ref, first)
  const label: Record<AddChoice, string> = { service: 'Service', part: 'Part', expense: 'Expense' }
  return (
    <dialog ref={ref} aria-labelledby={titleId} data-add-menu
      onClose={(e) => {
        const dlg = e.currentTarget
        const choice = dlg.returnValue
        dlg.returnValue = ''   // Escape sets no value; never let a stale choice leak
        if (choice === 'service' || choice === 'part' || choice === 'expense') onPick(choice)
        else onCancel()
      }}
      className={`mx-auto mb-0 mt-auto w-full max-w-xl rounded-t-3xl border border-gray-700 bg-gray-900 p-0 text-white shadow-2xl sm:m-auto sm:w-[min(92vw,24rem)] sm:rounded-2xl ${BACKDROP}`}>
      <form method="dialog" className="px-5 pb-8 pt-3 sm:pb-5 sm:pt-5">
        <div aria-hidden className="mx-auto mb-3 h-1 w-12 rounded-full bg-gray-600 sm:hidden" />
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-xl font-bold">Add to job</h2>
          <button value="cancel" aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-full bg-gray-800 text-lg text-gray-200 active:opacity-70">
            <span aria-hidden>✕</span>
          </button>
        </div>
        <div className="space-y-3">
          {choices.map((c, i) => (
            <button key={c} ref={i === 0 ? first : undefined} value={c} data-add-choice={c} className={CHOICE}>
              <span>{label[c]}</span>
              <span aria-hidden className="text-gray-400">›</span>
            </button>
          ))}
        </div>
      </form>
    </dialog>
  )
}

/**
 * The add-part form. Part name is focused on open; Assign to defaults to `initialAssign` (Whole job unless
 * the form was opened for a specific service). Quantity and Customer price are plain text state — clearing
 * one leaves it empty; nothing is restored while typing, and a blank price is a problem on submit, never $0.
 * Part number and (manager only) our internal cost stay available under More details.
 *
 * `locked`: the last add got no clear answer and may have been saved. Every field is frozen and the button says
 * "Try again", so the retry is the identical submission under the same request id (the server replays it — it is
 * never added twice, and never reported under a different service than it was sent to).
 *
 * The PartsTech import is NOT owned by this dialog: `importHost` is a DOM node the Job screen keeps (with the
 * import rendered into it). The dialog shows it while open and hands it back on close, so dismissing the dialog
 * during an upload or save loses nothing.
 */
export function AddPartDialog({ manager, busy, error, options, initialAssign, locked = false, importHost, onOpenImport, onSubmit, onCancel }: {
  manager: boolean
  busy: boolean
  error: string | null
  options: readonly PartAssignOption[]
  initialAssign: string
  locked?: boolean
  /** Where the Job screen keeps the PartsTech import (null until first opened). */
  importHost: HTMLElement | null
  /** Offer "Import PartsTech screenshot" and ask the Job screen to create the import (omitted = no import here). */
  onOpenImport?: () => void
  onSubmit: (f: PartInput, assignKey: string, requestId: string) => void
  onCancel: () => void
}) {
  // One key per open form: a retry of the same form replays instead of adding twice (the server keeps it on the audit event).
  const [requestId] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`))
  const ids = useId()
  const ref = useRef<HTMLDialogElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const costRef = useRef<HTMLInputElement>(null)
  const priceRef = useRef<HTMLInputElement>(null)
  const qtyRef = useRef<HTMLInputElement>(null)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const importHeading = useRef<HTMLHeadingElement>(null)
  const importSlot = useRef<HTMLDivElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  useModal(ref, nameRef)
  const [f, setF] = useState<PartDraft>({ name: '', cost: '', price: '', partNumber: '', quantity: '1' })
  const [assign, setAssign] = useState(initialAssign)
  const [problem, setProblem] = useState<DraftProblem | null>(null)
  const [importing, setImporting] = useState(false)
  // Borrow the Job screen's import node while it is showing here; hand it back (detached, still alive) afterwards.
  useEffect(() => {
    const slot = importSlot.current
    if (!importing || !importHost || !slot) return
    slot.appendChild(importHost)
    return () => { importHost.remove() }
  }, [importing, importHost])
  // Frozen after an unconfirmed add: the disabled fields can't hold focus, so put it on the one thing left to do.
  useEffect(() => { if (locked && !busy) submitRef.current?.focus() }, [locked, busy])
  const frozen = busy || locked
  const busyRef = useRef(busy)
  useLayoutEffect(() => { busyRef.current = busy })

  // A choice that left the Job while the form was open (its service was removed) is never silently re-pointed.
  const assignKnown = options.some((o) => o.key === assign)
  const set = (k: keyof PartDraft) => (e: React.ChangeEvent<HTMLInputElement>) => { setF({ ...f, [k]: e.target.value }); if (problem?.field === k) setProblem(null) }
  const canSubmit = !busy && f.name.trim().length > 0
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    const v = validatePartDraft(f, manager)
    if (!v.ok) {
      setProblem(v.problem)
      if (v.problem.field === 'cost' && detailsRef.current) detailsRef.current.open = true
      const target = v.problem.field === 'price' ? priceRef : v.problem.field === 'cost' ? costRef : qtyRef
      requestAnimationFrame(() => { target.current?.focus(); target.current?.select(); target.current?.scrollIntoView({ block: 'nearest' }) })
      return
    }
    setProblem(null)
    onSubmit(v.input, assign, requestId)
  }
  const flag = (field: DraftProblem['field']) => problem?.field === field ? 'border-amber-400 ring-1 ring-amber-400' : ''
  const fieldError = (field: DraftProblem['field']) => problem?.field === field
    ? <span role="alert" id={`${ids}-${field}-error`} className="mt-1.5 block text-sm text-amber-300">{problem.message}</span> : null
  const close = () => { if (!busyRef.current) ref.current?.close() }
  const showImport = (on: boolean) => {
    setImporting(on); if (on) onOpenImport?.()
    requestAnimationFrame(() => (on ? importHeading.current : nameRef.current)?.focus())
  }

  return (
    <dialog ref={ref} aria-labelledby={`${ids}-title`} data-add-part
      onCancel={(e) => { if (busyRef.current) e.preventDefault() }}   // Escape never abandons a save in flight
      onClose={onCancel}
      className={`m-0 h-dvh max-h-none w-screen max-w-none overflow-y-auto border-0 bg-gray-950 p-0 text-white sm:m-auto sm:h-fit sm:max-h-[90dvh] sm:w-[min(92vw,28rem)] sm:rounded-2xl sm:border sm:border-gray-700 sm:bg-gray-900 sm:shadow-2xl ${BACKDROP}`}>
      <div className="mx-auto max-w-xl px-5 pb-8 pt-4">
        <div className="relative mb-4 flex min-h-11 items-center justify-center">
          <button type="button" onClick={importing ? () => showImport(false) : close} disabled={busy}
            className="absolute left-0 inline-flex min-h-11 items-center px-1 text-base font-semibold text-blue-400 active:opacity-70 disabled:opacity-40">
            {importing ? '‹ Part form' : 'Cancel'}
          </button>
          <h2 id={`${ids}-title`} className="text-xl font-bold">Add part</h2>
        </div>

        {/* The form stays mounted while the import is showing, so nothing typed is lost by looking at it. */}
        <form onSubmit={submit} noValidate hidden={importing} aria-label="Add part" className="space-y-4">
          {onOpenImport && (
            <p className="text-center">
              <button type="button" onClick={() => showImport(true)} disabled={frozen}
                className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-blue-400 underline underline-offset-4 active:opacity-70 disabled:opacity-40">
                Import PartsTech screenshot
              </button>
            </p>
          )}
          <label className="block">
            <span className="text-sm font-semibold text-gray-200">Part name</span>
            <input ref={nameRef} id={`${ids}-name`} value={f.name} onChange={set('name')} maxLength={200} disabled={frozen} placeholder="Cabin air filter" autoComplete="off" className={`${INPUT} mt-1.5`} />
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-gray-200">Assign to</span>
            <select id={`${ids}-assign`} value={assignKnown ? assign : ''} onChange={(e) => setAssign(e.target.value)} disabled={frozen}
              aria-invalid={!assignKnown || undefined} className={`${INPUT} mt-1.5 ${assignKnown ? '' : 'border-amber-400 ring-1 ring-amber-400'}`}>
              {!assignKnown && <option value="" disabled>Choose where this part goes</option>}
              {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            {!assignKnown && <span role="alert" className="mt-1.5 block text-sm text-amber-300">That service is no longer on this job — choose again.</span>}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-semibold text-gray-200">Quantity</span>
              <input ref={qtyRef} id={`${ids}-qty`} value={f.quantity} onChange={set('quantity')} inputMode="decimal" disabled={frozen} autoComplete="off"
                aria-invalid={problem?.field === 'quantity' || undefined} aria-describedby={problem?.field === 'quantity' ? `${ids}-quantity-error` : undefined}
                className={`${INPUT} mt-1.5 tabular-nums ${flag('quantity')}`} />
              {fieldError('quantity')}
            </label>
            <label className="block">
              <span className="text-sm font-semibold text-gray-200">Customer price</span>
              <span className="relative mt-1.5 block"><span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                <input ref={priceRef} id={`${ids}-price`} value={f.price} onChange={set('price')} inputMode="decimal" disabled={frozen} placeholder="0.00" autoComplete="off" aria-required="true"
                  aria-invalid={problem?.field === 'price' || undefined} aria-describedby={`${ids}-price-hint${problem?.field === 'price' ? ` ${ids}-price-error` : ''}`}
                  className={`${INPUT} pl-7 tabular-nums ${flag('price')}`} /></span>
              <span id={`${ids}-price-hint`} className="mt-1 block text-xs text-gray-400">Per part · charged to the customer</span>
              {fieldError('price')}
            </label>
          </div>
          <p className="text-xs text-gray-500">Customer price × quantity goes on the invoice and adds to the job total.</p>

          <details ref={detailsRef} className="group rounded-xl border border-gray-800 px-3">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm text-gray-200 [&::-webkit-details-marker]:hidden">
              <span>More details <span className="text-gray-500">· part #{manager ? ', our cost' : ''}</span></span>
              <span aria-hidden className="text-gray-400 transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="space-y-3 pb-3 pt-1">
              <label className="block">
                <span className="text-sm text-gray-300">Part number</span>
                <input id={`${ids}-pn`} value={f.partNumber} onChange={set('partNumber')} maxLength={80} disabled={frozen} autoComplete="off" autoCapitalize="characters" className={`${INPUT} mt-1.5`} />
              </label>
              {manager && (
                <label className="block">
                  <span className="text-sm text-gray-300">Our cost · each <span className="text-gray-500">(internal)</span></span>
                  <span className="relative mt-1.5 block"><span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                    <input ref={costRef} id={`${ids}-cost`} value={f.cost} onChange={set('cost')} inputMode="decimal" disabled={frozen} placeholder="0.00" autoComplete="off"
                      aria-invalid={problem?.field === 'cost' || undefined} aria-describedby={`${ids}-cost-hint${problem?.field === 'cost' ? ` ${ids}-cost-error` : ''}`}
                      className={`${INPUT} pl-7 tabular-nums ${flag('cost')}`} /></span>
                  <span id={`${ids}-cost-hint`} className="mt-1 block text-xs text-gray-500">What we paid. Never shown to the customer or added to the invoice.</span>
                  {fieldError('cost')}
                </label>
              )}
            </div>
          </details>

          {error && !problem && <p role="alert" className="text-sm text-amber-300">{error}</p>}
          {locked && <p role="status" className="rounded-xl border border-amber-800/60 bg-amber-950/40 px-3 py-2.5 text-sm text-amber-100">{UNCONFIRMED_ADD_MSG}</p>}
          <button ref={submitRef} type="submit" disabled={!canSubmit || !assignKnown}
            className="w-full min-h-12 rounded-xl bg-blue-600 px-4 py-3 text-base font-semibold text-white active:bg-blue-700 disabled:opacity-40">
            {busy ? 'Saving…' : locked ? 'Try again' : 'Add part'}
          </button>
        </form>

        {onOpenImport && (
          <div hidden={!importing}>
            <h3 ref={importHeading} tabIndex={-1} className="text-base font-semibold outline-none">Import PartsTech screenshot</h3>
            <p className="mb-1 mt-1 text-xs text-gray-500">Open PartsTech, screenshot the cart, upload it here.</p>
            <div ref={importSlot} />
            <button type="button" onClick={close} className="mt-4 w-full min-h-12 rounded-xl border border-gray-600 px-4 py-3 text-base font-semibold text-gray-200 active:opacity-70">Done</button>
          </div>
        )}
      </div>
    </dialog>
  )
}
