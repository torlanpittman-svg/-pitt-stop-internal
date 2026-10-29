'use client'

/**
 * PartImportPanel — import parts into THIS job from PartsTech screenshots.
 *
 * Flow: Open PartsTech (new tab) → optionally Copy VIN → screenshot the cart/quote/order → upload 1–4 here.
 * The screenshots are saved privately, read by AI into a PROPOSAL, then the reviewer corrects prices/links and
 * saves them as tracked parts. EQUAL PERMISSIONS: every authorized shop user has the SAME capability here —
 * upload, read, see costs + the original screenshots, review, link/skip/new, acknowledge duplicates, mark
 * ordered, save, and cancel. There is no manager handoff.
 *
 * Renders NOTHING when the feature flag is off, so the surrounding Parts section is unchanged until
 * PARTS_SCREENSHOT_IMPORT_ENABLED is set. Mount it keyed by orderId so job state never leaks between jobs.
 * `transport` lets a non-production preview inject synthetic data WITHOUT the network/DB. Never bills/QB.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { money } from '@/app/lib/format'
import { normalizeImage } from '@/app/components/PhotoInput'

const PARTSTECH_URL = 'https://app.partstech.com/'
const MAX_IMAGES = 4

export interface ImportTransport {
  get: (path: string) => Promise<unknown>
  post: (path: string, body: unknown) => Promise<unknown>
  upload: (path: string, form: FormData) => Promise<unknown>
  imageUrl: (batchId: string, imageId: string) => string
}

interface Job { orderId: string; orderNumber: string; vin: string | null; vehicle: string | null }
interface BatchSummary { id: string; status: string; documentKind: string; supplier: string | null; orderReference: string | null; rowCount: number; appliedCount: number; createdAt: string; uploadedBy: string | null }
type Decision = 'new' | 'link' | 'skip'
interface Row {
  id: string; sourceImageId: string | null; ordinal: number
  description: string | null; partNumber: string | null; brand: string | null; supplier: string | null
  quantity: number | null; unitCostCents: number | null; listPriceCents: number | null; lineTotalCents: number | null
  linkDecision: Decision; matchedPartId: string | null; appliedPartId: string | null
  issues: string[]; skuWarning: boolean
}
interface ExistingPart { id: string; description: string; partNumber: string | null; supplier: string | null; status: string; billed: boolean; quantity: number | null; supplierOrderNumber: string | null; unitCostCents: number | null }
interface BatchView {
  id: string; serviceOrderId: string; status: string; aiStatus: string; revision: number
  documentKind: 'purchase' | 'quote' | 'cart' | 'unknown'; supplier: string | null; orderReference: string | null
  taxCents: number | null; shippingCents: number | null; coreCents: number | null
  markOrdered: boolean; duplicateConfirmed: boolean
  images: Array<{ id: string; ordinal: number; contentType: string | null }>
  rows: Row[]
  warnings: { mixedSupplier: boolean; suppliers: string[]; duplicateSupplierOrder: boolean; overlappingImages: boolean; pageConflicts: { supplier: boolean; orderReference: boolean; documentKind: boolean }; unreadImages: number; truncated: boolean }
  canMarkOrdered: boolean
  existingParts: ExistingPart[]
}

const STATUS_LABEL: Record<string, string> = {
  uploaded: 'Saved — not read yet', reading: 'Reading…', proposed: 'Ready to review', applied: 'Saved to job', failed: 'Read failed', cancelled: 'Cancelled',
}

// 16px text, readable colors, bounded width for mobile.
const inputCls = 'w-full min-w-0 rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-base text-gray-100 placeholder:text-gray-500 outline-none focus:border-blue-500 min-h-[44px]'
const selectCls = 'w-full min-w-0 rounded-lg bg-gray-950 border border-gray-700 px-2 py-2 text-base text-gray-100 outline-none focus:border-blue-500 min-h-[44px]'

function defaultTransport(orderId: string): ImportTransport {
  const base = `/api/workflow/orders/${orderId}/parts/imports`
  const jsonPost = async (p: string, body: unknown) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return r.json()
  }
  return {
    get: async (p) => (await fetch(`${base}${p}`, { cache: 'no-store' })).json(),
    post: jsonPost,
    upload: async (p, form) => (await fetch(`${base}${p}`, { method: 'POST', body: form })).json(),
    imageUrl: (batchId, imageId) => `${base}/${batchId}/images/${imageId}`,
  }
}

type LoadPhase = 'loading' | 'off' | 'ready' | 'error'

export default function PartImportPanel({ orderId, onApplied, transport }: { orderId: string; onApplied?: () => void; transport?: ImportTransport }) {
  const t = useMemo(() => transport ?? defaultTransport(orderId), [transport, orderId])
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [job, setJob] = useState<Job | null>(null)
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [vinCopied, setVinCopied] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadList = useCallback(async (): Promise<boolean> => {
    const d = await t.get('') as { ok?: boolean; enabled?: boolean; job?: Job; batches?: BatchSummary[]; error?: string }
    if (d.enabled === false) return false // feature dark
    if (!d.ok) { setErr(d.error || 'Could not load imports.'); return true }
    setJob(d.job ?? null); setBatches(d.batches ?? []); setErr(null)
    return true
  }, [t])

  useEffect(() => {
    let ignore = false
    t.get('')
      .then((raw) => {
        if (ignore) return
        const d = raw as { ok?: boolean; enabled?: boolean; job?: Job; batches?: BatchSummary[]; error?: string }
        if (d.enabled === false) { setPhase('off'); return }
        if (!d.ok) { setErr(d.error || 'Could not load imports.'); setPhase('ready'); return }
        setJob(d.job ?? null); setBatches(d.batches ?? []); setPhase('ready')
      })
      .catch(() => { if (!ignore) { setErr('Could not load parts import — check your connection.'); setPhase('error') } })
    return () => { ignore = true }
  }, [t])

  const copyVin = useCallback(async () => {
    if (!job?.vin) return
    try { await navigator.clipboard.writeText(job.vin); setVinCopied(true); setTimeout(() => setVinCopied(false), 2500) }
    catch { setErr('Could not copy the VIN — select it manually.') }
  }, [job])

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    if (files.length > MAX_IMAGES) { setErr(`Choose up to ${MAX_IMAGES} screenshots (you picked ${files.length}).`); if (fileRef.current) fileRef.current.value = ''; return }
    const list = Array.from(files)
    setBusy(true); setErr(null); setNote('Preparing screenshots…')
    let newBatchId: string | null = null
    try {
      const form = new FormData()
      form.set('captureId', crypto.randomUUID())
      for (const f of list) {
        const shrunk = await normalizeImage(f, 2000, 0.85) // dependency-free client shrink to fit the body cap
        form.append('screenshots', shrunk, shrunk.name)
      }
      setNote('Saving…')
      const up = await t.upload('', form) as { ok?: boolean; batchId?: string; error?: string }
      if (!up.ok || !up.batchId) { setErr(up.error || 'Upload failed.'); return }
      newBatchId = up.batchId
      await loadList().catch(() => {}) // refresh the list even if the read step fails next
      setNote('Reading parts…')
      // Trigger the read; if it fails the screenshots are still saved — open the batch to review/retry.
      await t.post(`/${up.batchId}`, { action: 'read' }).catch(() => {})
      setActiveId(up.batchId)
    } catch {
      setErr('Something went wrong. Your screenshots may be saved — reopen the import below.')
      if (newBatchId) { setActiveId(newBatchId) }
      await loadList().catch(() => {})
    } finally { setBusy(false); setNote(null); if (fileRef.current) fileRef.current.value = '' }
  }, [t, loadList])

  if (phase === 'off') return null
  if (phase === 'loading') return null

  if (phase === 'error') {
    return (
      <div className="mt-3 rounded-2xl border border-gray-800 bg-gray-900/60 p-3">
        <p role="alert" className="text-sm text-red-400">{err}</p>
        <button type="button" onClick={() => location.reload()} className="mt-2 min-h-[44px] rounded-lg border border-gray-700 bg-gray-800 px-4 text-sm font-semibold text-gray-100">Retry</button>
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-2xl border border-gray-800 bg-gray-900/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Import from screenshot</h3>
        {job?.orderNumber && <span className="text-xs text-gray-500">{job.orderNumber}{job.vehicle ? ` · ${job.vehicle}` : ''}</span>}
      </div>

      <p aria-live="polite" className="sr-only">{note ?? err ?? ''}</p>
      {err && <p role="alert" className="mt-2 text-sm text-red-400">{err}</p>}
      {note && <p className="mt-2 text-sm text-blue-300">{note}</p>}

      {!activeId && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <a href={PARTSTECH_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white active:bg-blue-700">Open PartsTech ↗</a>
            {job?.vin && (
              <button type="button" onClick={copyVin} className="inline-flex min-h-[44px] items-center rounded-xl border border-gray-700 bg-gray-800 px-4 text-sm font-semibold text-gray-100 active:bg-gray-700">
                {vinCopied ? '✓ VIN copied' : 'Copy VIN'}
              </button>
            )}
          </div>
          <p className="text-[13px] leading-relaxed text-gray-400">In PartsTech, choose Delivery and confirm the shop address. Screenshot the cart / quote / order, then upload 1–{MAX_IMAGES} here.</p>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="sr-only" onChange={(e) => onFiles(e.target.files)} aria-label={`Choose up to ${MAX_IMAGES} screenshots`} />
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="w-full min-h-[48px] rounded-xl bg-gray-800 border border-gray-700 py-3 text-sm font-semibold text-gray-100 active:bg-gray-700 disabled:opacity-50">
            {busy ? 'Working…' : 'Upload screenshots'}
          </button>

          {batches.length > 0 && (
            <ul className="space-y-1.5">
              {batches.map((b) => (
                <li key={b.id}>
                  <button type="button" onClick={() => setActiveId(b.id)} disabled={busy}
                    className="flex min-h-[48px] w-full items-center justify-between gap-2 rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-left active:bg-gray-800 disabled:opacity-50">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-gray-100">{b.supplier || 'PartsTech'}{b.orderReference ? ` · #${b.orderReference}` : ''}</span>
                      <span className="block text-xs text-gray-400">{b.rowCount} line{b.rowCount === 1 ? '' : 's'}{b.appliedCount > 0 ? ` · ${b.appliedCount} on job` : ''}</span>
                    </span>
                    <span className="flex-none text-xs text-gray-400">{STATUS_LABEL[b.status] ?? b.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {activeId && (
        <ReviewView
          key={activeId} orderId={orderId} batchId={activeId} transport={t}
          onClose={() => { setActiveId(null); loadList().catch(() => {}) }}
          onApplied={() => { setActiveId(null); loadList().catch(() => {}); onApplied?.() }}
        />
      )}
    </div>
  )
}

// ── Client value parsing (natural typing; never silently rounds; keeps unknown vs real zero) ─────────────
function parseQty(s: string): number | null | 'invalid' {
  const v = s.trim()
  if (v === '') return null
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(v)) return 'invalid'
  const n = Number(v)
  return n > 0 ? n : 'invalid'
}
function parseCostToCents(s: string): number | null | 'invalid' {
  const v = s.trim()
  if (v === '') return null
  if (!/^\$?\d{1,9}(\.\d{1,2})?$/.test(v)) return 'invalid'
  return Math.round(Number(v.replace(/\$/g, '')) * 100)
}
const centsToStr = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2))

interface RowEdit { description: string; partNumber: string; brand: string; supplier: string; quantity: string; unitCost: string; linkDecision: Decision; matchedPartId: string | null }
function toEdit(r: Row): RowEdit {
  return { description: r.description ?? '', partNumber: r.partNumber ?? '', brand: r.brand ?? '', supplier: r.supplier ?? '', quantity: r.quantity == null ? '' : String(r.quantity), unitCost: centsToStr(r.unitCostCents), linkDecision: r.linkDecision, matchedPartId: r.matchedPartId }
}

function ReviewView({ orderId, batchId, transport: t, onClose, onApplied }: {
  orderId: string; batchId: string; transport: ImportTransport; onClose: () => void; onApplied: () => void
}) {
  void orderId
  const [v, setV] = useState<BatchView | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, RowEdit>>({})
  const [doc, setDoc] = useState({ supplier: '', orderReference: '', documentKind: 'unknown' as BatchView['documentKind'], markOrdered: false })
  const [invalid, setInvalid] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<null | 'dup' | 'ack'>(null)

  const hydrate = useCallback((view: BatchView) => {
    setV(view)
    setEdits(Object.fromEntries(view.rows.map((r) => [r.id, toEdit(r)])))
    setDoc({ supplier: view.supplier ?? '', orderReference: view.orderReference ?? '', documentKind: view.documentKind, markOrdered: view.markOrdered })
    setInvalid(new Set())
  }, [])

  useEffect(() => {
    let ignore = false
    t.get(`/${batchId}`)
      .then((raw) => { if (ignore) return; const d = raw as { ok?: boolean; batch?: BatchView; error?: string }; if (!d.ok || !d.batch) { setLoadErr(d.error || 'Could not open this import.'); return } hydrate(d.batch) })
      .catch(() => { if (!ignore) setLoadErr('Could not open this import — check your connection.') })
    return () => { ignore = true }
  }, [t, batchId, hydrate])

  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(null), 2500) }

  // Derive the "already placed" eligibility from the CURRENT edits (so adding supplier/order# enables it,
  // and switching away from a purchase disables it).
  const editedSuppliers = useMemo(() => {
    const set = new Set<string>()
    const add = (s: string) => { const x = s.trim().toLowerCase(); if (x) set.add(x) }
    add(doc.supplier)
    for (const e of Object.values(edits)) add(e.supplier)
    return set
  }, [edits, doc.supplier])
  const mixedSupplier = editedSuppliers.size > 1
  const canMarkOrdered = doc.documentKind === 'purchase' && doc.supplier.trim() !== '' && doc.orderReference.trim() !== '' && !mixedSupplier

  const setEdit = (id: string, patch: Partial<RowEdit>) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }))
  const setDocKind = (k: BatchView['documentKind']) => setDoc((d) => ({ ...d, documentKind: k, markOrdered: k === 'purchase' ? d.markOrdered : false }))

  /** Build the review payload from edits; returns null + flags invalid rows if any amount is malformed. */
  const buildPayload = (expectedRevision: number): Record<string, unknown> | null => {
    const bad = new Set<string>()
    const rows = (v?.rows ?? []).map((r) => {
      const e = edits[r.id]
      const q = parseQty(e.quantity); const c = parseCostToCents(e.unitCost)
      if (q === 'invalid' || c === 'invalid') bad.add(r.id)
      return {
        id: r.id, description: e.description.trim() || null, partNumber: e.partNumber.trim() || null,
        brand: e.brand.trim() || null, supplier: e.supplier.trim() || null,
        quantity: q === 'invalid' ? null : q,
        unitCostCents: c === 'invalid' ? null : c,
        linkDecision: e.linkDecision, matchedPartId: e.linkDecision === 'link' ? e.matchedPartId : null,
      }
    })
    if (bad.size) { setInvalid(bad); setErr('Check the highlighted amounts — use a number like 59 or 59.50.'); return null }
    setInvalid(new Set())
    return { expectedRevision, supplier: doc.supplier.trim() || null, orderReference: doc.orderReference.trim() || null, documentKind: doc.documentKind, markOrdered: doc.markOrdered && canMarkOrdered, rows }
  }

  const reload = (raw: unknown): boolean => {
    const d = raw as { ok?: boolean; batch?: BatchView; error?: string }
    if (!d.ok) { setErr(d.error || 'Update failed.'); return false }
    if (d.batch) hydrate(d.batch)
    return true
  }

  const save = useCallback(async () => {
    if (!v) return
    const payload = buildPayload(v.revision); if (!payload) return
    setBusy(true); setErr(null)
    try { if (reload(await t.post(`/${batchId}`, { action: 'review', ...payload }))) flash('Saved') }
    catch { setErr('Could not save — check your connection and try again.') }
    finally { setBusy(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, batchId, v, edits, doc, canMarkOrdered])

  const apply = useCallback(async (extra: { duplicateConfirmed?: boolean; acknowledgeDuplicates?: boolean } = {}) => {
    if (!v) return
    const payload = buildPayload(v.revision); if (!payload) return
    setBusy(true); setErr(null); setConfirm(null)
    try {
      const saved = await t.post(`/${batchId}`, { action: 'review', ...payload }) as { ok?: boolean; batch?: BatchView; error?: string }
      if (!saved.ok) { setErr(saved.error || 'Could not save before applying.'); if (saved.batch) hydrate(saved.batch); return }
      if (saved.batch) hydrate(saved.batch)
      const rev = saved.batch?.revision ?? v.revision
      const res = await t.post(`/${batchId}`, { action: 'apply', expectedRevision: rev, ...extra }) as { ok?: boolean; needsDuplicateConfirm?: boolean; needsDuplicateAck?: boolean; error?: string }
      if (res.needsDuplicateConfirm) { setConfirm('dup'); setErr(res.error || null); return }
      if (res.needsDuplicateAck) { setConfirm('ack'); setErr(res.error || null); return }
      if (!res.ok) { setErr(res.error || 'Apply failed.'); return }
      onApplied()
    } catch { setErr('Could not save parts — check your connection and try again.') }
    finally { setBusy(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, batchId, v, edits, doc, canMarkOrdered, onApplied])

  const cancel = useCallback(async () => {
    if (!v) return
    setBusy(true); setErr(null)
    try {
      const res = await t.post(`/${batchId}`, { action: 'cancel', expectedRevision: v.revision }) as { ok?: boolean; error?: string }
      if (!res.ok) { setErr(res.error || 'Could not cancel.'); return }
      onClose()
    } catch { setErr('Could not cancel — check your connection.') }
    finally { setBusy(false) }
  }, [t, batchId, v, onClose])

  const reread = useCallback(async () => {
    setBusy(true); setErr(null); setNote('Re-reading…')
    try { reload(await t.post(`/${batchId}`, { action: 'read' })) }
    catch { setErr('Could not re-read — the screenshots are saved; enter parts manually.') }
    finally { setBusy(false); setNote(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, batchId])

  if (loadErr) {
    return (
      <div className="mt-3 space-y-2">
        <button type="button" onClick={onClose} className="min-h-[44px] text-sm text-gray-300 hover:text-gray-100">← Imports</button>
        <p role="alert" className="text-sm text-red-400">{loadErr}</p>
      </div>
    )
  }
  if (!v) return <p className="mt-3 text-sm text-gray-400">Loading…</p>

  const applied = v.status === 'applied'
  const cancelled = v.status === 'cancelled'
  const reviewable = v.status === 'proposed' || v.status === 'failed' || v.status === 'uploaded'
  // Equal permissions: any authorized shop user may edit while the import is still reviewable.
  const editable = reviewable
  // A read can be (re)triggered from uploaded/failed AND a possibly-stuck 'reading' (the server reclaims a
  // stale read after a few minutes; a fresh one returns "busy").
  const canRetryRead = v.status === 'uploaded' || v.status === 'failed' || v.status === 'reading'
  const readLabel = v.status === 'reading' ? 'Check status / retry read' : v.status === 'uploaded' ? 'Read screenshots' : 'Re-read'
  const w = v.warnings

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button type="button" disabled={busy} onClick={onClose} className="min-h-[44px] text-sm text-gray-300 hover:text-gray-100 disabled:opacity-50">← Imports</button>
        <span className="text-xs text-gray-400">{STATUS_LABEL[v.status] ?? v.status}</span>
      </div>

      <p aria-live="polite" className="sr-only">{note ?? err ?? ''}</p>
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      {note && <p className="text-sm text-blue-300">{note}</p>}

      {/* Warnings */}
      <div className="space-y-1.5">
        {mixedSupplier && <Warn>More than one supplier appears. One import is one supplier order — fix the suppliers before marking it ordered.</Warn>}
        {w.pageConflicts.supplier || w.pageConflicts.orderReference || w.pageConflicts.documentKind ? <Warn>The screenshots disagreed on the supplier / order # / type — confirm the correct values above.</Warn> : null}
        {w.unreadImages > 0 && <Warn>{w.unreadImages} screenshot(s) could not be read. Re-read or enter those parts manually.</Warn>}
        {w.truncated && <Warn>Only the first lines were read — add any missing parts manually.</Warn>}
        {w.duplicateSupplierOrder && <Warn>This supplier order looks already-imported to this job — applying will ask you to confirm.</Warn>}
        {w.overlappingImages && <Warn>A screenshot here was already used in another import on this job.</Warn>}
        {v.aiStatus === 'failed' && !applied && !cancelled && <Warn>The screenshots could not be read automatically. Add parts manually below or re-read.</Warn>}
      </div>

      {/* Document metadata */}
      <div className="rounded-xl bg-gray-950 border border-gray-800 p-3 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Supplier" htmlFor="imp-supplier">
            {editable ? <input id="imp-supplier" className={inputCls} value={doc.supplier} onChange={(e) => setDoc({ ...doc, supplier: e.target.value })} placeholder="NAPA, O'Reilly…" autoComplete="off" /> : <ReadOnly>{v.supplier || '—'}</ReadOnly>}
          </Field>
          <Field label="Order / confirmation #" htmlFor="imp-order">
            {editable ? <input id="imp-order" className={inputCls} value={doc.orderReference} onChange={(e) => setDoc({ ...doc, orderReference: e.target.value })} placeholder="optional" autoComplete="off" /> : <ReadOnly>{v.orderReference || '—'}</ReadOnly>}
          </Field>
        </div>
        <Field label="Document type" htmlFor="imp-kind">
          {editable ? (
            <select id="imp-kind" className={selectCls} value={doc.documentKind} onChange={(e) => setDocKind(e.target.value as BatchView['documentKind'])}>
              <option value="purchase">Placed order / confirmation</option>
              <option value="quote">Quote</option>
              <option value="cart">Cart (not ordered)</option>
              <option value="unknown">Not sure</option>
            </select>
          ) : <ReadOnly>{v.documentKind}</ReadOnly>}
        </Field>
        {editable && canMarkOrdered && (
          <label className="flex items-start gap-2 text-sm text-gray-200">
            <input type="checkbox" className="mt-1" checked={doc.markOrdered} onChange={(e) => setDoc({ ...doc, markOrdered: e.target.checked })} />
            <span>I placed this order — mark these parts “Ordered”.</span>
          </label>
        )}
        {(v.taxCents != null || v.shippingCents != null || v.coreCents != null) && (
          <p className="text-[13px] text-gray-400">Document totals (not billed): {[v.taxCents != null && `tax ${money(v.taxCents)}`, v.shippingCents != null && `shipping ${money(v.shippingCents)}`, v.coreCents != null && `core ${money(v.coreCents)}`].filter(Boolean).join(' · ')}</p>
        )}
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {v.rows.length === 0 && <p className="text-sm italic text-gray-500">No parts were read. Re-read, or add parts in the tracker below.</p>}
        {v.rows.map((r) => (
          <RowCard key={r.id} r={r} edit={edits[r.id]} editable={editable} existing={v.existingParts} invalid={invalid.has(r.id)} setEdit={(patch) => setEdit(r.id, patch)} />
        ))}
      </div>

      {/* Original screenshots — visible to any authorized reviewer */}
      {v.images.length > 0 && (
        <details className="rounded-xl border border-gray-800 bg-gray-950 p-2">
          <summary className="cursor-pointer text-[13px] text-gray-300">View original screenshots ({v.images.length})</summary>
          <div className="mt-2 grid grid-cols-1 gap-2">
            {v.images.map((img) => (
              <a key={img.id} href={t.imageUrl(v.id, img.id)} target="_blank" rel="noopener noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.imageUrl(v.id, img.id)} alt="Imported screenshot" className="w-full rounded-lg border border-gray-800" />
              </a>
            ))}
          </div>
        </details>
      )}

      {/* Actions — the same for every authorized reviewer */}
      {applied ? (
        <p className="text-sm text-emerald-400">Saved to the job. The parts are in the tracker above.</p>
      ) : cancelled ? (
        <p className="text-sm text-gray-400">This import was cancelled.</p>
      ) : (
        <div className="space-y-2">
          {confirm && (
            <div className="rounded-xl border border-amber-700/50 bg-amber-900/20 p-3 text-sm text-amber-200">
              {confirm === 'dup' ? 'This supplier order was already imported.' : 'Some of these parts are already on the job (or a screenshot was already used).'} Only continue if these are genuinely additional parts.
              <button type="button" disabled={busy} onClick={() => apply(confirm === 'dup' ? { duplicateConfirmed: true } : { acknowledgeDuplicates: true })} className="mt-2 min-h-[44px] w-full rounded-lg bg-amber-600 py-2 font-semibold text-white active:bg-amber-700 disabled:opacity-50">Yes, add as additional parts</button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || v.status === 'reading'} onClick={save} className="flex-1 min-h-[48px] rounded-xl border border-gray-700 bg-gray-800 px-4 text-sm font-semibold text-gray-100 active:bg-gray-700 disabled:opacity-50">Save draft</button>
            {canRetryRead && <button type="button" disabled={busy} onClick={reread} className="min-h-[48px] rounded-xl border border-gray-700 bg-gray-800 px-4 text-sm font-semibold text-gray-100 active:bg-gray-700 disabled:opacity-50">{readLabel}</button>}
            <button type="button" disabled={busy || v.status !== 'proposed'} title={v.status !== 'proposed' ? 'Read the screenshots first' : undefined} onClick={() => apply()} className="flex-1 min-h-[48px] rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white active:bg-blue-700 disabled:opacity-50">Review &amp; save parts to job</button>
          </div>
          <button type="button" disabled={busy} onClick={cancel} className="min-h-[44px] w-full text-sm text-red-400 active:opacity-70 disabled:opacity-50">Cancel this import</button>
        </div>
      )}
    </div>
  )
}

function RowCard({ r, edit, editable, existing, invalid, setEdit }: { r: Row; edit: RowEdit; editable: boolean; existing: ExistingPart[]; invalid: boolean; setEdit: (patch: Partial<RowEdit>) => void }) {
  const skipped = edit?.linkDecision === 'skip'
  if (editable && edit) {
    return (
      <div className={`rounded-xl border px-3 py-2 ${skipped ? 'border-gray-800 bg-gray-900/40 opacity-60' : invalid ? 'border-amber-600 bg-gray-900' : 'border-gray-800 bg-gray-900'}`}>
        <div className="space-y-2">
          <Field label="Description" htmlFor={`d-${r.id}`}>
            <input id={`d-${r.id}`} className={inputCls} value={edit.description} onChange={(e) => setEdit({ description: e.target.value })} placeholder="Part description (required to save)" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Part #" htmlFor={`pn-${r.id}`}>
              <input id={`pn-${r.id}`} className={inputCls} value={edit.partNumber} onChange={(e) => setEdit({ partNumber: e.target.value })} placeholder="optional" autoComplete="off" autoCapitalize="characters" />
            </Field>
            <Field label="Qty" htmlFor={`q-${r.id}`}>
              <input id={`q-${r.id}`} className={inputCls} inputMode="decimal" value={edit.quantity} onChange={(e) => setEdit({ quantity: e.target.value })} placeholder="required" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Supplier" htmlFor={`s-${r.id}`}>
              <input id={`s-${r.id}`} className={inputCls} value={edit.supplier} onChange={(e) => setEdit({ supplier: e.target.value })} placeholder="optional" autoComplete="off" />
            </Field>
            <Field label="Unit cost $" htmlFor={`c-${r.id}`}>
              <input id={`c-${r.id}`} className={inputCls} inputMode="decimal" value={edit.unitCost} onChange={(e) => setEdit({ unitCost: e.target.value })} placeholder="optional" />
            </Field>
          </div>
          {(r.listPriceCents != null || r.lineTotalCents != null) && (
            <p className="text-[13px] text-gray-400">From screenshot (not cost): {[r.listPriceCents != null && `list ${money(r.listPriceCents)}`, r.lineTotalCents != null && `line total ${money(r.lineTotalCents)}`].filter(Boolean).join(' · ')}</p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Action" htmlFor={`a-${r.id}`}>
              <select id={`a-${r.id}`} className={selectCls} value={edit.linkDecision} onChange={(e) => setEdit({ linkDecision: e.target.value as Decision, matchedPartId: e.target.value === 'link' ? edit.matchedPartId : null })}>
                <option value="new">New part</option>
                <option value="link">Link to existing</option>
                <option value="skip">Skip</option>
              </select>
            </Field>
            {edit.linkDecision === 'link' && (
              <Field label="Existing part" htmlFor={`m-${r.id}`}>
                <select id={`m-${r.id}`} className={selectCls} value={edit.matchedPartId ?? ''} onChange={(e) => setEdit({ matchedPartId: e.target.value || null })}>
                  <option value="">Choose a part…</option>
                  {existing.map((p) => <option key={p.id} value={p.id}>{p.description}{p.partNumber ? ` #${p.partNumber}` : ''}</option>)}
                </select>
              </Field>
            )}
          </div>
          {edit.linkDecision === 'link' && edit.matchedPartId && (() => {
            const tp = existing.find((p) => p.id === edit.matchedPartId)
            if (!tp) return null
            return <p className="text-[13px] text-gray-400">{tp.unitCostCents != null ? `This part keeps its saved cost ${money(tp.unitCostCents)}.` : 'This part has no saved cost yet.'} The cost above only fills it if it is empty — it never replaces a saved cost.</p>
          })()}
          {r.skuWarning && edit.linkDecision === 'new' && <p className="text-[13px] text-amber-300">This part number is already tracked — link it instead of adding a duplicate?</p>}
          {edit.linkDecision === 'new' && (parseQty(edit.quantity) === null || edit.description.trim() === '') && <p className="text-[13px] text-amber-300">Needs a description and a quantity before it can be saved (or set it to Skip).</p>}
        </div>
      </div>
    )
  }
  return (
    <div className={`rounded-xl border px-3 py-2 ${skipped ? 'border-gray-800 bg-gray-900/40 opacity-60' : 'border-gray-800 bg-gray-900'}`}>
      <p className="text-sm font-semibold text-gray-100">{r.description || '(no description read)'}</p>
      <p className="text-[13px] text-gray-400">{[r.partNumber && `#${r.partNumber}`, r.brand, r.supplier, r.quantity != null ? `qty ${r.quantity}` : 'qty ?'].filter(Boolean).join(' · ')}</p>
      {r.unitCostCents != null && <p className="text-[13px] text-gray-400">Unit cost {money(r.unitCostCents)}</p>}
      {r.appliedPartId && <p className="text-[13px] text-emerald-400">On job</p>}
      {!r.appliedPartId && r.linkDecision === 'skip' && <p className="text-[13px] text-gray-400">Skipped</p>}
      {!r.appliedPartId && r.linkDecision === 'link' && <p className="text-[13px] text-blue-300">Linking to an existing part</p>}
    </div>
  )
}

function Warn({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-amber-700/40 bg-amber-900/15 px-3 py-2 text-[13px] leading-relaxed text-amber-200">{children}</p>
}
function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="block"><span className="mb-1 block text-[12px] font-medium text-gray-400">{label}</span>{children}</label>
}
function ReadOnly({ children }: { children: React.ReactNode }) {
  return <span className="block min-h-[44px] rounded-lg bg-gray-900 px-3 py-2 text-base text-gray-100">{children}</span>
}
