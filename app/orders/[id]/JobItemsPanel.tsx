'use client'

/**
 * Job screen — Services and Parts, the guided version.
 *
 * One list of services, each showing its name and price, with the parts attached to it (the parts
 * that service installs) nested underneath, "+ Add part to this service" and "Remove service" inside
 * the service. Below it, the job's standalone parts with "+ Add a part". Every add form opens right
 * under the button that was tapped, with focus on "What part?"; every removal asks once and says what
 * will happen; every success is confirmed in a short notice.
 *
 * Nothing here prices or classifies on its own:
 *   • the view is the authoritative estimate view (GET /items → getEstimateView), so a part's amount is
 *     the SAME line amount (customer price × quantity) the Invoice Draft bills — shown, never recomputed;
 *   • adds go through POST /parts `add` (addPartForJob → the estimate's part row + priced line);
 *   • part removals go through POST /parts `remove` (removeEstimatePartWithLabor: line + record, audited;
 *     a charged part needs a manager, and the server enforces it);
 *   • service removals go through the estimate route `remove_service_with_parts` (manager/admin).
 * Part rows deliberately show only name · amount · Remove — no ordering/receiving, no statuses.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { EstimateViewData, PartView, ServiceView } from './estimate/save-feedback'
import { partPrice, servicePrice } from './estimate/ItemRows'
import { groupJobItems, removeServiceMessage, NEEDS_MANAGER_MSG, SERVICE_NEEDS_MANAGER_MSG } from '@/apps/parts/job-items-view'

const BTN = 'rounded-xl font-semibold text-sm px-4 min-h-11 active:opacity-80 disabled:opacity-40'
const INPUT = 'w-full bg-gray-950 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-base placeholder:text-gray-500 focus:border-blue-500 focus:outline-none disabled:opacity-60'
const LINK = 'min-h-11 inline-flex items-center px-1 text-sm font-semibold active:opacity-70 disabled:opacity-40'

type Adding = null | { kind: 'job' } | { kind: 'service'; serviceId: string; title: string }
type Confirm = null
  | { kind: 'part'; id: string }
  | { kind: 'service'; id: string }
  | { kind: 'text-service'; name: string }
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
  /** An estimate edit is in flight elsewhere on the page. */
  busy: boolean
  onAddService: () => void
  onOpenService: (id: string) => void
  onOpenPart: (id: string) => void
  /** Manager: remove the service and its attached parts (estimate route). Resolves true when the server confirmed it. */
  onRemoveServiceWithParts: (id: string) => Promise<boolean>
  /** Manager: remove a text-only (not yet mirrored) service by name. */
  onRemoveTextService: (name: string) => Promise<void>
  /** A /parts change was confirmed — refetch the view and the Job. */
  onChanged: () => void
  /** The collapsed "Add from a PartsTech screenshot" content. */
  importPanel?: ReactNode
}

const centsFrom = (s: string): number | null | 'bad' => {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return 'bad'
  return Math.round(n * 100)
}

