/**
 * Parts screenshot import — one batch.
 *   GET  → the full proposal view (money + original-image ids are MANAGER-ONLY; employees get a redacted,
 *          non-money view so an upload never "feels lost").
 *   POST → actions. 'read' may be triggered by the uploader (employee or manager); for an already
 *          proposed/applied batch it returns the existing view WITHOUT rate-limits or AI, a cancelled batch
 *          cannot be read, and a stale 'reading' batch is reclaimable. review/apply/cancel require a resolved
 *          manager/admin AND the revision the client last saw; malformed edits are rejected (never coerced).
 *          Never bills, never touches QuickBooks.
 */
import { NextResponse } from 'next/server'
import { consumeRateLimit, RATE_LIMITS } from '@/apps/expenses/db'
import {
  getBatch, getBatchView, saveBatchReview, applyImport, cancelBatch,
  type BatchView, type ReviewBatchInput, type ReviewRowInput,
} from '@/apps/parts/import-db'
import { readBatch } from '@/apps/parts/import-read'
import { DOCUMENT_KINDS, LINK_DECISIONS, MAX_BATCH_ROWS, MAX_QUANTITY, MAX_MONEY_CENTS, type DocumentKind, type LinkDecision } from '@/apps/parts/import-normalize'
import { errorCode } from '@/apps/expenses/errors'
import { logger } from '@/platform/logger'
import { importGate, isUuid, sameOrigin } from '../_gate'
import { readBoundedBody } from '../_body'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const APP = 'parts:import:batch'
const MAX_BODY_BYTES = 512 * 1024

