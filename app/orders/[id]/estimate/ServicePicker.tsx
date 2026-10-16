'use client'

/**
 * Estimate service picker — rushed wording in, a confirmed catalog service out.
 *
 *  - Shortcuts (manager-managed) add a known service in one tap.
 *  - Free text ("shamp pass seat") is interpreted on the server: established matches confirm in one
 *    tap; uncertain ones show a few real catalog choices (AI-assisted); generic odor asks which
 *    treatment; parts and tires get their own short flows.
 *  - The user always sees the selected service and EXACTLY what the invoice line will say, can
 *    correct it, and can browse the full catalog or explicitly add a custom service.
 *  - Matching never sets a price: a price is saved only when typed (or the default is tapped).
 * Also used in "rematch" mode to correct the service behind an existing line.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EstimateEdit, ServiceView } from './save-feedback'

export interface CatalogChoice { catalogId: string; slug: string; name: string; description: string; role: string | null; defaultPriceCents: number | null; tiered: boolean; qbMapped: boolean }
interface Shortcut { id: string; catalogId: string; label: string; group: string }
interface Interpretation {
  entry: string; corrected: string; status: 'resolved' | 'choose' | 'none'
  intent: 'service' | 'part' | 'part_and_service' | 'odor' | 'tires' | 'unknown'
  candidates: { catalogId: string; via: 'exact' | 'alias' | 'rule' | 'keyword' | 'ai' }[]
  area: string | null; part: { description: string } | null; question: string | null
}
interface InterpretResponse { interpretation: Interpretation; choices: CatalogChoice[]; ai: 'used' | 'unavailable' | 'failed' | 'skipped' }

const dollars = (c: number) => (c / 100).toFixed(2)
const parseCents = (s: string): number | null => { const t = s.trim(); if (!t) return null; const n = parseFloat(t.replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : null }
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const DETAIL_SEP = ' — '
const preview = (base: string, detail: string) => { const d = detail.trim().replace(/\s+/g, ' '); return d && !base.toLowerCase().includes(d.toLowerCase()) ? `${base}${DETAIL_SEP}${d}` : base }
const methodFor = (via: string | undefined): string => via === 'exact' ? 'exact' : via === 'alias' ? 'alias' : via === 'rule' ? 'rule' : via === 'shortcut' ? 'shortcut' : via === 'browse' ? 'manual' : 'suggestion'

const INPUT = 'w-full bg-gray-950 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-base placeholder:text-gray-600'
const BTN = 'rounded-xl font-semibold text-sm px-4 py-2.5 min-h-11 active:opacity-80 disabled:opacity-40'
const CHIP = 'shrink-0 min-h-11 rounded-full border border-gray-700 bg-gray-900 px-3.5 py-2 text-sm text-gray-100 active:bg-gray-800 disabled:opacity-40'

async function api(orderId: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/workflow/orders/${orderId}/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok || d.ok !== true) throw new Error(typeof d.error === 'string' ? d.error : `The server returned an error (${res.status}).`)
  return d
}

export default function ServicePicker({ orderId, mode, service, busy, isFlat, vehicleLabel, onSave, onClose, onAdded }: {
  orderId: string; mode: 'add' | 'rematch'; service?: ServiceView; busy: boolean; isFlat: boolean; vehicleLabel: string
  onSave: (edit: EstimateEdit) => Promise<boolean>; onClose?: () => void
  /** Add mode: called once the server confirmed the new service, part, or tire work. */
  onAdded?: () => void
}) {
  const [entry, setEntry] = useState(mode === 'rematch' ? (service?.entryText || service?.title || '') : '')
  const [result, setResult] = useState<InterpretResponse | null>(null)
  const [looking, setLooking] = useState(false)
  const [lookErr, setLookErr] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogChoice[] | null>(null)
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([])
  const [picked, setPicked] = useState<{ choice: CatalogChoice; via: string; label?: string } | null>(null)
  const [panel, setPanel] = useState<'none' | 'browse' | 'part' | 'tires' | 'custom'>('none')

  useEffect(() => {
    let live = true
    api(orderId, { action: 'catalog_list' }).then((d) => { if (live) { setCatalog(d.catalog ?? []); setShortcuts(d.shortcuts ?? []) } }).catch(() => { if (live) setCatalog([]) })
    return () => { live = false }
  }, [orderId])
  const byId = useMemo(() => new Map((catalog ?? []).map((c) => [c.catalogId, c])), [catalog])

  const reset = () => { setResult(null); setPicked(null); setPanel('none'); setLookErr(null) }
  const interpret = useCallback(async (text = entry) => {
    if (!text.trim()) return
    setLooking(true); setLookErr(null); setPicked(null); setPanel('none')
    try {
      const d = (await api(orderId, { action: 'interpret', entry: text })) as InterpretResponse
      setResult(d)
      const it = d.interpretation
      if (it.status === 'resolved' && d.choices[0]) setPicked({ choice: d.choices[0], via: it.candidates[0]?.via })
      if (it.intent === 'tires') setPanel('tires')
    } catch (e) {
      // Never lose the entry: fall back to manual selection.
      setLookErr(e instanceof Error ? e.message : 'Couldn’t look that up.'); setResult(null); setPanel('browse')
    } finally { setLooking(false) }
  }, [entry, orderId])

  const it = result?.interpretation
  const area = it?.area ?? ''

  // ── Save paths ──────────────────────────────────────────────────────────────────────────────
  const saveChoice = async (p: { choice: CatalogChoice | null; via: string; label?: string; detail: string; cents: number | null; remember: boolean; aliasText: string }) => {
    const common = { detail: p.detail.trim() || null, entryText: entry.trim() || null, rememberAlias: p.remember, aliasText: p.aliasText }
    let ok: boolean
    if (mode === 'rematch' && service) {
      // Retitle only when the old title just mirrored the old match (or nothing was matched).
      const retitle = !service.catalogName || norm(service.title) === norm(service.catalogName) || service.matchState === 'choose' || service.matchState === 'unmatched'
      ok = await onSave({ action: 'select_match', serviceId: service.id, ...common, ...(p.choice ? { catalogId: p.choice.catalogId } : { custom: true }),
        ...(retitle && p.choice ? { title: p.label || p.choice.name } : {}), matchMethod: p.choice ? methodFor(p.via) : 'custom' })
    } else {
      const edit: EstimateEdit = { action: 'add_service', title: p.choice ? (p.label || p.choice.name) : entry.trim(), ...common,
        ...(p.choice ? { catalogId: p.choice.catalogId, matchMethod: methodFor(p.via) } : { custom: true, matchMethod: 'custom' }) }
      if (p.cents != null && !isFlat) edit.cents = p.cents
      ok = await onSave(edit)
    }
    if (ok) { setEntry(''); reset(); if (mode === 'add') onAdded?.(); onClose?.() }
  }

  const choices = result?.choices ?? []
  const showAiNote = result && result.ai !== 'used' && result.ai !== 'skipped' && it?.status !== 'resolved'

  return (
    <section aria-label={mode === 'add' ? 'Add a service' : 'Change service'} className={mode === 'add' ? 'space-y-3' : 'rounded-2xl border border-gray-800 bg-gray-900/60 p-3 space-y-3'}>
      <form onSubmit={(e) => { e.preventDefault(); void interpret() }} className="flex gap-2">
        <label className="sr-only" htmlFor={`entry-${mode}-${service?.id ?? 'new'}`}>{mode === 'add' ? 'What are we doing?' : 'Describe the work'}</label>
        <input id={`entry-${mode}-${service?.id ?? 'new'}`} value={entry} onChange={(e) => { setEntry(e.target.value); if (result) reset() }} maxLength={300}
          placeholder={mode === 'add' ? 'What are we doing? e.g. “shamp pass seat”' : 'Describe the work'} autoComplete="off" autoCapitalize="none"
          className={`${INPUT} flex-1 min-w-0`} disabled={busy} />
        <button type="submit" disabled={busy || looking || !entry.trim()} className={`${BTN} bg-blue-600 text-white shrink-0`}>{looking ? '…' : 'Find'}</button>
      </form>

      {mode === 'add' && shortcuts.length > 0 && !picked && panel === 'none' && !result && (
        <ShortcutChips shortcuts={shortcuts} byId={byId} busy={busy} onPick={(s) => { const c = byId.get(s.catalogId); if (c) { setResult(null); setPicked({ choice: c, via: 'shortcut', label: s.label }) } }} />
      )}

      {lookErr && <p className="text-amber-300 text-xs">Couldn’t interpret that right now ({lookErr}). Your wording is kept — pick the service below.</p>}
      {showAiNote && <p className="text-gray-400 text-xs">AI suggestions are unavailable right now — showing direct matches. Your wording is kept; pick below or browse all services.</p>}
      {it && it.corrected && norm(it.corrected) !== norm(it.entry) && !picked && <p className="text-gray-500 text-xs">Read as: “{it.corrected}”</p>}

      {/* One clear choice (established match, shortcut, or a tapped suggestion) */}
      {picked && (
        <ConfirmChoice key={picked.choice.catalogId} choice={picked.choice} label={picked.label} via={picked.via} entry={entry} initialDetail={area}
          busy={busy} isFlat={isFlat} mode={mode} onCancel={() => setPicked(null)}
          onConfirm={(o) => saveChoice({ choice: picked.choice, via: picked.via, label: picked.label, ...o })} />
      )}

      {/* Several plausible services / a short question */}
      {!picked && it && it.status === 'choose' && it.intent !== 'tires' && it.intent !== 'part' && (
        <div className="space-y-2">
          {it.question && <p className="text-white text-sm font-semibold">{it.question}</p>}
          <ul className="space-y-2">
            {choices.map((c) => {
              const via = it.candidates.find((x) => x.catalogId === c.catalogId)?.via
              return (
                <li key={c.catalogId}>
                  <button type="button" disabled={busy} onClick={() => setPicked({ choice: c, via: via ?? 'suggestion' })}
                    className="w-full text-left rounded-xl border border-gray-700 bg-gray-950 px-3 py-2.5 active:bg-gray-800 disabled:opacity-40">
                    <span className="flex items-center gap-2"><span className="text-white text-sm font-semibold">{c.name}</span>{via === 'ai' && <span className="text-[10px] uppercase tracking-wide text-blue-300/80">suggested</span>}</span>
                    <span className="block text-gray-400 text-xs mt-0.5 line-clamp-2">{c.description}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Looks like a physical part */}
      {!picked && it && (it.intent === 'part' || it.intent === 'part_and_service') && panel !== 'part' && (
        <div className="rounded-xl border border-blue-900/60 bg-blue-950/30 px-3 py-2.5">
          <p className="text-blue-100 text-sm font-semibold">This looks like a part{it.part ? `: ${it.part.description}` : ''}.</p>
          <p className="text-blue-200/70 text-xs mt-0.5">Parts are special-ordered for this job. After adding it, you’ll confirm installation labor.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => setPanel('part')} className={`${BTN} bg-blue-600 text-white`}>Add as part</button>
            <button type="button" disabled={busy} onClick={() => setPanel('browse')} className={`${BTN} border border-gray-600 text-gray-200`}>It’s a service</button>
          </div>
        </div>
      )}

      {panel === 'part' && mode === 'add' && (
        <PartForm initialDescription={it?.part?.description ?? entry} vehicleLabel={vehicleLabel} busy={busy} entry={entry}
          onCancel={() => setPanel('none')} onSave={async (part) => { if (await onSave({ action: 'add_part', part })) { setEntry(''); reset(); onAdded?.() } }} />
      )}
      {panel === 'tires' && mode === 'add' && (
        <TireForm busy={busy} entry={entry} onCancel={() => setPanel('none')} onSave={async (tires) => { if (await onSave({ action: 'add_tires', tires })) { setEntry(''); reset(); onAdded?.() } }} />
      )}

      {/* Nothing matched → explicit choices */}
      {!picked && it && it.status === 'none' && panel === 'none' && (
        <p className="text-gray-300 text-sm">No catalog service matches “{it.entry}”. Browse all services, or add it as a custom service.</p>
      )}

      {!picked && (result || lookErr || mode === 'rematch') && panel !== 'part' && panel !== 'tires' && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setPanel(panel === 'browse' ? 'none' : 'browse')} disabled={busy} className={`${BTN} border border-gray-600 text-gray-200`}>{panel === 'browse' ? 'Hide list' : 'Browse all services'}</button>
          {entry.trim() && <button type="button" onClick={() => setPanel('custom')} disabled={busy} className={`${BTN} border border-gray-600 text-gray-200`}>Custom service…</button>}
          {mode === 'add' && <button type="button" onClick={() => setPanel('part')} disabled={busy} className={`${BTN} border border-gray-600 text-gray-200`}>Add a part…</button>}
        </div>
      )}
      {mode === 'add' && !result && !picked && panel === 'none' && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <button type="button" onClick={() => setPanel('browse')} className="text-blue-400 font-semibold min-h-11 px-1 inline-flex items-center">Browse all services</button>
          <button type="button" onClick={() => setPanel('part')} className="text-blue-400 font-semibold min-h-11 px-1 inline-flex items-center">Add a part</button>
          <button type="button" onClick={() => setPanel('tires')} className="text-blue-400 font-semibold min-h-11 px-1 inline-flex items-center">Tires</button>
        </div>
      )}

      {panel === 'browse' && !picked && <BrowseList catalog={catalog} busy={busy} onPick={(c) => setPicked({ choice: c, via: 'browse' })} />}

      {panel === 'custom' && !picked && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-3 py-2.5 space-y-2">
          <p className="text-amber-200 text-sm font-semibold">Add “{entry.trim()}” as a custom service?</p>
          <p className="text-amber-200/70 text-xs">It isn’t in the service catalog, so the invoice line uses the generic Labor item with exactly this wording. A manager can add it to the catalog later in Manage services.</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => saveChoice({ choice: null, via: 'custom', detail: '', cents: null, remember: false, aliasText: '' })} className={`${BTN} bg-amber-600 text-white`}>Yes, custom service</button>
            <button type="button" disabled={busy} onClick={() => setPanel('none')} className={`${BTN} border border-gray-600 text-gray-200`}>Back</button>
          </div>
        </div>
      )}

      {onClose && <button type="button" onClick={onClose} disabled={busy} className="text-gray-400 text-sm min-h-11 px-1">Cancel</button>}
    </section>
  )
}