export default function JobItemsPanel(p: JobItemsPanelProps) {
  const { orderId, view, manager, canEdit, partsVisible, onChanged } = p
  const [adding, setAdding] = useState<Adding>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [notice, setNotice] = useState<{ text: string; at: string } | null>(null)   // at = service id | 'job'
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [localBusy, setLocalBusy] = useState(false)
  const inFlight = useRef(false)
  const busy = p.busy || localBusy

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
  const post = useCallback(async (body: Record<string, unknown>): Promise<{ ok: true; partId: string | null } | { ok: false; error: string; needsManager?: boolean }> => {
    if (inFlight.current) return { ok: false, error: 'Still saving — one moment.' }
    inFlight.current = true; setLocalBusy(true); setError(null)
    try {
      const r = await fetch(`/api/workflow/orders/${orderId}/parts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; needsManager?: boolean; partId?: string | null }
      if (!r.ok || !d.ok) return { ok: false, error: d.error || 'Could not save — check your connection and try again.', needsManager: d.needsManager }
      return { ok: true, partId: d.partId ?? null }
    } catch { return { ok: false, error: 'No connection — check the internet and try again.' } }
    finally { inFlight.current = false; setLocalBusy(false) }
  }, [orderId])

  const grouped = view ? groupJobItems(view) : { services: [], standalone: [] }
  const flat = !!view?.flat
  const mirrored = new Set(grouped.services.map((s) => s.title.trim().toLowerCase()))
  const unmirrored = p.textServices.filter((n) => !mirrored.has(n.trim().toLowerCase()))

  // ── adds ──
  const addPart = async (f: PartDraft, attach: Adding & { kind: 'service' } | null) => {
    const cost = centsFrom(f.cost), price = centsFrom(f.price)
    if (cost === 'bad' || price === 'bad') { setError('Check the amounts — use a number like 59 or 59.50.'); return }
    const qty = Number(f.quantity)
    if (!Number.isFinite(qty) || qty <= 0) { setError('Enter a quantity of 1 or more.'); return }
    const out = await post({
      action: 'add', description: f.name.trim(), partNumber: f.partNumber.trim() || null, quantity: qty,
      unitCostCents: manager ? cost : undefined, sellPriceCents: manager ? price : undefined,
      laborServiceId: attach?.serviceId ?? null,
    })
    if (!out.ok) { setError(out.error); return }
    setAdding(null); setFlash(out.partId)
    setNotice(attach ? { text: `${f.name.trim()} added to ${attach.title}.`, at: attach.serviceId } : { text: `${f.name.trim()} added to this job.`, at: 'job' })
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
    // An employee can't remove a charged part — say so right away (the server enforces the same rule).
    if (!manager && part.lineCents != null) { setConfirm({ kind: 'message', id: part.id, text: NEEDS_MANAGER_MSG }); return }
    setConfirm({ kind: 'part', id: part.id })
  }
  const askRemoveService = (s: ServiceView) => {
    setError(null)
    if (!manager) { setConfirm({ kind: 'message', id: s.id, text: SERVICE_NEEDS_MANAGER_MSG }); return }
    setConfirm({ kind: 'service', id: s.id })
  }
  const removeService = async (s: ServiceView & { parts: PartView[] }) => {
    if (inFlight.current) return
    inFlight.current = true; setLocalBusy(true)
    try {
      const ok = await p.onRemoveServiceWithParts(s.id)
      if (ok) setConfirm(null)
    } finally { inFlight.current = false; setLocalBusy(false) }
  }
  const removeTextService = async (name: string) => {
    if (inFlight.current) return
    inFlight.current = true; setLocalBusy(true)
    try { await p.onRemoveTextService(name); setConfirm(null) }
    finally { inFlight.current = false; setLocalBusy(false) }
  }

  const partCount = grouped.services.reduce((n, s) => n + s.parts.length, 0) + grouped.standalone.length

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
          text={attachedTo ? `Remove “${part.description}” from “${attachedTo.title}” and the job total?` : `Remove “${part.description}” from this job?`}>
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
          <button type="button" onClick={p.onAddService} className="text-blue-400 text-sm font-semibold active:opacity-70 min-h-11">+ Add Service</button>
        </div>
        {grouped.services.length + unmirrored.length === 0 ? (
          <p className="text-gray-600 text-sm italic">No services yet — tap ＋ Add Service.</p>
        ) : (
          <ul aria-label="Services" className="rounded-2xl border border-gray-800 bg-gray-900 divide-y divide-gray-800 overflow-hidden">
            {grouped.services.filter((s) => !s.declined).map((s) => {
              const attachOpen = adding?.kind === 'service' && adding.serviceId === s.id
              return (
                <li key={s.id} data-service={s.id} className="px-4 py-3">
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

                  {/* Attached parts: visibly inside the service (indented, with a connector rail). */}
                  {partsVisible && s.parts.length > 0 && (
                    <ul aria-label={`Parts for ${s.title}`} className="ml-2 mt-1 border-l-2 border-sky-700/70 pl-3 divide-y divide-gray-800/70">
                      {s.parts.map((part) => partRow(part, s))}
                    </ul>
                  )}

                  <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3">
                    {partsVisible ? (
                      <button type="button" disabled={busy || attachOpen} onClick={() => { setError(null); setConfirm(null); setAdding({ kind: 'service', serviceId: s.id, title: s.title }) }}
                        className={`${LINK} text-blue-400`}>+ Add part to this service</button>
                    ) : <span />}
                    <button type="button" disabled={busy} onClick={() => askRemoveService(s)} className={`${LINK} text-red-400`}>Remove service</button>
                  </div>

                  {notice?.at === s.id && <Notice text={notice.text} />}
                  {attachOpen && (
                    <AddPartForm key={`svc-${s.id}`} manager={manager} busy={busy} error={error} attachedTo={s.title}
                      onSubmit={(f) => void addPart(f, adding as Adding & { kind: 'service' })} onCancel={() => { setAdding(null); setError(null) }} />
                  )}

                  {confirm?.kind === 'service' && confirm.id === s.id && (
                    <ConfirmBox label={`Confirm removing ${s.title}`} text={removeServiceMessage(s.title, s.parts)}>
                      <button type="button" disabled={busy} onClick={() => void removeService(s)} className={`${BTN} bg-red-600 text-white`}>Remove service</button>
                      <button type="button" disabled={busy} onClick={() => setConfirm(null)} className={`${BTN} border border-gray-600 text-gray-200`}>Keep service</button>
                    </ConfirmBox>
                  )}
                  {confirm?.kind === 'message' && confirm.id === s.id && (
                    <ConfirmBox label="Manager needed" text={confirm.text} tone="info">
                      <button type="button" onClick={() => setConfirm(null)} className={`${BTN} border border-gray-600 text-gray-200`}>Got it</button>
                    </ConfirmBox>
                  )}
                </li>
              )
            })}
            {/* A Job service the estimate hasn't picked up yet (no estimate on this Job yet). */}
            {unmirrored.map((name, i) => (
              <li key={`u${i}`} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 font-semibold text-white text-base leading-snug break-words min-h-11 flex items-center">{name}</span>
                  <span className="shrink-0 min-h-11 flex items-center text-gray-400 text-sm">Not priced</span>
                </div>
                <div className="flex justify-end">
                  <button type="button" disabled={busy} onClick={() => { setError(null); if (!manager) setConfirm({ kind: 'message', id: `text:${name}`, text: SERVICE_NEEDS_MANAGER_MSG }); else setConfirm({ kind: 'text-service', name }) }}
                    className={`${LINK} text-red-400`}>Remove service</button>
                </div>
                {confirm?.kind === 'text-service' && confirm.name === name && (
                  <ConfirmBox label={`Confirm removing ${name}`} text={`Remove “${name}” from this job?`}>
                    <button type="button" disabled={busy} onClick={() => void removeTextService(name)} className={`${BTN} bg-red-600 text-white`}>Remove service</button>
                    <button type="button" disabled={busy} onClick={() => setConfirm(null)} className={`${BTN} border border-gray-600 text-gray-200`}>Keep service</button>
                  </ConfirmBox>
                )}
                {confirm?.kind === 'message' && confirm.id === `text:${name}` && (
                  <ConfirmBox label="Manager needed" text={confirm.text} tone="info">
                    <button type="button" onClick={() => setConfirm(null)} className={`${BTN} border border-gray-600 text-gray-200`}>Got it</button>
                  </ConfirmBox>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Parts (standalone) ── */}
      {partsVisible && (
        <section aria-labelledby="job-parts-heading">
          <h2 id="job-parts-heading" className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-2">
            Parts{partCount > 0 && <span className="text-gray-400 normal-case"> · {partCount}</span>}
          </h2>
          {adding?.kind === 'job' ? (
            <AddPartForm key="job" manager={manager} busy={busy} error={error} attachedTo={null}
              onSubmit={(f) => void addPart(f, null)} onCancel={() => { setAdding(null); setError(null) }} />
          ) : (
            <button type="button" disabled={busy} onClick={() => { setError(null); setConfirm(null); setAdding({ kind: 'job' }) }}
              className="w-full rounded-xl bg-blue-600 text-white font-semibold py-3 min-h-12 active:bg-blue-700 disabled:opacity-40">
              + Add a part
            </button>
          )}

          {grouped.standalone.length > 0 && (
            <ul aria-label="Parts" className="mt-3 rounded-2xl border border-gray-800 bg-gray-900 px-4 divide-y divide-gray-800">
              {grouped.standalone.map((part) => partRow(part, null))}
            </ul>
          )}
          {notice?.at === 'job' && <Notice text={notice.text} />}

          {p.importPanel && (
            <details className="mt-3 group">
              <summary className="min-h-11 flex cursor-pointer list-none items-center justify-between text-sm text-gray-300 [&::-webkit-details-marker]:hidden">
                <span>Add from a PartsTech screenshot</span>
                <span aria-hidden className="text-gray-500 transition-transform group-open:rotate-90">›</span>
              </summary>
              <p className="text-xs text-gray-500 mb-1">Open PartsTech, screenshot the cart, upload it here.</p>
              {p.importPanel}
            </details>
          )}
        </section>
      )}

      {error && !adding && <p role="alert" className="text-red-400 text-sm">{error}</p>}
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

interface PartDraft { name: string; cost: string; price: string; partNumber: string; quantity: string }

/**
 * The add-part form. "What part?" is the one required field (focused on open). Everything else sits
 * under "More details" in this order: Our cost · each (manager), Customer price · each (manager), Part
 * number, Quantity (default 1). Submit says exactly where the part goes.
 */
function AddPartForm({ manager, busy, error, attachedTo, onSubmit, onCancel }: {
  manager: boolean; busy: boolean; error: string | null; attachedTo: string | null
  onSubmit: (f: PartDraft) => void; onCancel: () => void
}) {
  const ids = useId()
  const [f, setF] = useState<PartDraft>({ name: '', cost: '', price: '', partNumber: '', quantity: '1' })
  const nameRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => { formRef.current?.scrollIntoView({ block: 'nearest' }); nameRef.current?.focus() }, [])
  const set = (k: keyof PartDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  const canSubmit = !busy && f.name.trim().length > 0
  return (
    <form ref={formRef} onSubmit={(e) => { e.preventDefault(); if (canSubmit) onSubmit(f) }} noValidate
      aria-label={attachedTo ? `Add part to ${attachedTo}` : 'Add a part to this job'}
      className="mt-2 rounded-2xl border border-gray-700 bg-gray-950/60 p-3 space-y-3">
      {attachedTo && <p className="text-sm font-semibold text-white">Add part to {attachedTo}</p>}
      <label className="block">
        <span className="text-gray-300 text-sm">What part?</span>
        <input ref={nameRef} id={`${ids}-name`} value={f.name} onChange={set('name')} maxLength={200} disabled={busy} placeholder="Cabin air filter" autoComplete="off" className={`${INPUT} mt-1.5`} />
      </label>
      <details className="group">
        <summary className="min-h-11 flex cursor-pointer list-none items-center justify-between text-sm text-gray-200 [&::-webkit-details-marker]:hidden">
          <span>More details <span className="text-gray-500">· optional</span></span>
          <span aria-hidden className="text-gray-400 transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="space-y-3 pt-1">
          {manager && (
            <label className="block">
              <span className="text-gray-300 text-sm">Our cost · each</span>
              <span className="relative block mt-1.5"><span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                <input id={`${ids}-cost`} value={f.cost} onChange={set('cost')} inputMode="decimal" disabled={busy} placeholder="0.00" autoComplete="off" className={`${INPUT} pl-7 tabular-nums`} /></span>
            </label>
          )}
          {manager && (
            <label className="block">
              <span className="text-gray-300 text-sm">Customer price · each</span>
              <span className="relative block mt-1.5"><span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                <input id={`${ids}-price`} value={f.price} onChange={set('price')} inputMode="decimal" disabled={busy} placeholder="0.00" autoComplete="off" className={`${INPUT} pl-7 tabular-nums`} /></span>
            </label>
          )}
          <label className="block">
            <span className="text-gray-300 text-sm">Part number</span>
            <input id={`${ids}-pn`} value={f.partNumber} onChange={set('partNumber')} maxLength={80} disabled={busy} autoComplete="off" autoCapitalize="characters" className={`${INPUT} mt-1.5`} />
          </label>
          <label className="block">
            <span className="text-gray-300 text-sm">Quantity</span>
            <input id={`${ids}-qty`} value={f.quantity} onChange={set('quantity')} inputMode="decimal" disabled={busy} className={`${INPUT} mt-1.5 max-w-[8rem]`} />
          </label>
          <p className="text-xs text-gray-500">
            {manager ? 'Customer price × quantity goes on the invoice and adds to the job total. Our cost is internal only.' : 'A manager adds the customer price.'}
          </p>
        </div>
      </details>
      {error && <p role="alert" className="text-amber-300 text-sm">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!canSubmit} className={`${BTN} flex-1 bg-blue-600 text-white py-3`}>{busy ? 'Saving…' : attachedTo ? 'Add part to service' : 'Add to this job'}</button>
        <button type="button" onClick={onCancel} disabled={busy} className={`${BTN} border border-gray-600 text-gray-200 py-3`}>Cancel</button>
      </div>
    </form>
  )
}
