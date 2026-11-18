'use client'

/**
 * Job screen — Services and Parts, the guided version.
 *
 * One list of services, each showing its name and price, with the parts attached to it (the parts
 * that service installs) nested underneath. A manager removes a service by swiping it left, or from
 * its editor (tap the name → Remove item); there is no per-row control, so prices line up on the
 * right edge. Whole-job parts get their own Parts list — shown only when there are any.
 *
 * Everything is added from ONE "+ Add" button beside Services: a menu (bottom sheet on a phone) with
 * Service, Part and Expense. Service opens the existing service picker; Part opens the add-part form
 * (Part name · Assign to · Quantity · Customer price, PartsTech import as a secondary action);
 * Expense opens the Job's Expenses. Every removal asks once and says what will happen; every success
 * is confirmed in a short notice.
 *
 * Nothing here prices or classifies on its own:
 *   • the view is the authoritative estimate view (GET /items → getEstimateView), so a part's amount is
 *     the SAME line amount (customer price × quantity) the Invoice Draft bills — shown, never recomputed;
 *   • adds go through POST /parts `add` (addPartForJob → the estimate's part row + priced line);
 *   • part removals go through POST /parts `remove` (removeEstimatePartWithLabor: line + record, audited;
 *     once the Job has a QuickBooks invoice an employee can't remove a part — the server enforces it);
 *   • service removals go through the estimate route `remove_service_with_parts` (manager/admin).
 * Part rows deliberately show only name · amount · Remove — no ordering/receiving, no statuses.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EstimateViewData, PartView, ServiceView } from './estimate/save-feedback'
import { partPrice, servicePrice } from './estimate/ItemRows'
import RemovableServiceRow from '@/app/components/RemovableServiceRow'
import { groupJobItems, partAssignOptions, partsPostOutcome, placeOfAddedPart, resolvePartAssign, serviceRemovalConsequence, ASSIGN_GONE_MSG, INVOICED_NEEDS_MANAGER_MSG, LABOR_NEEDS_MANAGER_MSG, LABOR_STAYS_NOTE, WHOLE_JOB, type AddLock, type PartInput, type PartsPostOutcome } from '@/apps/parts/job-items-view'
import { AddMenu, AddPartDialog, type AddChoice } from './AddToJob'

const BTN = 'rounded-xl font-semibold text-sm px-4 min-h-11 active:opacity-80 disabled:opacity-40'
const LINK = 'min-h-11 inline-flex items-center px-1 text-sm font-semibold active:opacity-70 disabled:opacity-40'

/** The add-part form is open; `assign` is the "Assign to" value it starts on (Whole job unless opened for a service). */
type PartForm = null | {
  assign: string
  /** The last add was sent and failed (it may have been saved or have used up its request id): the form is frozen so a retry is the SAME submission. */
  locked?: AddLock
}
const textKey = (title: string) => `text:${title.trim().toLowerCase()}`
type Confirm = null
  | { kind: 'part'; id: string }
  | { kind: 'message'; id: string; text: string }

export interface JobItemsPanelProps {
  orderId: string
  /** The estimate view (null while loading or when the Job has no estimate yet). */
  view: EstimateViewData | null
  /** The Job's employee-facing text services — the list before an estimate exists, and any entry the estimate hasn't mirrored yet. */
  textServices: string[]
  /** Manager/admin: may set prices, remove charged parts and remove services. The server enforces every one of these. */
  manager: boolean
  /** Tap-to-edit sheets are available (manager, retail Job, estimate layer on, Job not cancelled). */
  canEdit: boolean
  partsVisible: boolean
  /** The Job was removed (soft-cancelled): nothing can be added or taken off it (the server refuses too). */
  cancelled?: boolean
  /** An estimate edit is in flight elsewhere on the page. */
  busy: boolean
  onAddService: () => void
  /** Open the Job's Expenses (new receipt / link a filed one). Omitted where the Job has no Expenses section. */
  onAddExpense?: () => void
  onOpenService: (id: string) => void
  onOpenPart: (id: string) => void
  /** Manager: remove the service and its attached parts (estimate route). Resolves true when the server confirmed it. */
  onRemoveServiceWithParts: (id: string) => Promise<boolean>
  /** Manager: remove a text-only (not yet mirrored) service by its exact occurrence in textServices. */
  onRemoveTextService: (name: string, index: number) => Promise<boolean>
  /** A /parts change was confirmed — refetch the view and the Job. */
  onChanged: () => void
  /** The PartsTech screenshot import — a secondary action inside the add-part form. */
  importPanel?: ReactNode
}