function ShortcutChips({ shortcuts, byId, busy, onPick }: { shortcuts: Shortcut[]; byId: Map<string, CatalogChoice>; busy: boolean; onPick: (s: Shortcut) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, Shortcut[]>()
    for (const s of shortcuts) if (byId.has(s.catalogId)) (m.get(s.group) ?? m.set(s.group, []).get(s.group)!).push(s)
    return [...m.entries()]
  }, [shortcuts, byId])
  return (
    <div className="space-y-2" aria-label="Service shortcuts">
      {groups.map(([g, list]) => (
        <div key={g}>
          <p className="text-gray-500 text-[11px] uppercase tracking-widest mb-1">{g}</p>
          <div className="flex flex-wrap gap-1.5">
            {list.map((s) => <button key={s.id} type="button" disabled={busy} onClick={() => onPick(s)} className={CHIP}>{s.label}</button>)}
          </div>
        </div>
      ))}
    </div>
  )
}

function ConfirmChoice({ choice, label, via, entry, initialDetail, busy, isFlat, mode, onCancel, onConfirm }: {
  choice: CatalogChoice; label?: string; via: string; entry: string; initialDetail: string; busy: boolean; isFlat: boolean; mode: 'add' | 'rematch'
  onCancel: () => void; onConfirm: (o: { detail: string; cents: number | null; remember: boolean; aliasText: string }) => void
}) {
  const [detail, setDetail] = useState(initialDetail)
  const [price, setPrice] = useState('')
  const [remember, setRemember] = useState(false)
  const typedOther = entry.trim() && norm(entry) !== norm(choice.name) && via !== 'shortcut' && via !== 'exact' && via !== 'alias'
  // The reusable phrase is the wording minus the job-specific area words ("shamp pass seat" → "shamp").
  const areaWords = new Set(initialDetail.toLowerCase().split(/[\s-]+/).filter(Boolean))
  const [aliasText, setAliasText] = useState(() => entry.trim().split(/\s+/).filter((w) => !areaWords.has(w.toLowerCase())).join(' ') || entry.trim())
  const established = via === 'exact' || via === 'alias' || via === 'rule' || via === 'shortcut'
  return (
    <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/20 px-3 py-3 space-y-2.5">
      <div>
        <p className="text-emerald-300 text-[11px] uppercase tracking-widest">{established ? 'Service' : 'Suggested service — confirm'}</p>
        <p className="text-white font-semibold">{label || choice.name}{label && label !== choice.name && <span className="text-gray-400 font-normal text-sm"> · {choice.name}</span>}</p>
        <p className="text-gray-400 text-xs mt-1"><span className="text-gray-500">Invoice will read: </span>{preview(choice.description, detail)}</p>
        {!choice.qbMapped && <p className="text-amber-300/80 text-[11px] mt-1">QuickBooks item not confirmed yet — bills as Labor with this description.</p>}
      </div>
      <div>
        <label className="text-gray-400 text-xs" htmlFor={`detail-${choice.catalogId}`}>Area / component (optional)</label>
        <input id={`detail-${choice.catalogId}`} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={120} placeholder="e.g. passenger seat" className={`${INPUT} mt-1`} disabled={busy} />
      </div>
      {mode === 'add' && !isFlat && (
        <div>
          <label className="text-gray-400 text-xs" htmlFor={`price-${choice.catalogId}`}>Price</label>
          <div className="mt-1 flex items-center gap-2">
            <input id={`price-${choice.catalogId}`} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder={choice.tiered ? 'by size — enter' : 'enter price'} className={`${INPUT} w-36`} disabled={busy} />
            {choice.defaultPriceCents != null && !price && (
              <button type="button" onClick={() => setPrice(dollars(choice.defaultPriceCents!))} className="text-blue-400 text-sm font-semibold">Use ${dollars(choice.defaultPriceCents)}</button>
            )}
          </div>
          <p className="text-gray-600 text-[11px] mt-1">Leave blank to price later.</p>
        </div>
      )}
      {typedOther && (
        <div className="space-y-1.5">
          <label className="flex items-start gap-2 text-gray-300 text-xs">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 h-4 w-4" />
            <span>Remember this wording as another name for {choice.name} (manager approval)</span>
          </label>
          {remember && <input aria-label="Wording to remember" value={aliasText} onChange={(e) => setAliasText(e.target.value)} maxLength={120} className={INPUT} />}
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => onConfirm({ detail, cents: parseCents(price), remember: !!(typedOther && remember), aliasText })} className={`${BTN} bg-emerald-600 text-white flex-1`}>{mode === 'add' ? 'Add' : 'Use this service'}</button>
        <button type="button" disabled={busy} onClick={onCancel} className={`${BTN} border border-gray-600 text-gray-200`}>Not this</button>
      </div>
    </div>
  )
}

function BrowseList({ catalog, busy, onPick }: { catalog: CatalogChoice[] | null; busy: boolean; onPick: (c: CatalogChoice) => void }) {
  const [q, setQ] = useState('')
  if (!catalog) return <p className="text-gray-500 text-sm">Loading services…</p>
  const terms = norm(q).split(' ').filter(Boolean)
  const list = catalog.filter((c) => terms.every((t) => `${c.name} ${c.description}`.toLowerCase().includes(t)))
  return (
    <div className="space-y-2">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all services" aria-label="Search all services" className={INPUT} />
      <ul className="max-h-72 overflow-y-auto rounded-xl border border-gray-800 divide-y divide-gray-800">
        {list.map((c) => (
          <li key={c.catalogId}>
            <button type="button" disabled={busy} onClick={() => onPick(c)} className="w-full text-left px-3 py-2.5 active:bg-gray-800">
              <span className="text-white text-sm">{c.name}</span>
              <span className="block text-gray-500 text-xs line-clamp-1">{c.description}</span>
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="px-3 py-3 text-gray-500 text-sm">No services match.</li>}
      </ul>
    </div>
  )
}

export function PartForm({ initialDescription, vehicleLabel, busy, entry, onCancel, onSave }: {
  initialDescription: string; vehicleLabel: string; busy: boolean; entry: string; onCancel: () => void; onSave: (p: Record<string, unknown>) => void
}) {
  const [f, setF] = useState({ description: initialDescription, supply: 'shop' as 'shop' | 'customer', quantity: '1', fitment: vehicleLabel, partNumber: '', supplier: '', cost: '', sell: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }))
  return (
    <form className="rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 space-y-2.5" onSubmit={(e) => {
      e.preventDefault()
      onSave({ description: f.description, supply: f.supply, quantity: f.quantity, fitment: f.fitment, partNumber: f.partNumber, supplier: f.supplier,
        unitCostCents: parseCents(f.cost), sellPriceCents: f.supply === 'shop' ? parseCents(f.sell) : null, entryText: entry || null })
    }}>
      <p className="text-white font-semibold text-sm">Special-order part</p>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Who supplies the part">
        {(['shop', 'customer'] as const).map((v) => (
          <button key={v} type="button" role="radio" aria-checked={f.supply === v} onClick={() => setF((x) => ({ ...x, supply: v }))}
            className={`rounded-xl border px-3 py-2 text-sm ${f.supply === v ? 'border-blue-500 bg-blue-600/20 text-white' : 'border-gray-700 text-gray-300'}`}>
            {v === 'shop' ? 'We supply it' : 'Customer supplies it'}
          </button>
        ))}
      </div>
      <Field label="Part description"><input value={f.description} onChange={set('description')} required maxLength={200} className={INPUT} placeholder="e.g. Driver-side mirror assembly" /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Quantity"><input value={f.quantity} onChange={set('quantity')} inputMode="decimal" required className={INPUT} /></Field>
        <Field label="Vendor part # (optional)"><input value={f.partNumber} onChange={set('partNumber')} maxLength={80} className={INPUT} /></Field>
      </div>
      <Field label="Vehicle fitment"><input value={f.fitment} onChange={set('fitment')} maxLength={200} className={INPUT} /></Field>
      {f.supply === 'shop' && (
        <>
          <Field label="Vendor (optional)"><input value={f.supplier} onChange={set('supplier')} maxLength={120} className={INPUT} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Our cost each (internal)"><input value={f.cost} onChange={set('cost')} inputMode="decimal" placeholder="$" className={INPUT} /></Field>
            <Field label="Customer price each"><input value={f.sell} onChange={set('sell')} inputMode="decimal" placeholder="$ — blank = later" className={INPUT} /></Field>
          </div>
        </>
      )}
      {f.supply === 'customer' && <p className="text-gray-400 text-xs">No parts charge. You’ll still confirm installation labor.</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !f.description.trim()} className={`${BTN} bg-blue-600 text-white flex-1`}>Add part</button>
        <button type="button" disabled={busy} onClick={onCancel} className={`${BTN} border border-gray-600 text-gray-200`}>Cancel</button>
      </div>
    </form>
  )
}

function TireForm({ busy, entry, onCancel, onSave }: { busy: boolean; entry: string; onCancel: () => void; onSave: (t: Record<string, unknown>) => void }) {
  const [mode, setMode] = useState<'supply' | 'install_customer' | 'both' | null>(null)
  const [qty, setQty] = useState('')
  const [size, setSize] = useState('')
  const [tire, setTire] = useState('')
  const [install, setInstall] = useState('')
  const [extras, setExtras] = useState({ mount: false, balance: false, disposal: false })
  const n = Number(qty)
  const valid = mode && Number.isInteger(n) && n >= 1 && n <= 12
  return (
    <form className="rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 space-y-2.5" onSubmit={(e) => {
      e.preventDefault(); if (!valid) return
      onSave({ mode, quantity: n, size, tireUnitCents: mode !== 'install_customer' ? parseCents(tire) : null, installCents: mode !== 'supply' ? parseCents(install) : null, extras, entryText: entry || null })
    }}>
      <p className="text-white font-semibold text-sm">Tires — what are we doing?</p>
      <div className="grid gap-2" role="radiogroup" aria-label="Tire work">
        {([['supply', 'Supplying tires (no install)'], ['install_customer', 'Installing customer-supplied tires'], ['both', 'Supplying and installing tires']] as const).map(([v, t]) => (
          <button key={v} type="button" role="radio" aria-checked={mode === v} onClick={() => setMode(v)}
            className={`rounded-xl border px-3 py-2.5 text-sm text-left ${mode === v ? 'border-blue-500 bg-blue-600/20 text-white' : 'border-gray-700 text-gray-300'}`}>{t}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="How many tires?"><input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" required className={INPUT} placeholder="e.g. 4" /></Field>
        <Field label="Size (optional)"><input value={size} onChange={(e) => setSize(e.target.value)} maxLength={40} className={INPUT} placeholder="275/65R18" /></Field>
      </div>
      {mode && mode !== 'install_customer' && <Field label="Tire price each"><input value={tire} onChange={(e) => setTire(e.target.value)} inputMode="decimal" className={INPUT} placeholder="$ — blank = later" /></Field>}
      {mode && mode !== 'supply' && (
        <>
          <Field label="Installation price (total)"><input value={install} onChange={(e) => setInstall(e.target.value)} inputMode="decimal" className={INPUT} placeholder="$ — blank = later" /></Field>
          <fieldset className="flex flex-wrap gap-3 text-sm text-gray-300">
            <legend className="text-gray-400 text-xs mb-1">Included in the installation (only if we do it)</legend>
            {(['mount', 'balance', 'disposal'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5"><input type="checkbox" className="h-4 w-4" checked={extras[k]} onChange={(e) => setExtras((x) => ({ ...x, [k]: e.target.checked }))} />{k === 'mount' ? 'Mounting' : k === 'balance' ? 'Balancing' : 'Disposal'}</label>
            ))}
          </fieldset>
        </>
      )}
      <p className="text-gray-600 text-[11px]">Tire and installation prices are entered separately — never split from one combined price.</p>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !valid} className={`${BTN} bg-blue-600 text-white flex-1`}>Add</button>
        <button type="button" disabled={busy} onClick={onCancel} className={`${BTN} border border-gray-600 text-gray-200`}>Cancel</button>
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-gray-400 text-xs">{label}</span><span className="block mt-1">{children}</span></label>
}