/** Employees see descriptions/part#/qty/supplier/status — never costs, totals, or document money. */
function redact(view: BatchView, manager: boolean): BatchView {
  if (manager) return view
  return {
    ...view,
    taxCents: null, shippingCents: null, coreCents: null,
    rows: view.rows.map((r) => ({ ...r, unitCostCents: null, listPriceCents: null, lineTotalCents: null })),
    existingParts: [],
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string; batchId: string }> }) {
  const g = await importGate(req)
  if ('response' in g) return g.response
  const { id, batchId } = await params
  if (!isUuid(id) || !isUuid(batchId)) return NextResponse.json({ ok: false, error: 'Bad id.' }, { status: 400 })
  const view = await getBatchView(batchId, id)
  if (!view) return NextResponse.json({ ok: false, error: 'Import not found on this order.' }, { status: 404 })
  return NextResponse.json({ ok: true, manager: g.manager, batch: redact(view, g.manager) })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string; batchId: string }> }) {
  const g = await importGate(req)
  if ('response' in g) return g.response
  if (!sameOrigin(req)) return NextResponse.json({ ok: false, error: 'Bad request origin.' }, { status: 403 })
  const { id, batchId } = await params
  if (!isUuid(id) || !isUuid(batchId)) return NextResponse.json({ ok: false, error: 'Bad id.' }, { status: 400 })

  // Bound + parse the JSON body with a real byte cap (reject oversized / malformed outright).
  let text: string
  try { const buf = await readBoundedBody(req, MAX_BODY_BYTES); text = buf ? buf.toString('utf8') : await req.text() }
  catch (err) { if (err instanceof RangeError) return NextResponse.json({ ok: false, error: 'Request too large.' }, { status: 413 }); return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }) }
  let body: Record<string, unknown>
  try { const j = JSON.parse(text || '{}'); if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('shape'); body = j }
  catch { return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 }) }
  const action = String(body.action ?? '')

  // 'read' — verify the batch belongs to THIS order first; return an existing proposal/applied view without
  // any rate-limit or AI; refuse a cancelled batch; otherwise read (claims; stale 'reading' is reclaimable).
  if (action === 'read') {
    const scoped = await getBatch(batchId, id)
    if (!scoped) return NextResponse.json({ ok: false, error: 'Import not found on this order.' }, { status: 404 })
    if (scoped.status === 'cancelled') return NextResponse.json({ ok: false, error: 'This import was cancelled.' }, { status: 409 })
    if (scoped.status === 'proposed' || scoped.status === 'applied') {
      const view = await getBatchView(batchId, id)
      return NextResponse.json({ ok: true, readStatus: scoped.status, manager: g.manager, batch: view ? redact(view, g.manager) : null })
    }
    const perActor = await consumeRateLimit(`parts-import:read:actor:${g.actorKey ?? batchId}`, RATE_LIMITS.extractActor.limit, RATE_LIMITS.extractActor.windowMs)
    if (!perActor.ok) return NextResponse.json({ ok: false, error: `Too many reads — try again in ${perActor.retryAfterSec}s.` }, { status: 429 })
    const perBatch = await consumeRateLimit(`parts-import:read:batch:${batchId}`, RATE_LIMITS.extractReceipt.limit, RATE_LIMITS.extractReceipt.windowMs)
    if (!perBatch.ok) return NextResponse.json({ ok: false, error: 'This import was read too many times — try again later.' }, { status: 429 })
    const r = await readBatch(batchId).catch((err) => { logger.error(APP, 'read_failed', { code: errorCode(err) }); return { ok: false, code: 'read_failed', error: 'Could not read the screenshots — they are saved; retry or enter parts manually.' } as const })
    if (!r.ok && 'busy' in r && r.busy) return NextResponse.json({ ok: false, busy: true, error: r.error }, { status: 409 })
    const view = await getBatchView(batchId, id)
    if (!view) return NextResponse.json({ ok: false, error: 'Import not found on this order.' }, { status: 404 })
    return NextResponse.json({ ok: true, readStatus: r.ok ? r.status : 'failed', unreadImages: 'unreadImages' in r ? r.unreadImages : undefined, manager: g.manager, batch: redact(view, g.manager) })
  }

  // All other actions are manager-only AND require the revision the client last saw.
  if (!g.manager) return NextResponse.json({ ok: false, error: 'A manager reviews and saves imported parts.' }, { status: 403 })
  const rev = revOf(body)
  if (rev === undefined) return NextResponse.json({ ok: false, error: 'Missing or invalid revision — reload the import and try again.' }, { status: 400 })

  try {
    switch (action) {
      case 'review': {
        const parsed = parseReview(body, rev)
        if ('error' in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })
        const r = await saveBatchReview(batchId, id, parsed.input, g.actorName)
        if (!r.ok) return NextResponse.json(r, { status: r.conflict ? 409 : 400 })
        break
      }
      case 'apply': {
        if (body.duplicateConfirmed !== undefined && typeof body.duplicateConfirmed !== 'boolean') return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 })
        if (body.acknowledgeDuplicates !== undefined && typeof body.acknowledgeDuplicates !== 'boolean') return NextResponse.json({ ok: false, error: 'Bad request.' }, { status: 400 })
        const r = await applyImport(batchId, id, g.actorName, { duplicateConfirmed: body.duplicateConfirmed === true, acknowledgeDuplicates: body.acknowledgeDuplicates === true, expectedRevision: rev })
        if (!r.ok) return NextResponse.json(r, { status: (r.needsDuplicateConfirm || r.needsDuplicateAck || r.conflict) ? 409 : 400 })
        break
      }
      case 'cancel': {
        const r = await cancelBatch(batchId, id, g.actorName, { expectedRevision: rev })
        if (!r.ok) return NextResponse.json(r, { status: 400 })
        break
      }
      default:
        return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 })
    }
  } catch (err) {
    logger.error(APP, 'action_failed', { action, code: errorCode(err) })
    return NextResponse.json({ ok: false, error: 'Could not update this import — refresh and try again.' }, { status: 500 })
  }

  const view = await getBatchView(batchId, id)
  if (!view) return NextResponse.json({ ok: false, error: 'Import not found on this order.' }, { status: 404 })
  return NextResponse.json({ ok: true, manager: g.manager, batch: view })
}

/** A safe, non-negative integer revision, or undefined. */
function revOf(body: Record<string, unknown>): number | undefined {
  const v = body.expectedRevision
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
}

// ── Strict review validation (reject, never coerce) ──────────────────────────────────────────────────────
class Invalid extends Error {}
/** A string ≤ max, or null. Anything else (object/number/boolean) is rejected; an OVERSIZED string is
 *  rejected too (never silently truncated into a different SKU / order reference). */