export default function JobItemsPanel(p: JobItemsPanelProps) {
  const { orderId, view, manager, canEdit, partsVisible, onChanged } = p
  const [menuOpen, setMenuOpen] = useState(false)
  const [partForm, setPartForm] = useState<PartForm>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  // The PartsTech import lives in its own DOM node, created the first time it is opened and kept for as long as
  // this Job screen is: the add-part dialog only borrows it. Closing the dialog mid-upload or mid-save therefore
  // never discards the import's draft, its pending request or its error — same as the always-mounted panel before.
  const [importHost, setImportHost] = useState<HTMLElement | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [notice, setNotice] = useState<{ text: string; at: string } | null>(null)   // at = service id | 'job'
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [localBusy, setLocalBusy] = useState(false)
  const inFlight = useRef(false)
  const frozen = p.cancelled === true
  const busy = p.busy || localBusy || frozen

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [flash])
  const scrolledFor = useRef<string | null>(null)
  useEffect(() => {
    if (!flash || scrolledFor.current === flash) return
    const el = document.querySelector(`[data-part="${CSS.escape(flash)}"]`)
    if (el) { scrolledFor.current = flash; el.scrollIntoView({ block: 'nearest' }) }
  })

  /** One /parts call at a time — a double-tap can never send the same add or removal twice. */
  /**
   * `readBack`: after a confirmed save, also read the Job's items INSIDE the same in-flight window (the form stays
   * busy and cannot be dismissed or replaced until it settles). `view` is then the fresh view, or null when the
   * read failed — the caller must treat null as "could not confirm", never as success.
   */
  const post = async (body: Record<string, unknown>, readBack = false): Promise<PartsPostOutcome & { view?: EstimateViewData | null }> => {
    // Nothing was sent, so nothing can have been written.
    if (inFlight.current) return { ok: false, error: 'Still saving — one moment.', sent: false, explained: true }
    inFlight.current = true; setLocalBusy(true); setError(null)
    try {
      let out: PartsPostOutcome
      try {
        const r = await fetch(`/api/workflow/orders/${orderId}/parts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        out = partsPostOutcome(r.status, await r.json().catch(() => null))
      } catch { out = partsPostOutcome(null, null) }
      if (!out.ok || !readBack) return out
      const view = await fetch(`/api/workflow/orders/${orderId}/items`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null)).then((d) => (d?.ok && d.view ? d.view as EstimateViewData : null)).catch(() => null)
      return { ...out, view }
    }
    finally { inFlight.current = false; setLocalBusy(false) }
  }

  const grouped = view ? groupJobItems(view) : { services: [], standalone: [] }
  const flat = !!view?.flat
  const mirrored = new Set(grouped.services.map((s) => s.title.trim().toLowerCase()))
  // Keep each entry's exact position in textServices: removal targets that occurrence
  // (identical names can appear more than once), never a lookup by name alone.
  const unmirrored = p.textServices.map((name, index) => ({ name, index })).filter(({ name }) => !mirrored.has(name.trim().toLowerCase()))

  // "Assign to": Whole job, each listed service BY ID (same-named services stay distinct), each text-only service.
  const textOnly = unmirrored.map((u) => u.name)
  const assignOptions = partAssignOptions(grouped.services, textOnly)

  // ── the one "+ Add" ──
  const refocusAdd = () => requestAnimationFrame(() => addButton.current?.focus())
  const pick = (c: AddChoice) => {
    setMenuOpen(false); setError(null); setConfirm(null)
    if (c === 'service') p.onAddService()
    else if (c === 'part') setPartForm({ assign: WHOLE_JOB })
    else p.onAddExpense?.()
  }
  const choices: AddChoice[] = ['service', ...(partsVisible ? ['part' as const] : []), ...(p.onAddExpense ? ['expense' as const] : [])]

  // ── adds ──
  const addPart = async (f: PartInput, assignKey: string, requestId: string) => {
    // Resolved against the CURRENT list: a service removed while the form was open is refused, never re-pointed.
    const target = resolvePartAssign(assignKey, grouped.services, textOnly)
    if (!target) { setError(ASSIGN_GONE_MSG); return }
    const retry = !!partForm?.locked
    // The customer price is entered by whoever adds the part (owner decision 2026-11-03) and is required —
    // the form has already validated it; the server validates it again for every role. Our cost is sent
    // only by a manager (the server drops it otherwise).
    const out = await post({
      action: 'add', description: f.name, partNumber: f.partNumber, quantity: f.quantity,
      sellPriceCents: f.priceCents, unitCostCents: manager ? f.costCents : undefined,
      laborServiceId: target.kind === 'service' ? target.serviceId : null,
      laborServiceTitle: target.kind === 'text' ? target.title : null,
      requestId,
    }, retry)
    if (!out.ok) {
      setError(out.error)
      // The request went out and failed. The server may still have written the part, or used up this request id
      // (its add can fail after the first write, and answers that with a 4xx too). Freeze the form: the only
      // retry is this exact submission, which the server replays — an edited one could be reported as saved
      // somewhere it never was.
      if (out.sent) setPartForm((cur) => (cur ? { ...cur, locked: out.explained ? 'refused' : 'unconfirmed' } : cur))
      return
    }
    if (retry) {
      // A retry: the server may have replayed the first attempt's part, wherever that left it (even cancelled).
      // The Job was read back with the save; say only what that read shows — never "added to X" from the form,
      // and never a success when the read could not confirm it.
      const fresh = out.view ?? null
      setPartForm(null); refocusAdd(); onChanged()
      if (!fresh || !out.partId) { setError(`We couldn’t confirm whether “${f.name}” was added. Check the list before adding it again.`); return }
      const place = placeOfAddedPart(fresh, out.partId)
      if (!place) { setError(`“${f.name}” was not added — the first try did not go through. Add it again.`); return }
      setFlash(out.partId)
      setNotice(place.kind === 'job' ? { text: `${f.name} added to this job.`, at: 'job' } : { text: `${f.name} added to ${place.title}.`, at: place.serviceId })
      return
    }
    setPartForm(null); setFlash(out.partId); refocusAdd()
    setNotice(target.kind === 'job' ? { text: `${f.name} added to this job.`, at: 'job' }
      : { text: `${f.name} added to ${target.title}.`, at: target.kind === 'service' ? target.serviceId : textKey(target.title) })
    onChanged()
  }

  // ── removals ──
  const removePart = async (part: PartView, attachedTo: ServiceView | null) => {
    const out = await post({ action: 'remove', partId: part.id })
    if (!out.ok) {
      if (out.needsManager) { setConfirm({ kind: 'message', id: part.id, text: out.error }); return }
      setError(out.error); return
    }
    setConfirm(null); setNotice({ text: `${part.description} removed.`, at: attachedTo ? attachedTo.id : 'job' }); onChanged()
  }
  const askRemovePart = (part: PartView) => {
    setError(null)
    // Once the Job has a QuickBooks invoice, an employee can't remove a part — say so right away (the server
    // enforces the same rule from the persisted linkage, and atomically against a concurrent invoice Create).
    if (!manager && view?.qbInvoiced) { setConfirm({ kind: 'message', id: part.id, text: INVOICED_NEEDS_MANAGER_MSG }); return }
    // A part with its own installation line: the Job screen never removes labor, so a manager decides (server rule too).
    if (!manager && part.laborStatus === 'labor_added') { setConfirm({ kind: 'message', id: part.id, text: LABOR_NEEDS_MANAGER_MSG }); return }
    setConfirm({ kind: 'part', id: part.id })
  }
  // Confirmed removals (the shared RemovableServiceRow dialog already asked). The service
  // goes through the canonical remove_service_with_parts path — the service AND its
  // attached parts; failures surface in the items status line (with Retry) and keep the row.
  const removeService = async (s: ServiceView): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true; setLocalBusy(true)
    try { return await p.onRemoveServiceWithParts(s.id) }
    finally { inFlight.current = false; setLocalBusy(false) }
  }
  const removeTextService = async (name: string, index: number): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true; setLocalBusy(true)
    try { return await p.onRemoveTextService(name, index) }
    finally { inFlight.current = false; setLocalBusy(false) }
  }

  const partRow = (part: PartView, attachedTo: ServiceView | null) => (
    <li key={part.id} data-part={part.id} className={`py-2.5 transition-colors ${flash === part.id ? 'bg-emerald-900/30 rounded-lg -mx-2 px-2' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        {canEdit ? (
          <button type="button" onClick={() => p.onOpenPart(part.id)} aria-label={`Edit part ${part.description}`}
            className="min-w-0 flex-1 text-left text-white text-[15px] leading-snug break-words min-h-11 flex items-center active:opacity-70">
            {part.description}
          </button>
        ) : (
          <span className="min-w-0 flex-1 text-white text-[15px] leading-snug break-words min-h-11 flex items-center">{part.description}</span>
        )}
        <span className="shrink-0 min-h-11 flex items-center tabular-nums text-[15px]">{partPrice(part, { readOnly: !canEdit })}</span>
        <button type="button" disabled={busy} onClick={() => askRemovePart(part)} aria-label={`Remove ${part.description}`} className={`${LINK} shrink-0 text-red-400`}>Remove</button>
      </div>
      {confirm?.kind === 'part' && confirm.id === part.id && (
        <ConfirmBox label={`Confirm removing ${part.description}`}
          text={(attachedTo ? `Remove “${part.description}” from “${attachedTo.title}” and the job total?` : `Remove “${part.description}” from this job?`) + (part.laborStatus === 'labor_added' ? ` ${LABOR_STAYS_NOTE}` : '')}>
          <button type="button" disabled={busy} onClick={() => void removePart(part, attachedTo)} className={`${BTN} bg-red-600 text-white`}>Remove part</button>
          <button type="button" disabled={busy} onClick={() => setConfirm(null)} className={`${BTN} border border-gray-600 text-gray-200`}>Keep part</button>
        </ConfirmBox>
      )}
      {confirm?.kind === 'message' && confirm.id === part.id && (
        <ConfirmBox label="Manager needed" text={confirm.text} tone="info">
          <button type="button" onClick={() => setConfirm(null)} className={`${BTN} border border-gray-600 text-gray-200`}>Got it</button>
        </ConfirmBox>
      )}
    </li>
  )

  return (
    <div className="px-6 mb-6 space-y-6">
      {/* ── Services ── */}
      <section aria-labelledby="job-services-heading">
        <div className="flex items-center justify-between mb-2">
          <h2 id="job-services-heading" className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Services</h2>
          <button ref={addButton} type="button" data-add-service aria-haspopup="dialog" disabled={frozen}
            onClick={() => { setError(null); setConfirm(null); setMenuOpen(true) }}
            className="min-h-11 rounded-xl border border-blue-400/70 px-4 text-sm font-semibold text-blue-300 active:opacity-70 disabled:opacity-40">+ Add</button>
        </div>
        {frozen && <p className="mb-2 text-amber-300/90 text-sm">This job was removed — nothing can be added or taken off it.</p>}
        {grouped.services.length + unmirrored.length === 0 ? (
          <p className="text-gray-600 text-sm italic">No services yet — tap ＋ Add.</p>
        ) : (
          <ul aria-label="Services" className="rounded-2xl border border-gray-800 bg-gray-900 divide-y divide-gray-800 overflow-hidden">
            {grouped.services.filter((s) => !s.declined).map((s) => {
              return (
                <li key={s.id} data-service={s.id} className="px-4 py-3">
                  {/* Manager: swipe-left asks "Are you sure you want to remove this line?" — nothing is
                      removed until the dialog's Remove, and the canonical remove_service_with_parts
                      path runs (attached parts + charges go too). Mouse/keyboard: the name opens the
                      editor, whose Remove item runs the same path with the same warning. Other roles
                      can't remove a service, so they get no remove control at all. */}
                  {(() => {
                    const header = (
                      <div className="flex items-start justify-between gap-3">
                        {canEdit ? (
                          <button type="button" onClick={() => p.onOpenService(s.id)} aria-label={`Edit ${s.title}`}
                            className="min-w-0 flex-1 text-left font-semibold text-white text-base leading-snug break-words min-h-11 flex items-center active:opacity-70">
                            {s.title}
                          </button>
                        ) : (
                          <span className="min-w-0 flex-1 font-semibold text-white text-base leading-snug break-words min-h-11 flex items-center">{s.title}</span>
                        )}
                        <span className="shrink-0 min-h-11 flex items-center tabular-nums text-base">{servicePrice(s, { flat, readOnly: !canEdit })}</span>
                      </div>
                    )
                    return manager ? (
                      <RemovableServiceRow serviceName={s.title} busy={busy} rounded={false} contentClassName="bg-gray-900"
                        fallbackFocusSelector="[data-add-service]" consequence={serviceRemovalConsequence(s.parts)}
                        onRemove={() => removeService(s)}>
                        {header}
                      </RemovableServiceRow>
                    ) : header
                  })()}

                  {/* Attached parts: visibly inside the service (indented, with a connector rail). */}
                  {partsVisible && s.parts.length > 0 && (
                    <ul aria-label={`Parts for ${s.title}`} className="ml-2 mt-1 border-l-2 border-sky-700/70 pl-3 divide-y divide-gray-800/70">
                      {s.parts.map((part) => partRow(part, s))}
                    </ul>
                  )}

                  {(notice?.at === s.id || notice?.at === textKey(s.title)) && <Notice text={notice.text} />}
                </li>
              )
            })}
            {/* A Job service that exists only as Work Board text (older Jobs / no estimate yet). Opening the Job never
                creates its estimate row; assigning a part to it does (the same mirror Add Service runs), then it shows above. */}
            {unmirrored.map(({ name, index }) => {
              const header = (
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 font-semibold text-white text-base leading-snug break-words min-h-11 flex items-center">{name}</span>
                  <span className="shrink-0 min-h-11 flex items-center text-gray-400 text-sm">Not priced</span>
                </div>
              )
              return (
              <li key={`u${index}`} data-service={textKey(name)} className="px-4 py-3">
                {/* Same swipe → confirmation as mirrored services; the removal targets this exact
                    occurrence in the Job's text list (identical names stay independent). A text-only
                    line has no editor, so its Remove button appears on keyboard focus / mouse hover. */}
                {manager ? (
                  <RemovableServiceRow serviceName={name} busy={busy} rounded={false} contentClassName="bg-gray-900"
                    fallbackFocusSelector="[data-add-service]" revealRemove revealClassName="right-0"
                    // Same legacy-path warning as the plain Job list: the view can be null while
                    // loading/failed even though the server may already hold billing rows for
                    // this name, and the DELETE helper removes exactly that line's own charges.
                    consequence="Any charges belonging only to this line will also be removed; shared charges stay with the remaining service. Separately tracked parts are kept."
                    onRemove={() => removeTextService(name, index)}>
                    {header}
                  </RemovableServiceRow>
                ) : header}
                {notice?.at === textKey(name) && <Notice text={notice.text} />}
              </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* ── Parts for the whole job — only when there are any (parts for a service sit under that service) ── */}
      {partsVisible && grouped.standalone.length > 0 && (
        <section aria-labelledby="job-parts-heading">
          <h2 id="job-parts-heading" className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-2">
            Parts<span className="text-gray-400 normal-case"> · {grouped.standalone.length}</span>
          </h2>
          <ul aria-label="Parts" className="rounded-2xl border border-gray-800 bg-gray-900 px-4 divide-y divide-gray-800">
            {grouped.standalone.map((part) => partRow(part, null))}
          </ul>
        </section>
      )}
      {notice?.at === 'job' && <Notice text={notice.text} />}

      {error && !partForm && <p role="alert" className="text-red-400 text-sm">{error}</p>}

      {menuOpen && <AddMenu choices={choices} onPick={pick} onCancel={() => setMenuOpen(false)} />}
      {partForm && (
        <AddPartDialog manager={manager} busy={p.busy || localBusy} jobRemoved={frozen} error={error} options={assignOptions} initialAssign={partForm.assign} locked={partForm.locked}
          importHost={p.importPanel ? importHost : null} onOpenImport={p.importPanel ? () => setImportHost((h) => h ?? document.createElement('div')) : undefined}
          onSubmit={(f, key, rid) => void addPart(f, key, rid)}
          // Leaving a form whose add was never confirmed: re-read the Job so the list shows whether it was saved.
          onCancel={() => { if (partForm.locked) onChanged(); setPartForm(null); setError(null); refocusAdd() }} />
      )}
      {importHost && p.importPanel && createPortal(p.importPanel, importHost)}
    </div>
  )
}

/** Brief confirmation of what just happened, shown where it happened. */
function Notice({ text }: { text: string }) {
  return <p role="status" aria-live="polite" className="mt-2 rounded-xl border border-emerald-800/60 bg-emerald-950/60 px-3 py-2.5 text-sm text-emerald-200">✓ {text}</p>
}

function ConfirmBox({ label, text, tone = 'danger', children }: { label: string; text: string; tone?: 'danger' | 'info'; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.scrollIntoView({ block: 'nearest' }) }, [])
  return (
    <div ref={box} role="group" aria-label={label}
      className={`mt-2 rounded-xl border px-3 py-3 space-y-3 ${tone === 'danger' ? 'border-red-900/70 bg-red-950/30' : 'border-sky-900/70 bg-sky-950/30'}`}>
      <p className={`text-sm ${tone === 'danger' ? 'text-red-100' : 'text-sky-100'}`}>{text}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}
