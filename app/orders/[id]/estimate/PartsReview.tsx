'use client'

/**
 * Estimate parts (special-order + customer-supplied) with their installation-labor review, and the
 * estimate review notices (labor, odor package overlap, odor choice). Every decision is explicit and
 * saved on the server; drafts save freely — only sending/invoicing waits for resolution.
 */
import { useState } from 'react'
import type { EstimateEdit, PartView, ServiceView, ReviewIssue, LaborStatus } from './save-feedback'

const dollars = (c: number) => (c / 100).toFixed(2)
const parseCents = (s: string): number | null => { const t = s.trim(); if (!t) return null; const n = parseFloat(t.replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : null }
const INPUT = 'w-full bg-gray-950 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-base placeholder:text-gray-600'
const BTN = 'rounded-xl font-semibold text-sm px-3 py-2.5 active:opacity-80 disabled:opacity-40'

const LABOR_TEXT: Record<LaborStatus, string> = {
  needs_review: 'Labor not reviewed',
  labor_added: 'Installation labor added',
  included: 'Installation included',
  part_only: 'Part only — no installation',
  waived: 'Labor waived',
}

export function ReviewNotices({ issues, services, busy, post, onChooseOdor }: {
  issues: ReviewIssue[]; services: ServiceView[]; busy: boolean; post: (e: EstimateEdit) => Promise<boolean>; onChooseOdor: (serviceId: string) => void
}) {
  if (issues.length === 0) return null
  const title = (id: string) => services.find((s) => s.id === id)?.title ?? 'this line'
  return (
    <div className="space-y-2" role="region" aria-label="Needs review before sending">
      {issues.map((i) => (
        <div key={i.code} className="rounded-2xl border border-amber-800/70 bg-amber-950/30 px-4 py-3">
          <p className="text-amber-200 text-sm font-semibold">{i.message}</p>
          {i.code === 'odor_overlap' && i.ids.map((id) => (
            <div key={id} className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-amber-100/80 text-xs min-w-0 break-words">“{title(id)}”</span>
              <button type="button" disabled={busy} onClick={() => post({ action: 'remove_service', serviceId: id })} className={`${BTN} bg-amber-600 text-white`}>Remove — package covers it</button>
              <button type="button" disabled={busy} onClick={() => post({ action: 'keep_overlap', serviceId: id })} className={`${BTN} border border-amber-700 text-amber-100`}>Keep both on purpose</button>
            </div>
          ))}
          {i.code === 'odor_choice' && i.ids.map((id) => (
            <button key={id} type="button" disabled={busy} onClick={() => onChooseOdor(id)} className={`${BTN} mt-2 mr-2 bg-amber-600 text-white`}>Choose treatment for “{title(id)}”</button>
          ))}
          {i.code === 'service_as_part' && i.ids.map((id) => {
            const svc = services.find((s) => s.id === id)
            return svc ? <PartLikeReview key={id} service={svc} busy={busy} post={post} /> : null
          })}
          {i.code === 'part_labor' && <p className="text-amber-200/70 text-xs mt-1">Confirm installation for each part in the Parts list above. You can keep editing; sending or invoicing waits until this is resolved.</p>}
        </div>
      ))}
    </div>
  )
}

/** The part wording of a line without the work words ("Replace front windshield" → "Front windshield"). */
function partWords(title: string): string {
  const t = title.replace(/\b(r\s*(?:&|and|\/)\s*r|replace(?:ment)?|install(?:ation|ed)?|new)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : title
}

/**
 * A service line that reads like a part. Clear part wording: convert it (same row, same price/qty/tax)
 * or confirm it's a service. Part + work wording ("Replace windshield", "R&R bumper", tires): keep the
 * line as the labor exactly as priced and add the part separately — or convert the whole line, which
 * keeps its full price as the part price. Nothing is converted or split automatically.
 */
function PartLikeReview({ service, busy, post }: { service: ServiceView; busy: boolean; post: (e: EstimateEdit) => Promise<boolean> }) {
  const [mode, setMode] = useState<'none' | 'clarify'>('none')
  const [f, setF] = useState({ description: partWords(service.title), supply: 'shop' as 'shop' | 'customer', qty: '1', price: '' })
  const ambiguous = service.partLike === 'ambiguous'
  const convert = <button type="button" disabled={busy} onClick={() => post({ action: 'convert_to_part', serviceId: service.id })} className={`${BTN} ${ambiguous ? 'border border-amber-700 text-amber-100' : 'bg-amber-600 text-white'}`}>{ambiguous ? 'Whole line is the part' : 'Convert to part'}</button>
  const isService = <button type="button" disabled={busy} onClick={() => post({ action: 'select_match', serviceId: service.id, custom: true })} className={`${BTN} border border-amber-700 text-amber-100`}>{ambiguous ? 'Labor only — no part' : 'It’s a service'}</button>
  return (
    <div className="mt-2 rounded-xl border border-amber-900/60 bg-gray-950/40 px-3 py-2.5">
      <p className="text-amber-100 text-sm font-semibold break-words">“{service.title}”{service.priceCents != null ? ` · $${dollars(service.priceCents)}` : ''}</p>
      {service.entryText && service.entryText !== service.title && <p className="text-gray-500 text-[11px] break-words">Typed as “{service.entryText}”</p>}
      <p className="text-amber-200/70 text-xs mt-0.5">{ambiguous
        ? 'Could be the part, the work, or both. If we supply the part, add it separately so installation is accounted for.'
        : 'Looks like a part. As a part it gets an installation-labor check; price, quantity and tax stay exactly as they are.'}</p>
      {mode === 'none' && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {ambiguous
            ? <><button type="button" disabled={busy} onClick={() => setMode('clarify')} className={`${BTN} bg-amber-600 text-white col-span-2`}>Keep as labor, add the part…</button>{isService}{convert}</>
            : <>{convert}{isService}<button type="button" disabled={busy} onClick={() => setMode('clarify')} className={`${BTN} border border-amber-700 text-amber-100 col-span-2`}>Clarify — it’s the labor, add the part…</button></>}
        </div>
      )}
      {mode === 'clarify' && (
        <form className="mt-2 grid grid-cols-2 gap-2" onSubmit={(e) => {
          e.preventDefault()
          void post({ action: 'clarify_part', serviceId: service.id, part: { description: f.description, supply: f.supply, quantity: f.qty, sellPriceCents: f.supply === 'shop' ? parseCents(f.price) : null } })
            .then((ok) => { if (ok) setMode('none') })
        }}>
          <p className="col-span-2 text-gray-300 text-xs">“{service.title}” stays as the labor at its current price. The part is added below and linked to it.</p>
          <label className="text-gray-400 text-xs col-span-2">Part<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={`${INPUT} mt-1`} /></label>
          <fieldset className="col-span-2 grid grid-cols-2 gap-2">
            <legend className="sr-only">Who supplies the part?</legend>
            {(['shop', 'customer'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={f.supply === v} onClick={() => setF({ ...f, supply: v })}
                className={`${BTN} ${f.supply === v ? 'bg-blue-600 text-white' : 'border border-gray-600 text-gray-200'}`}>{v === 'shop' ? 'We supply it' : 'Customer’s part'}</button>
            ))}
          </fieldset>
          <label className="text-gray-400 text-xs">Quantity<input value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} inputMode="decimal" className={`${INPUT} mt-1`} /></label>
          {f.supply === 'shop' && <label className="text-gray-400 text-xs">Part price each<input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" placeholder="blank = later" className={`${INPUT} mt-1`} /></label>}
          {f.supply === 'shop' && service.priceCents != null && <p className="col-span-2 text-amber-200/70 text-[11px]">If ${dollars(service.priceCents)} already included the part, lower this line’s price yourself — nothing is split automatically.</p>}
          <div className="col-span-2 flex gap-2"><button type="submit" disabled={busy || !f.description.trim()} className={`${BTN} bg-blue-600 text-white flex-1`}>Add part</button><button type="button" onClick={() => setMode('none')} className={`${BTN} border border-gray-600 text-gray-200`}>Back</button></div>
        </form>
      )}
    </div>
  )
}

export function PartsList({ parts, services, busy, post }: { parts: PartView[]; services: ServiceView[]; busy: boolean; post: (e: EstimateEdit) => Promise<boolean> }) {
  if (parts.length === 0) return null
  return (
    <section aria-label="Parts" className="space-y-2">
      <h2 className="text-gray-500 text-xs uppercase tracking-widest">Parts · special order</h2>
      {parts.map((p) => <PartCard key={p.id} part={p} services={services} busy={busy} post={post} />)}
    </section>
  )
}

function PartCard({ part, services, busy, post }: { part: PartView; services: ServiceView[]; busy: boolean; post: (e: EstimateEdit) => Promise<boolean> }) {
  const [mode, setMode] = useState<'none' | 'add' | 'included' | 'waive' | 'edit' | 'remove'>('none')
  const [laborPrice, setLaborPrice] = useState('')
  const [coverId, setCoverId] = useState('')
  const [reason, setReason] = useState('')
  const [edit, setEdit] = useState({ sell: part.sellPriceCents != null ? dollars(part.sellPriceCents) : '', cost: part.unitCostCents != null ? dollars(part.unitCostCents) : '', qty: String(part.quantity), fitment: part.fitment ?? '', partNumber: part.partNumber ?? '' })
  const open = part.laborStatus === 'needs_review'
  const cover = services.find((s) => s.id === part.laborServiceId)
  const labor = (labor: Record<string, unknown>) => post({ action: 'part_labor', partId: part.id, labor }).then((ok) => { if (ok) setMode('none'); return ok })

  return (
    <div className={`rounded-2xl border px-4 py-3 ${open ? 'border-amber-700/70 bg-amber-950/20' : 'border-gray-800 bg-gray-900'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-semibold break-words">{part.description}</p>
          <p className="text-gray-400 text-xs break-words">
            {part.supply === 'customer' ? 'Customer-supplied · no parts charge' : `Qty ${part.quantity}${part.sellPriceCents != null ? ` × $${dollars(part.sellPriceCents)}` : ' · price not set'}${part.unitCostCents != null ? ` · our cost $${dollars(part.unitCostCents)}` : ''}`}
          </p>
          {part.supply === 'shop' && <p className="text-gray-500 text-[11px] mt-0.5 break-words">Invoice: {part.invoiceText}</p>}
        </div>
        {part.lineCents != null && <span className="text-white tabular-nums shrink-0">${dollars(part.lineCents)}</span>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs ${open ? 'bg-amber-600/30 text-amber-200' : 'bg-gray-800 text-gray-300'}`}>
          {LABOR_TEXT[part.laborStatus]}{cover && !open ? ` · ${cover.title}` : ''}{part.laborStatus === 'waived' && part.laborNote ? ` — ${part.laborNote}` : ''}
        </span>
        {!open && mode === 'none' && <button type="button" disabled={busy} onClick={() => labor({ action: 'reopen' })} className="text-blue-400 text-xs font-semibold min-h-10 px-1 inline-flex items-center">Change</button>}
      </div>

      {open && mode === 'none' && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" disabled={busy} onClick={() => setMode('add')} className={`${BTN} bg-blue-600 text-white`}>Add installation</button>
          <button type="button" disabled={busy} onClick={() => setMode('included')} className={`${BTN} border border-gray-600 text-gray-200`}>Already included</button>
          <button type="button" disabled={busy} onClick={() => labor({ action: 'part_only' })} className={`${BTN} border border-gray-600 text-gray-200`}>Part only</button>
          <button type="button" disabled={busy} onClick={() => setMode('waive')} className={`${BTN} border border-gray-600 text-gray-200`}>Waive labor</button>
        </div>
      )}
      {mode === 'add' && (
        <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); void labor({ action: 'add_labor', cents: parseCents(laborPrice) }) }}>
          <p className="text-gray-300 text-xs">Adds “Installation Labor — {part.description}”. Enter the installation price (blank = price later).</p>
          <input aria-label="Installation price" value={laborPrice} onChange={(e) => setLaborPrice(e.target.value)} inputMode="decimal" placeholder="$" className={INPUT} />
          <div className="flex gap-2"><button type="submit" disabled={busy} className={`${BTN} bg-blue-600 text-white flex-1`}>Add installation labor</button><button type="button" onClick={() => setMode('none')} className={`${BTN} border border-gray-600 text-gray-200`}>Back</button></div>
        </form>
      )}
      {mode === 'included' && (
        <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); if (coverId) void labor({ action: 'included', serviceId: coverId }) }}>
          <label className="text-gray-300 text-xs block" htmlFor={`cover-${part.id}`}>Which line already covers installing this part? (Painting or cleaning a part does not install it.)</label>
          <select id={`cover-${part.id}`} value={coverId} onChange={(e) => setCoverId(e.target.value)} className={INPUT}>
            <option value="">Choose a labor line…</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.title}{s.detail ? ` — ${s.detail}` : ''}</option>)}
          </select>
          <div className="flex gap-2"><button type="submit" disabled={busy || !coverId} className={`${BTN} bg-blue-600 text-white flex-1`}>Link</button><button type="button" onClick={() => setMode('none')} className={`${BTN} border border-gray-600 text-gray-200`}>Back</button></div>
        </form>
      )}
      {mode === 'waive' && (
        <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); void labor({ action: 'waive', reason }) }}>
          <input aria-label="Reason for waiving labor" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Short reason (manager)" className={INPUT} />
          <div className="flex gap-2"><button type="submit" disabled={busy || reason.trim().length < 3} className={`${BTN} bg-amber-600 text-white flex-1`}>Waive installation labor</button><button type="button" onClick={() => setMode('none')} className={`${BTN} border border-gray-600 text-gray-200`}>Back</button></div>
        </form>
      )}

      {mode === 'none' && (
        <div className="mt-2 flex gap-4 text-xs">
          <button type="button" disabled={busy} onClick={() => setMode('edit')} className="text-blue-400 font-semibold min-h-10 px-1 inline-flex items-center">Edit part</button>
          <button type="button" disabled={busy} onClick={() => setMode('remove')} className="text-red-400 font-semibold min-h-10 px-1 inline-flex items-center">Remove</button>
        </div>
      )}
      {mode === 'edit' && (
        <form className="mt-2 grid grid-cols-2 gap-2" onSubmit={(e) => {
          e.preventDefault()
          void post({ action: 'update_part', partId: part.id, patch: { quantity: edit.qty, fitment: edit.fitment, partNumber: edit.partNumber, unitCostCents: parseCents(edit.cost), ...(part.supply === 'shop' ? { sellPriceCents: parseCents(edit.sell) } : {}) } })
            .then((ok) => { if (ok) setMode('none') })
        }}>
          <label className="text-gray-400 text-xs">Quantity<input value={edit.qty} onChange={(e) => setEdit({ ...edit, qty: e.target.value })} inputMode="decimal" className={`${INPUT} mt-1`} /></label>
          <label className="text-gray-400 text-xs">Part #<input value={edit.partNumber} onChange={(e) => setEdit({ ...edit, partNumber: e.target.value })} className={`${INPUT} mt-1`} /></label>
          <label className="text-gray-400 text-xs col-span-2">Fitment<input value={edit.fitment} onChange={(e) => setEdit({ ...edit, fitment: e.target.value })} className={`${INPUT} mt-1`} /></label>
          <label className="text-gray-400 text-xs">Our cost each<input value={edit.cost} onChange={(e) => setEdit({ ...edit, cost: e.target.value })} inputMode="decimal" className={`${INPUT} mt-1`} /></label>
          {part.supply === 'shop' && <label className="text-gray-400 text-xs">Customer price each<input value={edit.sell} onChange={(e) => setEdit({ ...edit, sell: e.target.value })} inputMode="decimal" className={`${INPUT} mt-1`} /></label>}
          <div className="col-span-2 flex gap-2"><button type="submit" disabled={busy} className={`${BTN} bg-blue-600 text-white flex-1`}>Save part</button><button type="button" onClick={() => setMode('none')} className={`${BTN} border border-gray-600 text-gray-200`}>Cancel</button></div>
        </form>
      )}
      {mode === 'remove' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-red-200 text-xs">Remove this part from the estimate?</span>
          <button type="button" disabled={busy} onClick={() => post({ action: 'remove_part', partId: part.id })} className={`${BTN} bg-red-600 text-white`}>Remove part</button>
          <button type="button" onClick={() => setMode('none')} className={`${BTN} border border-gray-600 text-gray-200`}>Keep</button>
        </div>
      )}
    </div>
  )
}
