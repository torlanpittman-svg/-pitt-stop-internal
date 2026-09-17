/**
 * POST /api/expenses/receipt/[id]/extract   { token?: string }
 *
 * The AI READ step — separate from the fast save. The receipt is ALREADY stored; this fills the vendor/date/
 * total proposal, so a slow or failed read is recoverable (the row is never lost). FAIL-CLOSED + ownership:
 * a verified session AND (manager | a capture token minted for this receipt | the uploader's key) — the same
 * rule as filing, so an employee can only read their own capture. Concurrency-safe + idempotent: it CLAIMS a
 * durable per-receipt lock, so two triggers can't run two AI calls; a late result is token-guarded and only
 * fills EMPTY fields (never overwrites an employee edit). Bounded rate limits cap AI cost. No money/QB.
 */
import { NextResponse } from 'next/server'
import { getReceipt, claimRetryExtraction, applyRetryExtraction, releaseRetryClaim, possibleDuplicateFor, consumeRateLimit, RATE_LIMITS } from '@/apps/expenses/db'
import { receiptUploaderFromRequest, canFileReceipt } from '@/apps/expenses/authz'
import { extractExpense } from '@/apps/expenses/ai'
import { matchPaymentSource } from '@/apps/expenses/payment'
import { errorCode } from '@/apps/expenses/errors'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // matches the other vision routes; the read must fit comfortably under the limit
const APP = 'expenses:receipt:extract'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const uploader = await receiptUploaderFromRequest(req)
  if (!uploader) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { token?: string }

  const row = await getReceipt(id)
  if (!row) return NextResponse.json({ ok: false, error: 'Receipt not found.' }, { status: 404 })
  if (!canFileReceipt(uploader.actor, { id: row.id, uploadedByKey: row.uploadedByKey }, body.token)) {
    return NextResponse.json({ ok: false, error: 'Not your receipt.' }, { status: 403 })
  }
  // Already read (a resume after the read finished): return the current proposal without another AI call.
  // Re-derive the payment source from what was stored (method + card ending); the brand isn't persisted, so
  // this only auto-selects on the unambiguous ending — a manual choice always wins (client guards it).
  if (row.aiStatus === 'extracted') {
    const present = (row.confidence && typeof row.confidence === 'object' ? row.confidence : {}) as Record<string, boolean>
    const paymentChoice = matchPaymentSource({ method: row.paymentMethod, brand: null, cardLast4: row.paymentLast4 })
    return NextResponse.json({ ok: true, aiStatus: 'extracted', proposal: { vendor: row.vendor, date: row.receiptDate, totalCents: row.totalCents, categoryKey: row.category, paymentChoice, present }, possibleDuplicate: await dupHint(id) })
  }

  // Bounded rate limits (per actor AND per receipt) so repeated triggers can't burn unbounded AI cost.
  const actorKey = uploader.actor?.key ?? `rcpt:${id}`
  const perActor = await consumeRateLimit(`extract:actor:${actorKey}`, RATE_LIMITS.extractActor.limit, RATE_LIMITS.extractActor.windowMs)
  if (!perActor.ok) return NextResponse.json({ ok: false, error: `Too many reads — try again in ${perActor.retryAfterSec}s.` }, { status: 429 })
  const perReceipt = await consumeRateLimit(`extract:rcpt:${id}`, RATE_LIMITS.extractReceipt.limit, RATE_LIMITS.extractReceipt.windowMs)
  if (!perReceipt.ok) return NextResponse.json({ ok: false, error: `This receipt was read too many times — try again later.` }, { status: 429 })

  const claim = await claimRetryExtraction(id)
  if (!claim.ok) return NextResponse.json({ ok: false, busy: !!claim.busy, error: claim.error }, { status: claim.busy ? 409 : 409 })
  const { row: claimed, token } = claim
  try {
    const { getPrivateBlob } = await import('@/platform/blob')
    const blob = await getPrivateBlob(claimed.storageRef!)
    if (!blob) { await releaseRetryClaim(id, token); return NextResponse.json({ ok: false, aiStatus: 'failed', error: 'Could not load the stored image.' }, { status: 502 }) }
    const { derivedForExtraction } = await import('@/apps/expenses/image-decode')
    const derived = await derivedForExtraction(blob.bytes)
    const ai = await extractExpense(derived.bytes.toString('base64'), derived.contentType)
    const e = ai.extraction
    const r = await applyRetryExtraction(id, token, {
      aiStatus: ai.status, aiModel: ai.model, aiRaw: ai.raw, aiExtracted: e, confidence: e.present,
      vendor: e.vendor, receiptDate: e.date, subtotalCents: e.subtotalCents, taxCents: e.taxCents,
      totalCents: e.totalCents, category: e.categoryKey, paymentMethod: e.paymentMethod, paymentLast4: e.paymentLast4,
    }, uploader.name)
    if (!r.ok) return NextResponse.json({ ok: false, aiStatus: ai.status, error: r.error ?? 'This read is no longer current.', stale: r.stale }, { status: 409 })
    logger.info(APP, 'read', { aiStatus: ai.status })
    // Deterministic, server-side payment-source match from the extracted evidence (the model never supplies
    // the account mapping). Returned as a choice KEY the client auto-selects; null when unresolved.
    const paymentChoice = matchPaymentSource({ method: e.paymentMethod, brand: e.cardBrand, cardLast4: e.paymentLast4 })
    // Only surface a possible duplicate once we actually have vendor/date/total to compare on.
    return NextResponse.json({
      ok: true, aiStatus: ai.status,
      proposal: { vendor: e.vendor, date: e.date, totalCents: e.totalCents, categoryKey: e.categoryKey, paymentChoice, present: e.present },
      possibleDuplicate: ai.status === 'extracted' ? await dupHint(id) : null,
    })
  } catch (err) {
    await releaseRetryClaim(id, token).catch(() => {})
    logger.error(APP, 'failed', { code: errorCode(err) })
    return NextResponse.json({ ok: false, aiStatus: 'failed', error: 'Could not read the photo — it is saved; retry or enter it manually.' }, { status: 502 })
  }
}

/** A minimal, self-only possible-duplicate hint (never another employee's receipt details). */
async function dupHint(id: string): Promise<{ receiptId: string } | null> {
  const d = await possibleDuplicateFor(id).catch(() => null)
  return d ? { receiptId: d.id } : null
}
