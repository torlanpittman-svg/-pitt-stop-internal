'use client'

/**
 * Estimate item editors (one service line or one part), opened by tapping a row.
 *
 * Name and price are up front; area, quantity, invoice wording and the catalog match sit under
 * expandable details. Save/Cancel are explicit: nothing is sent until Save, and Save sends only what
 * changed (item-draft.ts). A failed save keeps everything typed and offers Retry. Remove lives here,
 * asks once, and saves immediately — the server-confirmed removal path is unchanged.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { EstimateEdit, PartView, ServiceView } from './save-feedback'
import { dollars, isDirty, partDraftFrom, planPartSave, planServiceSave, rebaseDraft, sameDraft, serviceDraftFrom } from './item-draft'
import ServicePicker from './ServicePicker'
import { LaborControls, PartLikeReview } from './PartsReview'

/** Send one edit. `retry` is what the Retry button re-runs if it fails (default: send it again). */
export type Post = (e: EstimateEdit, retry?: () => void) => Promise<boolean>

const INPUT = 'w-full bg-gray-950 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-base placeholder:text-gray-500 focus:border-blue-500 focus:outline-none disabled:opacity-60'
const BTN = 'rounded-xl font-semibold text-sm px-4 py-3 min-h-11 active:opacity-80 disabled:opacity-40'

/**
 * Save the edits one at a time and stop at the first failure; the draft stays as typed. Retry runs the
 * editor's Save again, which re-plans against the refreshed view and sends only what is still different.
 */
async function runEdits(edits: EstimateEdit[], post: Post, retry: () => void): Promise<boolean> {
  for (const e of edits) if (!(await post(e, retry))) return false
  return true
}

export function More({ summary, open, children }: { summary: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group border-t border-gray-800 py-1">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 text-sm text-gray-200 [&::-webkit-details-marker]:hidden">
        <span>{summary}</span>
        <span aria-hidden className="text-gray-400 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="pb-3 space-y-3">{children}</div>
    </details>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-gray-400 text-sm">{label}</span>
      <span className="block mt-1.5">{children}</span>
      {hint && <span className="block text-gray-400 text-xs mt-1">{hint}</span>}
    </label>
  )
}