function strOrNull(v: unknown, max: number, field: string): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw new Invalid(`Bad ${field}.`)
  if (v.length > max) throw new Invalid(`${field} is too long.`)
  return v
}
/** Reject anything but a known enum string (an array like ['new'] must NOT coerce through String()). */
function enumOrThrow<T extends string>(v: unknown, allowed: readonly string[], field: string): T {
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Invalid(`Bad ${field}.`)
  return v as T
}
/** Integer cents in [0, MAX], or null. Rejects booleans, non-integers, and out-of-range. */
function centsOrNull(v: unknown, field: string): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_MONEY_CENTS) throw new Invalid(`Bad ${field}.`)
  return v
}
/** A positive quantity (≤ 2 decimals, ≤ MAX_QUANTITY), or null. Rejects booleans/strings/≤0/over-precise. */
function qtyOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_QUANTITY) throw new Invalid('Bad quantity.')
  if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) throw new Invalid('Bad quantity.')
  return Math.round(v * 100) / 100
}

function parseReview(body: Record<string, unknown>, expectedRevision: number): { input: ReviewBatchInput } | { error: string } {
  try {
    const input: ReviewBatchInput = { expectedRevision }
    if (body.documentKind !== undefined) input.documentKind = enumOrThrow<DocumentKind>(body.documentKind, DOCUMENT_KINDS, 'document type')
    if (body.supplier !== undefined) input.supplier = strOrNull(body.supplier, 120, 'supplier')
    if (body.orderReference !== undefined) input.orderReference = strOrNull(body.orderReference, 120, 'order reference')
    if (body.taxCents !== undefined) input.taxCents = centsOrNull(body.taxCents, 'tax')
    if (body.shippingCents !== undefined) input.shippingCents = centsOrNull(body.shippingCents, 'shipping')
    if (body.coreCents !== undefined) input.coreCents = centsOrNull(body.coreCents, 'core')
    if (body.markOrdered !== undefined) { if (typeof body.markOrdered !== 'boolean') throw new Invalid('Bad markOrdered.'); input.markOrdered = body.markOrdered }
    if (body.notes !== undefined) input.notes = strOrNull(body.notes, 2000, 'notes')
    if (body.rows !== undefined) {
      if (!Array.isArray(body.rows)) throw new Invalid('Bad rows.')
      if (body.rows.length > MAX_BATCH_ROWS) throw new Invalid('Too many rows.')
      const seen = new Set<string>()
      input.rows = (body.rows as unknown[]).map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Invalid('Bad row.')
        const r = raw as Record<string, unknown>
        if (typeof r.id !== 'string' || !isUuid(r.id)) throw new Invalid('Bad row id.')
        if (seen.has(r.id)) throw new Invalid('Duplicate row id.')
        seen.add(r.id)
        const row: ReviewRowInput = { id: r.id }
        if (r.description !== undefined) row.description = strOrNull(r.description, 300, 'description')
        if (r.partNumber !== undefined) row.partNumber = strOrNull(r.partNumber, 80, 'part number')
        if (r.brand !== undefined) row.brand = strOrNull(r.brand, 80, 'brand')
        if (r.supplier !== undefined) row.supplier = strOrNull(r.supplier, 120, 'supplier')
        if (r.quantity !== undefined) row.quantity = qtyOrNull(r.quantity)
        if (r.unitCostCents !== undefined) row.unitCostCents = centsOrNull(r.unitCostCents, 'unit cost')
        if (r.listPriceCents !== undefined) row.listPriceCents = centsOrNull(r.listPriceCents, 'list price')
        if (r.lineTotalCents !== undefined) row.lineTotalCents = centsOrNull(r.lineTotalCents, 'line total')
        if (r.linkDecision !== undefined) row.linkDecision = enumOrThrow<LinkDecision>(r.linkDecision, LINK_DECISIONS, 'link decision')
        if (r.matchedPartId !== undefined) { if (r.matchedPartId !== null && (typeof r.matchedPartId !== 'string' || !isUuid(r.matchedPartId))) throw new Invalid('Bad matched part id.'); row.matchedPartId = r.matchedPartId as string | null }
        return row
      })
    }
    return { input }
  } catch (e) {
    if (e instanceof Invalid) return { error: e.message }
    throw e
  }
}
