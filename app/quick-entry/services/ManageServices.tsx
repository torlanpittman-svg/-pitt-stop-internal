'use client'

/**
 * Manage services (manager/admin). Shortcuts reference stable catalog identities: renaming, moving,
 * or hiding a shortcut never changes its QuickBooks mapping, existing estimate lines, or invoices.
 * Description/default-price/QuickBooks-item edits apply to FUTURE additions. QuickBooks items are
 * only selected from the live list — never created. Every save is confirmed by the server and
 * audited; a failure keeps what you typed and offers Retry.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import NavHeader from '@/app/components/NavHeader'

interface Shortcut { id: string; catalogId: string; label: string; group: string; hidden: boolean; catalogName: string; description: string; qbDescription: string | null; priceBehavior: 'manual' | 'fixed' | 'tiered'; defaultPriceCents: number | null; qbItemRef: string | null; qbMapped: boolean; qbCandidateRef: string | null }
interface Choice { catalogId: string; name: string; description: string }
interface ReviewItem { catalogId: string; name: string; reasons: string[]; qbCandidateRef: string | null; role: string | null; roleConfirmed: boolean; defaultPriceCents: number | null; description: string }
interface QbItem { id: string; name: string; type: string | null; description: string | null }
interface Alias { id: string; alias: string; catalogId: string; name: string; approvedBy: string | null }
interface Usage { catalogId: string; name: string; jobs: number; hasShortcut: boolean }
interface EventRow { id: string; eventType: string; actor: string | null; note: string | null; createdAt: string }
interface Data { groups: string[]; shortcuts: Shortcut[]; catalog: Choice[]; review: ReviewItem[]; aliases: Alias[]; usage: Usage[]; events: EventRow[]; qbItems: QbItem[] | null; qbError: string | null }

const INPUT = 'w-full bg-gray-950 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-base'
const BTN = 'rounded-xl font-semibold text-sm px-3 py-2 active:opacity-80 disabled:opacity-40'
const dollars = (c: number) => (c / 100).toFixed(2)
const parseCents = (s: string) => { const n = parseFloat(s.replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null }

export default function ManageServices() {
  const [data, setData] = useState<Data | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'saving' | 'saved' | 'error'; msg: string; retry?: () => void } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetch('/api/quick-entry/services')
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.ok) { setStatus({ kind: 'error', msg: d.error ?? 'Couldn’t load services.', retry: () => void load() }); return }
    setData(d)
  }, [])
  useEffect(() => { void load() }, [load])

  // Retry re-runs the same save through a ref (the callback can't reference itself while defined).
  const retryRef = useRef<(body: Record<string, unknown>, label: string) => Promise<boolean>>(async () => false)
  const act = useCallback(async (body: Record<string, unknown>, label: string): Promise<boolean> => {
    setBusy(true); setStatus({ kind: 'saving', msg: `${label}…` })
    try {
      const r = await fetch('/api/quick-entry/services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) { setStatus({ kind: 'error', msg: d.error ?? `Couldn’t save (${r.status}).`, retry: () => void retryRef.current(body, label) }); return false }
      await load()
      setStatus({ kind: 'saved', msg: `${label} · Saved` })
      return true
    } catch { setStatus({ kind: 'error', msg: 'No connection — nothing was saved.', retry: () => void retryRef.current(body, label) }); return false } finally { setBusy(false) }
  }, [load])
  useEffect(() => { retryRef.current = act }, [act])

  const active = useMemo(() => (data?.shortcuts ?? []).filter((s) => !s.hidden), [data])
  const hidden = useMemo(() => (data?.shortcuts ?? []).filter((s) => s.hidden), [data])
  const groups = useMemo(() => [...new Set([...(data?.groups ?? []), ...active.map((s) => s.group)])], [data, active])
  const qbName = (ref: string | null) => (ref && data?.qbItems?.find((i) => i.id === ref)?.name) || (ref ? `#${ref}` : null)

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: '/estimates', label: 'Estimates' }} />
      <div className="max-w-xl mx-auto px-4 py-5 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Manage services</h1>
          <p className="text-gray-400 text-sm mt-1">Shortcuts employees tap when building estimates and jobs. Changes apply to future additions — existing estimates and invoices are never rewritten.</p>
        </div>

        <div role="status" aria-live="polite" className="sticky top-2 z-20 min-h-[1.75rem]">
          {status && (status.kind === 'error' ? (
            <div className="rounded-xl border border-red-800/70 bg-red-950/60 px-4 py-2.5 text-sm text-red-200 flex items-center justify-between gap-3">
              <span className="min-w-0 break-words">{status.msg}</span>
              {status.retry && <button onClick={status.retry} disabled={busy} className={`${BTN} bg-red-600 text-white shrink-0`}>Retry</button>}
            </div>
          ) : <p className={`inline-flex rounded-full bg-gray-900 px-3 py-1 text-xs ${status.kind === 'saved' ? 'text-green-400' : 'text-gray-400'}`}>{status.kind === 'saved' ? '✓ ' : ''}{status.msg}</p>)}
        </div>

        {!data && <p className="text-gray-500">Loading…</p>}
        {data && (
          <>
            {data.qbError && <p className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-amber-200 text-xs">QuickBooks item list is unavailable right now ({data.qbError}). Everything else can be edited; choose QuickBooks items later.</p>}

            <section aria-label="Shortcuts" className="space-y-4">
              {groups.map((g) => {
                const list = active.filter((s) => s.group === g)
                if (list.length === 0) return null
                return (
                  <div key={g}>
                    <h2 className="text-gray-500 text-xs uppercase tracking-widest mb-2">{g}</h2>
                    <ul className="space-y-2">
                      {list.map((s, i) => (
                        <li key={s.id} className="rounded-2xl border border-gray-800 bg-gray-900 px-3 py-3">
                          {editing === s.id ? (
                            <EditShortcut s={s} groups={groups} qbItems={data.qbItems} busy={busy} onCancel={() => setEditing(null)} act={act} done={() => setEditing(null)} />
                          ) : (
                            <div className="flex items-start gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="font-semibold break-words">{s.label}{s.label !== s.catalogName && <span className="text-gray-500 font-normal text-sm"> · {s.catalogName}</span>}</p>
                                <p className="text-gray-400 text-xs line-clamp-2 break-words">{s.description}</p>
                                <p className="text-gray-500 text-[11px] mt-1">
                                  {s.priceBehavior === 'fixed' ? `Default $${dollars(s.defaultPriceCents ?? 0)}` : s.priceBehavior === 'tiered' ? 'Priced by size/condition' : 'Price entered each time'}
                                  {' · '}{s.qbMapped ? `QuickBooks: ${qbName(s.qbItemRef)}` : <span className="text-amber-300/80">QuickBooks item not set (bills as Labor)</span>}
                                </p>
                              </div>
                              <div className="flex flex-col items-end gap-1 shrink-0">
                                <div className="flex gap-1">
                                  <button aria-label={`Move ${s.label} up`} disabled={busy || i === 0} onClick={() => act({ action: 'move', id: s.id, direction: 'up' }, `Moving ${s.label}`)} className="h-9 w-9 rounded-lg border border-gray-700 disabled:opacity-30">↑</button>
                                  <button aria-label={`Move ${s.label} down`} disabled={busy || i === list.length - 1} onClick={() => act({ action: 'move', id: s.id, direction: 'down' }, `Moving ${s.label}`)} className="h-9 w-9 rounded-lg border border-gray-700 disabled:opacity-30">↓</button>
                                </div>
                                <div className="flex gap-3 text-xs">
                                  <button onClick={() => setEditing(s.id)} disabled={busy} className="text-blue-400 font-semibold min-h-10 px-1 inline-flex items-center">Edit</button>
                                  <button onClick={() => act({ action: 'hide', id: s.id }, `Hiding ${s.label}`)} disabled={busy} className="text-gray-400 font-semibold min-h-10 px-1 inline-flex items-center">Hide</button>
                                </div>
                              </div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </section>

            <AddShortcut data={data} groups={groups} busy={busy} act={act} />

            {hidden.length > 0 && (
              <section aria-label="Hidden shortcuts">
                <h2 className="text-gray-500 text-xs uppercase tracking-widest mb-2">Hidden shortcuts</h2>
                <ul className="space-y-2">
                  {hidden.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 rounded-xl border border-gray-800 px-3 py-2">
                      <span className="text-gray-400 text-sm min-w-0 break-words">{s.label}</span>
                      <button onClick={() => act({ action: 'restore', id: s.id }, `Restoring ${s.label}`)} disabled={busy} className={`${BTN} border border-gray-600 text-gray-200`}>Restore</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.review.length > 0 && (
              <section aria-label="Needs review" className="space-y-2">
                <h2 className="text-gray-500 text-xs uppercase tracking-widest">Needs a manager decision</h2>
                {data.review.map((r) => <ReviewCard key={r.catalogId} r={r} qbItems={data.qbItems} busy={busy} act={act} />)}
              </section>
            )}

            {data.usage.some((u) => !u.hasShortcut) && (
              <section aria-label="Usage suggestions">
                <h2 className="text-gray-500 text-xs uppercase tracking-widest mb-1">Used often, no shortcut (last 90 days)</h2>
                <p className="text-gray-500 text-xs mb-2">Suggestions only — nothing changes unless you add it.</p>
                <ul className="space-y-1">
                  {data.usage.filter((u) => !u.hasShortcut).slice(0, 8).map((u) => (
                    <li key={u.catalogId} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 break-words">{u.name} <span className="text-gray-500">· {u.jobs} job{u.jobs === 1 ? '' : 's'}</span></span>
                      <button disabled={busy} onClick={() => act({ action: 'add_shortcut', catalogId: u.catalogId, group: 'Other' }, `Adding ${u.name}`)} className="text-blue-400 text-xs font-semibold min-h-10 px-2 inline-flex items-center shrink-0">Add shortcut</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.aliases.length > 0 && (
              <section aria-label="Approved alternate names">
                <h2 className="text-gray-500 text-xs uppercase tracking-widest mb-2">Approved alternate names</h2>
                <ul className="space-y-1">
                  {data.aliases.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 break-words">“{a.alias}” → {a.name}</span>
                      <button disabled={busy} onClick={() => act({ action: 'remove_alias', aliasId: a.id }, `Removing “${a.alias}”`)} className="text-gray-400 text-xs min-h-10 px-2 inline-flex items-center shrink-0">Remove</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <details className="text-sm">
              <summary className="text-gray-500 cursor-pointer">Recent changes</summary>
              <ul className="mt-2 space-y-1 text-xs text-gray-400">
                {data.events.map((e) => <li key={e.id} className="break-words">{new Date(e.createdAt).toLocaleString()} · {e.actor ?? '—'} · {e.eventType.replace(/_/g, ' ')}</li>)}
              </ul>
            </details>
          </>
        )}
      </div>
    </main>
  )
}

function QbSelect({ value, onChange, qbItems, candidate }: { value: string; onChange: (v: string) => void; qbItems: QbItem[] | null; candidate?: string | null }) {
  if (!qbItems) return <p className="text-gray-500 text-xs">QuickBooks items unavailable — bills as Labor until set.</p>
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT} aria-label="QuickBooks item">
      <option value="">Not set — bill as generic Labor</option>
      {qbItems.map((i) => <option key={i.id} value={i.id}>{i.name}{i.type === 'NonInventory' ? ' (non-inventory)' : ''}{i.id === candidate ? ' — suggested' : ''}</option>)}
    </select>
  )
}

function EditShortcut({ s, groups, qbItems, busy, onCancel, act, done }: { s: Shortcut; groups: string[]; qbItems: QbItem[] | null; busy: boolean; onCancel: () => void; act: (b: Record<string, unknown>, l: string) => Promise<boolean>; done: () => void }) {
  const [label, setLabel] = useState(s.label)
  const [group, setGroup] = useState(s.group)
  const [desc, setDesc] = useState(s.qbDescription ?? '')
  const [priceMode, setPriceMode] = useState<'manual' | 'fixed'>(s.priceBehavior === 'fixed' ? 'fixed' : 'manual')
  const [price, setPrice] = useState(s.defaultPriceCents != null ? dollars(s.defaultPriceCents) : '')
  const [qb, setQb] = useState(s.qbMapped ? s.qbItemRef ?? '' : '')
  const save = async () => {
    let ok = true
    if (label !== s.label || group !== s.group) ok = await act({ action: 'update_shortcut', id: s.id, label, group }, `Saving ${label}`)
    const catalogPatch: Record<string, unknown> = {}
    if ((desc.trim() || null) !== (s.qbDescription ?? null)) catalogPatch.description = desc
    if (s.priceBehavior !== 'tiered' && (priceMode !== s.priceBehavior || (priceMode === 'fixed' && parseCents(price) !== s.defaultPriceCents))) { catalogPatch.priceMode = priceMode; catalogPatch.defaultPriceCents = priceMode === 'fixed' ? parseCents(price) : null }
    if (qbItems && qb !== (s.qbMapped ? s.qbItemRef ?? '' : '')) catalogPatch.qbItemRef = qb || null
    if (ok && Object.keys(catalogPatch).length) ok = await act({ action: 'update_catalog', catalogId: s.catalogId, ...catalogPatch }, `Saving ${s.catalogName}`)
    if (ok) done()
  }
  return (
    <form className="space-y-2.5" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <label className="block text-gray-400 text-xs">Shortcut name<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} required className={`${INPUT} mt-1`} /></label>
      <label className="block text-gray-400 text-xs">Group
        <select value={group} onChange={(e) => setGroup(e.target.value)} className={`${INPUT} mt-1`}>{groups.map((g) => <option key={g}>{g}</option>)}</select>
      </label>
      <label className="block text-gray-400 text-xs">Customer-facing description (approved)
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} maxLength={600} placeholder={s.catalogName} className={`${INPUT} mt-1`} />
      </label>
      {s.priceBehavior === 'tiered' ? <p className="text-gray-500 text-xs">Priced by vehicle size/condition (tiers unchanged).</p> : (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-gray-400 text-xs">Pricing
            <select value={priceMode} onChange={(e) => setPriceMode(e.target.value as 'manual' | 'fixed')} className={`${INPUT} mt-1`}><option value="manual">Entered each time</option><option value="fixed">Default price</option></select>
          </label>
          {priceMode === 'fixed' && <label className="text-gray-400 text-xs">Default price<input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className={`${INPUT} mt-1`} /></label>}
        </div>
      )}
      <div className="text-gray-400 text-xs">QuickBooks item (existing items only)<div className="mt-1"><QbSelect value={qb} onChange={setQb} qbItems={qbItems} candidate={s.qbCandidateRef} /></div></div>
      <p className="text-gray-600 text-[11px]">Applies to services added from now on. Existing estimates and invoices keep their saved wording and price.</p>
      <div className="flex gap-2"><button type="submit" disabled={busy || !label.trim()} className={`${BTN} bg-blue-600 text-white flex-1`}>Save</button><button type="button" onClick={onCancel} className={`${BTN} border border-gray-600 text-gray-200`}>Cancel</button></div>
    </form>
  )
}

function AddShortcut({ data, groups, busy, act }: { data: Data; groups: string[]; busy: boolean; act: (b: Record<string, unknown>, l: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'existing' | 'new'>('existing')
  const [q, setQ] = useState('')
  const [catalogId, setCatalogId] = useState('')
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState(groups[groups.length - 1] ?? 'Other')
  const [n, setN] = useState({ name: '', description: '', priceMode: 'manual' as 'manual' | 'fixed', price: '', qb: '' })
  const taken = new Set(data.shortcuts.filter((s) => !s.hidden).map((s) => s.catalogId))
  const options = data.catalog.filter((c) => !taken.has(c.catalogId) && c.name.toLowerCase().includes(q.trim().toLowerCase()))
  if (!open) return <button onClick={() => setOpen(true)} disabled={busy} className={`${BTN} w-full border border-dashed border-gray-600 text-gray-200 py-3`}>＋ Add a shortcut</button>
  const submit = async () => {
    const ok = kind === 'existing'
      ? await act({ action: 'add_shortcut', catalogId, label, group }, 'Adding shortcut')
      : await act({ action: 'add_shortcut', label: label || n.name, group, newService: { name: n.name, description: n.description, priceMode: n.priceMode, defaultPriceCents: n.priceMode === 'fixed' ? parseCents(n.price) : null, qbItemRef: n.qb || null } }, `Adding ${n.name}`)
    if (ok) { setOpen(false); setCatalogId(''); setLabel(''); setN({ name: '', description: '', priceMode: 'manual', price: '', qb: '' }) }
  }
  return (
    <section aria-label="Add a shortcut" className="rounded-2xl border border-gray-700 bg-gray-900 px-3 py-3 space-y-2.5">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Shortcut source">
        {(['existing', 'new'] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`rounded-xl border px-3 py-2 text-sm ${kind === k ? 'border-blue-500 bg-blue-600/20' : 'border-gray-700 text-gray-300'}`}>{k === 'existing' ? 'Existing service' : 'New service'}</button>
        ))}
      </div>
      {kind === 'existing' ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the catalog" aria-label="Search the catalog" className={INPUT} />
          <select value={catalogId} onChange={(e) => setCatalogId(e.target.value)} className={INPUT} aria-label="Catalog service">
            <option value="">Choose a service…</option>
            {options.map((c) => <option key={c.catalogId} value={c.catalogId}>{c.name}</option>)}
          </select>
        </>
      ) : (
        <>
          <p className="text-gray-400 text-xs">Only for work not already in the catalog — duplicates are refused. QuickBooks items are selected, never created.</p>
          <input value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} placeholder="Service name (generic, e.g. “Pet Hair Removal”)" aria-label="Service name" maxLength={120} className={INPUT} />
          <textarea value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} rows={3} maxLength={600} placeholder="Approved customer-facing description" aria-label="Description" className={INPUT} />
          <div className="grid grid-cols-2 gap-2">
            <select value={n.priceMode} onChange={(e) => setN({ ...n, priceMode: e.target.value as 'manual' | 'fixed' })} className={INPUT} aria-label="Pricing"><option value="manual">Price entered each time</option><option value="fixed">Default price</option></select>
            {n.priceMode === 'fixed' && <input value={n.price} onChange={(e) => setN({ ...n, price: e.target.value })} inputMode="decimal" placeholder="$" aria-label="Default price" className={INPUT} />}
          </div>
          <div className="text-gray-400 text-xs">QuickBooks item<div className="mt-1"><QbSelect value={n.qb} onChange={(v) => setN({ ...n, qb: v })} qbItems={data.qbItems} /></div></div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Shortcut name (optional)" aria-label="Shortcut name" maxLength={80} className={INPUT} />
        <select value={group} onChange={(e) => setGroup(e.target.value)} className={INPUT} aria-label="Group">{groups.map((g) => <option key={g}>{g}</option>)}</select>
      </div>
      <div className="flex gap-2">
        <button onClick={() => void submit()} disabled={busy || (kind === 'existing' ? !catalogId : n.name.trim().length < 2)} className={`${BTN} bg-blue-600 text-white flex-1`}>Add shortcut</button>
        <button onClick={() => setOpen(false)} className={`${BTN} border border-gray-600 text-gray-200`}>Cancel</button>
      </div>
    </section>
  )
}

function ReviewCard({ r, qbItems, busy, act }: { r: ReviewItem; qbItems: QbItem[] | null; busy: boolean; act: (b: Record<string, unknown>, l: string) => Promise<boolean> }) {
  const [qb, setQb] = useState(r.qbCandidateRef ?? '')
  const needsQb = r.reasons.some((x) => x.startsWith('No QuickBooks'))
  return (
    <div className="rounded-2xl border border-amber-800/60 bg-amber-950/20 px-3 py-3 space-y-2">
      <p className="font-semibold break-words">{r.name}</p>
      <p className="text-gray-400 text-xs break-words">{r.description}</p>
      <ul className="list-disc pl-4 text-amber-200/90 text-xs space-y-0.5">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
      {needsQb && qbItems && (
        <div className="flex gap-2 items-end">
          <div className="flex-1 min-w-0"><QbSelect value={qb} onChange={setQb} qbItems={qbItems} candidate={r.qbCandidateRef} /></div>
          <button disabled={busy || !qb} onClick={() => act({ action: 'update_catalog', catalogId: r.catalogId, qbItemRef: qb }, `Mapping ${r.name}`)} className={`${BTN} bg-blue-600 text-white shrink-0`}>Use item</button>
        </div>
      )}
      {r.role && !r.roleConfirmed && <button disabled={busy} onClick={() => act({ action: 'confirm_role', catalogId: r.catalogId }, `Confirming ${r.name}`)} className={`${BTN} border border-amber-700 text-amber-100`}>Confirm</button>}
    </div>
  )
}