function MoneyInput({ value, onChange, disabled, placeholder, label, big }: { value: string; onChange: (v: string) => void; disabled: boolean; placeholder?: string; label: string; big?: boolean }) {
  return (
    <span className="relative block">
      <span aria-hidden className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 ${big ? 'text-lg' : ''}`}>$</span>
      <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" autoComplete="off" disabled={disabled}
        placeholder={placeholder ?? '0.00'} className={`${INPUT} pl-7 tabular-nums ${big ? 'text-xl font-semibold py-3' : ''}`} />
    </span>
  )
}

function RemoveConfirm({ name, what, busy, onRemove }: { name: string; what: string; busy: boolean; onRemove: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return <button type="button" onClick={() => setAsking(true)} disabled={busy} className="mt-4 min-h-11 px-1 text-red-400 text-sm font-semibold active:opacity-70 disabled:opacity-40">Remove {what}</button>
  }
  return (
    <div role="group" aria-label={`Confirm removing ${name}`} className="mt-4 rounded-xl border border-red-900/70 bg-red-950/30 px-4 py-3">
      <p className="text-red-100 text-sm">Remove “{name}” from this estimate? This saves right away.</p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onRemove} disabled={busy} className={`${BTN} bg-red-600 text-white`}>Remove</button>
        <button type="button" onClick={() => setAsking(false)} disabled={busy} className={`${BTN} border border-gray-600 text-gray-200`}>Keep</button>
      </div>
    </div>
  )
}

function Actions({ busy, saving, dirty, onCancel, saveLabel, form }: { busy: boolean; saving: boolean; dirty: boolean; onCancel: () => void; saveLabel: string; form?: string }) {
  return (
    <div className="mt-5 flex gap-2">
      <button type="button" onClick={onCancel} disabled={saving} className={`${BTN} border border-gray-600 text-gray-200`}>Cancel</button>
      <button type="submit" form={form} disabled={busy || !dirty} className={`${BTN} flex-1 bg-blue-600 text-white`}>{saving ? 'Saving…' : saveLabel}</button>
    </div>
  )
}

// ── Service line ─────────────────────────────────────────────────────────────────────────────────
export function ServiceEditor({ service: s, orderId, vehicleLabel, isFlat, busy, post, startRematch, onDirtyChange, onClose }: {
  service: ServiceView; orderId: string; vehicleLabel: string; isFlat: boolean; busy: boolean; post: Post
  startRematch?: boolean; onDirtyChange: (dirty: boolean) => void; onClose: (outcome: 'saved' | 'cancelled' | 'removed') => void
}) {
  const ids = useId()
  const [d, setD] = useState(() => serviceDraftFrom(s))
  // Follow server-side changes to the line for fields the user hasn't edited (see rebaseDraft).
  const server = serviceDraftFrom(s)
  const [prevServer, setPrevServer] = useState(server)
  if (!sameDraft(server, prevServer)) { setPrevServer(server); setD((x) => rebaseDraft(x, prevServer, server)) }
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [rematch, setRematch] = useState(!!startRematch)
  const plan = planServiceSave(s, d, isFlat)
  const dirty = isDirty(plan)
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  const save = async () => {
    if (!plan.ok) { setFormErr(plan.error); return }
    setFormErr(null)
    if (plan.edits.length === 0) { onClose('cancelled'); return }
    setSaving(true)
    const ok = await runEdits(plan.edits, post, () => void saveRef.current())
    setSaving(false)
    if (ok) onClose('saved')
  }
  const saveRef = useRef(save)
  useLayoutEffect(() => { saveRef.current = save })
  const needsMatch = s.matchState === 'choose' || s.matchState === 'unmatched'
  const set = (k: keyof typeof d) => (v: string) => { setD((x) => ({ ...x, [k]: v })); setFormErr(null) }

  return (
    <div>
      {/* The match picker has forms of its own, so it sits outside this form; Save is linked by id. */}
      <form id={`${ids}-form`} onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
        <div className="space-y-4">
          <Field label="Name" hint="Renaming keeps the same catalog service, QuickBooks item, and invoice description.">
            <input id={`${ids}-name`} value={d.title} onChange={(e) => set('title')(e.target.value)} maxLength={200} disabled={saving} className={`${INPUT} text-lg font-semibold`} />
          </Field>
          {isFlat ? (
            <p className="rounded-xl border border-gray-800 bg-gray-900 px-3 py-2.5 text-gray-400 text-sm">This estimate has one flat Work Total. Use “Set individual prices” under the total to price each line.</p>
          ) : (
            <Field label="Price" hint={s.priceCents == null ? 'Leave blank to price later.' : undefined}>
              <MoneyInput label="Price" big value={d.price} onChange={set('price')} disabled={saving} placeholder="Add price" />
              {s.suggestedCents != null && s.suggestedCents !== s.priceCents && d.price !== dollars(s.suggestedCents) && (
                <button type="button" onClick={() => set('price')(dollars(s.suggestedCents!))} disabled={saving} className="mt-1 min-h-11 px-1 text-blue-400 text-sm font-semibold">Use suggested ${dollars(s.suggestedCents)}</button>
              )}
            </Field>
          )}
        </div>

        <div className="mt-4">
          <More summary={<>Area / component{s.detail ? <span className="text-gray-400"> · {s.detail}</span> : null}</>}>
            <Field label="Area or component (optional)" hint="Added to the invoice line, e.g. “passenger seat”.">
              <input value={d.detail} onChange={(e) => set('detail')(e.target.value)} maxLength={120} disabled={saving} placeholder="e.g. passenger seat" className={INPUT} />
            </Field>
            <p className="text-gray-400 text-xs">Quantity and tax stay as saved on this line.</p>
          </More>
        </div>
      </form>
      <div>
          <More open={needsMatch || !!s.partLike} summary={<>Invoice wording &amp; service match{needsMatch && <span className="ml-2 rounded-full bg-amber-600/30 px-2 py-0.5 text-xs text-amber-200">Needs review</span>}</>}>
            <MatchSummary s={s} />
            {s.partLike && s.matchState === 'unmatched' && <PartLikeReview service={s} busy={busy} post={post} />}
            {rematch ? (
              <ServicePicker orderId={orderId} mode="rematch" service={s} busy={busy} isFlat={isFlat} vehicleLabel={vehicleLabel} onSave={post} onClose={() => setRematch(false)} />
            ) : (
              <button type="button" onClick={() => setRematch(true)} disabled={busy}
                className={`${needsMatch ? `${BTN} w-full bg-amber-600 text-white` : 'min-h-11 px-1 text-blue-400 text-sm font-semibold'}`}>
                {s.matchState === 'choose' ? 'Choose which odor treatment' : needsMatch ? 'Choose the catalog service' : 'Change service match'}
              </button>
            )}
          </More>
      </div>
      {formErr && <p role="alert" className="mt-3 text-amber-300 text-sm">{formErr}</p>}
      <Actions form={`${ids}-form`} busy={busy} saving={saving} dirty={dirty} onCancel={() => onClose('cancelled')} saveLabel="Save changes" />
      {/* A confirmed removal closes the editor (EstimateBuilder closes it once the line is gone). */}
      <RemoveConfirm name={s.title} what="item" busy={busy} onRemove={() => { void post({ action: 'remove_service', serviceId: s.id }) }} />
    </div>
  )
}

/** The catalog service behind the line and exactly what the invoice line says (approved wording). */
function MatchSummary({ s }: { s: ServiceView }) {
  if (s.matchState === 'choose') return <p className="text-amber-200 text-sm">This could be Air Duct Cleaning, Ozone Treatment, or the Complete Odor Treatment (both). Choose which one before sending or invoicing.</p>
  if (s.matchState === 'unmatched' && s.partLike) return <p className="text-amber-200 text-sm">{s.partLike === 'part' ? 'This looks like a part.' : 'This could be a part, the labor, or both.'} Choose below.</p>
  if (s.matchState === 'unmatched') return <p className="text-amber-200 text-sm">Not matched to a catalog service yet, so there is no approved invoice wording. Choose the service below.</p>
  return (
    <div className="rounded-xl bg-gray-950 border border-gray-800 px-3 py-2.5">
      <p className="text-gray-400 text-xs">{s.matchState === 'custom' ? 'Custom service · bills as Labor' : 'Catalog service'}</p>
      {s.matchState !== 'custom' && <p className="text-white text-sm font-semibold">{s.catalogName ?? s.title}</p>}
      <p className="text-gray-300 text-sm mt-1"><span className="text-gray-400">Invoice reads: </span>{s.description}</p>
      {s.matchState === 'matched' && s.qbMapped === false && <p className="text-gray-400 text-xs mt-1">QuickBooks item pending review — bills as Labor.</p>}
      {s.overlapAcknowledged && <p className="text-gray-400 text-xs mt-1">Kept alongside Complete Odor Treatment on purpose.</p>}
    </div>
  )
}

// ── Part ─────────────────────────────────────────────────────────────────────────────────────────
export function PartEditor({ part: p, services, busy, post, onDirtyChange, onClose }: {
  part: PartView; services: ServiceView[]; busy: boolean; post: Post
  onDirtyChange: (dirty: boolean) => void; onClose: (outcome: 'saved' | 'cancelled' | 'removed') => void
}) {
  const [d, setD] = useState(() => partDraftFrom(p))
  const server = partDraftFrom(p)
  const [prevServer, setPrevServer] = useState(server)
  if (!sameDraft(server, prevServer)) { setPrevServer(server); setD((x) => rebaseDraft(x, prevServer, server)) }
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const plan = planPartSave(p, d)
  const dirty = isDirty(plan)
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  const set = (k: keyof typeof d) => (v: string) => { setD((x) => ({ ...x, [k]: v })); setFormErr(null) }
  const shop = p.supply === 'shop'

  const save = async () => {
    if (!plan.ok) { setFormErr(plan.error); return }
    setFormErr(null)
    if (plan.edits.length === 0) { onClose('cancelled'); return }
    setSaving(true)
    const ok = await runEdits(plan.edits, post, () => void saveRef.current())
    setSaving(false)
    if (ok) onClose('saved')
  }
  const saveRef = useRef(save)
  useLayoutEffect(() => { saveRef.current = save })

  return (
    <div>
      <form onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
        <p className="mb-3 inline-flex rounded-md bg-sky-900/50 px-2 py-0.5 text-xs font-semibold text-sky-200">{shop ? 'Special-order part' : 'Customer-supplied part'}</p>
        <div className="space-y-4">
          <Field label="Part">
            <input value={d.description} onChange={(e) => set('description')(e.target.value)} maxLength={200} disabled={saving} className={`${INPUT} text-lg font-semibold`} />
          </Field>
          {shop ? (
            <Field label="Customer price each" hint={p.sellPriceCents == null ? 'Leave blank to price later.' : undefined}>
              <MoneyInput label="Customer price each" big value={d.sell} onChange={set('sell')} disabled={saving} placeholder="Add price" />
            </Field>
          ) : <p className="text-gray-400 text-sm">Customer supplies this part — no parts charge.</p>}
        </div>

        <div className="mt-4">
          <More summary={<>Quantity &amp; details<span className="text-gray-400"> · Qty {p.quantity}</span></>}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quantity"><input value={d.quantity} onChange={(e) => set('quantity')(e.target.value)} inputMode="decimal" disabled={saving} className={INPUT} /></Field>
              <Field label="Vendor part #"><input value={d.partNumber} onChange={(e) => set('partNumber')(e.target.value)} maxLength={80} disabled={saving} className={INPUT} /></Field>
            </div>
            <Field label="Vehicle fitment"><input value={d.fitment} onChange={(e) => set('fitment')(e.target.value)} maxLength={200} disabled={saving} className={INPUT} /></Field>
            {shop && <Field label="Vendor"><input value={d.supplier} onChange={(e) => set('supplier')(e.target.value)} maxLength={120} disabled={saving} className={INPUT} /></Field>}
            <Field label="Our cost each (internal)"><MoneyInput label="Our cost each" value={d.cost} onChange={set('cost')} disabled={saving} placeholder="" /></Field>
          </More>
          {shop && (
            <More summary="Invoice wording">
              <p className="rounded-xl bg-gray-950 border border-gray-800 px-3 py-2.5 text-gray-300 text-sm">{p.invoiceText}</p>
            </More>
          )}
        </div>

        {formErr && <p role="alert" className="mt-3 text-amber-300 text-sm">{formErr}</p>}
        <Actions busy={busy} saving={saving} dirty={dirty} onCancel={() => onClose('cancelled')} saveLabel="Save part" />
      </form>

      <section aria-label="Installation labor" className={`mt-5 rounded-2xl border px-4 py-3 ${p.laborStatus === 'needs_review' ? 'border-amber-700/70 bg-amber-950/20' : 'border-gray-800 bg-gray-900'}`}>
        <h3 className="text-sm font-semibold text-white mb-2">Installation labor</h3>
        <LaborControls part={p} services={services} busy={busy} post={post} />
        {p.laborStatus === 'needs_review' && <p className="text-amber-200/70 text-xs mt-2">Sending or invoicing waits until installation is confirmed. Each choice saves right away.</p>}
      </section>

      <RemoveConfirm name={p.description} what="part" busy={busy} onRemove={() => { void post({ action: 'remove_part', partId: p.id }) }} />
    </div>
  )
}
