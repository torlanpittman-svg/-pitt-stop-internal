'use client'

/**
 * Installation-labor decisions for estimate parts (special-order + customer-supplied), and the
 * estimate review notices (labor, service choices for odor/ambiguous names, part-like lines). Every decision is explicit and
 * saved on the server; drafts save freely — only sending/invoicing waits for resolution.
 */
import { useState } from 'react'
import type { EstimateEdit, PartView, ServiceView, ReviewIssue, LaborStatus } from './save-feedback'

const dollars = (c: number) => (c / 100).toFixed(2)
const parseCents = (s: string): number | null => { const t = s.trim(); if (!t) return null; const n = parseFloat(t.replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : null }
const INPUT = 'w-full bg-gray-950 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-base placeholder:text-gray-600'
const BTN = 'rounded-xl font-semibold text-sm px-3 py-2.5 min-h-11 active:opacity-80 disabled:opacity-40'

const LABOR_TEXT: Record<LaborStatus, string> = {
  needs_review: 'Labor not reviewed',
  labor_added: 'Installation labor added',
  included: 'Installation included',
  part_only: 'Part only — no installation',
  waived: 'Labor waived',
}

export function ReviewNotices({ issues, services, parts, busy, post, onChooseOdor }: {
  issues: ReviewIssue[]; services: ServiceView[]; parts: PartView[]; busy: boolean; post: (e: EstimateEdit) => Promise<boolean>; onChooseOdor: (serviceId: string) => void
}) {
  if (issues.length === 0) return null
  const title = (id: string) => services.find((s) => s.id === id)?.title ?? 'this line'
  return (
    <div className="space-y-2" role="region" aria-label="Needs review before sending">
      {issues.map((i) => (
        <div key={i.code} className="rounded-2xl border border-amber-800/70 bg-amber-950/30 px-4 py-3">
          <p className="text-amber-200 text-sm font-semibold">{i.message}</p>
          {(i.code === 'odor_choice' || i.code === 'ceramic_choice' || i.code === 'name_choice') && i.ids.map((id) => (
            <button key={id} type="button" disabled={busy} onClick={() => onChooseOdor(id)} className={`${BTN} mt-2 mr-2 bg-amber-600 text-white`}>Choose the service for “{title(id)}”</button>
          ))}
          {i.code === 'service_as_part' && i.ids.map((id) => {
            const svc = services.find((s) => s.id === id)
            return svc ? <PartLikeReview key={id} service={svc} busy={busy} post={post} /> : null
          })}
          {i.code === 'part_labor' && <BulkLaborReview open={parts.filter((p) => p.laborStatus === 'needs_review')} services={services} busy={busy} post={post} />}
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
export function PartLikeReview({ service, busy, post }: { service: ServiceView; busy: boolean; post: (e: EstimateEdit) => Promise<boolean> }) {
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

/** Installation-labor lines on the invoice (catalog role 'installation'); declined lines never cover anything. */
export function laborLineChoices(services: ServiceView[]): { choices: ServiceView[]; installOnly: boolean; preselectId: string } {
  const work = services.filter((s) => !s.declined)
  const install = work.filter((s) => s.role === 'installation')
  // Exactly one installation line → use it. Several → the manager picks. None → any work line may be
  // chosen, but nothing unrelated (a detail, a wash) is ever preselected.
  return { choices: install.length ? install : work, installOnly: install.length > 0, preselectId: install.length === 1 ? install[0].id : '' }
}

/**
 * One labor decision for all the parts still waiting on review: every open part is listed and
 * selected (untick the exceptions), then "covered by this labor line" or "part only" is saved for the
 * selection in one request. It only records the decision — no labor line, price or quantity changes.
 * The list is always the server's saved state, so it never shows more parts reviewed than were saved.
 * "Other options" on a row keeps the full one-part review (add installation, waive, …).
 */
export function BulkLaborReview({ open, services, busy, post }: { open: PartView[]; services: ServiceView[]; busy: boolean; post: (e: EstimateEdit) => Promise<boolean> }) {
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [picked, setPicked] = useState('')
  const [single, setSingle] = useState<string | null>(null)
  const { choices, installOnly, preselectId } = laborLineChoices(services)
  const laborId = choices.some((s) => s.id === picked) ? picked : preselectId
  const selected = open.filter((p) => !skipped.has(p.id))
  const toggle = (id: string) => setSkipped((prev) => new Set(prev.has(id) ? [...prev].filter((x) => x !== id) : [...prev, id]))
  const save = (labor: Record<string, unknown>) => { if (selected.length) void post({ action: 'part_labor_bulk', partIds: selected.map((p) => p.id), labor }) }
  if (open.length === 0) return null
  return (
    <div className="mt-2 space-y-3">
      <ul className="space-y-1.5" aria-label="Parts that need labor review">
        {open.map((p) => (
          <li key={p.id} className="rounded-xl border border-amber-900/60 bg-gray-950/40 px-3 py-1.5">
            <div className="flex items-center gap-2">
              <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input type="checkbox" className="h-5 w-5 shrink-0 accent-blue-500" checked={!skipped.has(p.id)} disabled={busy} onChange={() => toggle(p.id)} />
                <span className="min-w-0 break-words text-sm font-semibold text-amber-100">{p.description}{p.quantity !== 1 ? <span className="font-normal text-gray-400"> × {p.quantity}</span> : null}</span>
              </label>
              <button type="button" aria-expanded={single === p.id} onClick={() => setSingle(single === p.id ? null : p.id)} className="min-h-11 shrink-0 px-2 text-xs font-semibold text-blue-400" aria-label={`${single === p.id ? 'Close' : 'Other'} labor options for ${p.description}`}>{single === p.id ? 'Close' : 'Other options'}</button>
            </div>
            {single === p.id && <div className="pb-2"><LaborControls part={p} services={services} busy={busy} post={post} /></div>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-300" aria-live="polite">{selected.length} of {open.length} selected</p>

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs text-gray-300">{choices.length === 0
          ? 'There is no labor line on this invoice yet. Use “Other options” on a part to add installation labor, or mark the parts as part only.'
          : installOnly ? 'Installation labor that covers the selected parts' : 'No installation labor line on this invoice. Choose the line that covers installing the selected parts (painting or cleaning a part does not install it).'}</legend>
        {choices.map((s) => (
          <label key={s.id} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 ${laborId === s.id ? 'border-blue-500 bg-blue-950/40' : 'border-gray-700 bg-gray-950/40'}`}>
            <input type="radio" name="bulk-labor-line" className="h-5 w-5 shrink-0 accent-blue-500" checked={laborId === s.id} disabled={busy} onChange={() => setPicked(s.id)} />
            <span className="min-w-0 flex-1 break-words text-sm text-white">{s.title}{s.detail ? <span className="text-gray-300"> — {s.detail}</span> : null}</span>
            <span className="shrink-0 text-sm tabular-nums text-gray-200">{s.priceCents != null ? `$${dollars(s.priceCents)}` : 'No price yet'}</span>
          </label>
        ))}
      </fieldset>

      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" disabled={busy || selected.length === 0 || !laborId} onClick={() => save({ action: 'included', serviceId: laborId })} className={`${BTN} bg-blue-600 text-white`}>Mark selected parts as covered</button>
        <button type="button" disabled={busy || selected.length === 0} onClick={() => save({ action: 'part_only' })} className={`${BTN} border border-gray-600 text-gray-200`}>Part only — no installation</button>
      </div>
      <p className="text-[11px] text-gray-400">{selected.length === 0 ? 'Select at least one part.' : choices.length > 0 && !laborId ? 'Choose the labor line to mark parts as covered.' : 'This only records the labor decision. Prices, quantities and the total stay exactly as they are.'}</p>
    </div>
  )
}

/** Installation-labor decision for one part. Every choice saves immediately and is audited server-side. */
export function LaborControls({ part, services, busy, post }: { part: PartView; services: ServiceView[]; busy: boolean; post: (e: EstimateEdit) => Promise<boolean> }) {
  const [mode, setMode] = useState<'none' | 'add' | 'included' | 'waive'>('none')
  const [laborPrice, setLaborPrice] = useState('')
  const [coverId, setCoverId] = useState('')
  const [reason, setReason] = useState('')
  const open = part.laborStatus === 'needs_review'
  const cover = services.find((s) => s.id === part.laborServiceId)
  const labor = (labor: Record<string, unknown>) => post({ action: 'part_labor', partId: part.id, labor }).then((ok) => { if (ok) setMode('none'); return ok })

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs ${open ? 'bg-amber-600/30 text-amber-200' : 'bg-gray-800 text-gray-300'}`}>
          {LABOR_TEXT[part.laborStatus]}{cover && !open ? ` · ${cover.title}` : ''}{part.laborStatus === 'waived' && part.laborNote ? ` — ${part.laborNote}` : ''}
        </span>
        {!open && mode === 'none' && <button type="button" disabled={busy} onClick={() => labor({ action: 'reopen' })} className="text-blue-400 text-xs font-semibold min-h-11 px-2 inline-flex items-center" aria-label={`Change installation labor for ${part.description}`}>Change</button>}
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
    </div>
  )
}
