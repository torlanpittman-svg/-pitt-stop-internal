/**
 * Business Receipts — PURE read-side view helpers (no server-only deps, unit-testable).
 *
 * Two responsibilities:
 *   1. toReviewCard(): the ONLY shape sent to the client. It deliberately EXCLUDES ai_raw and
 *      ai_extracted (raw model output can contain sensitive receipt text — server/manager-only) and the
 *      Blob storage reference (never expose a direct storage URL/pathname). The receipt image is served
 *      solely through the gated retrieval route.
 *   2. decideRetrieval(): the authorization + resolution decision for the gated image route — resolved
 *      from the application receipt ID + the actor's role, so a client can never point retrieval at an
 *      arbitrary Blob key (IDOR-safe). Content type is clamped to a safe inline allowlist.
 */
import type { businessReceipts } from './schema'

type Row = typeof businessReceipts.$inferSelect

export interface ReviewCardData {
  id: string; status: string; imageUrl: string | null; aiStatus: string
  entity: string; category: string; vendor: string | null; receiptDate: string | null
  subtotalCents: number | null; taxCents: number | null; totalCents: number | null
  shippingCents: number | null; invoiceNumber: string | null; orderNumber: string | null; description: string | null
  contentType: string | null
  paymentMethod: string | null; accountRef: string | null; paymentLast4: string | null; memo: string | null
  funding: string; filingNote: string | null; attentionReasons: string[]
  clarifiedAt: string | null; clarifiedBy: string | null
  inventoryVehicleId: string | null
  uploadedBy: string | null; createdAt: string; approvedBy: string | null; filedBy: string | null; rejectedReason: string | null
  present: Record<string, boolean> | null
}

/** The gated retrieval path for a receipt's original image (never the Blob URL/pathname). */
export function receiptImagePath(id: string): string {
  return `/api/expenses/receipt/${id}/image`
}

/** Serialize a DB row into the client-safe review card. Excludes ai_raw / ai_extracted / storageRef. */
export function toReviewCard(r: Row): ReviewCardData {
  const present = (r.confidence && typeof r.confidence === 'object' ? r.confidence : null) as Record<string, boolean> | null
  const hasImage = r.storage !== 'none' && !!r.storageRef
  const createdAt = r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt)
  const attentionReasons = Array.isArray(r.attentionReasons) ? (r.attentionReasons as unknown[]).filter((x): x is string => typeof x === 'string') : []
  return {
    id: r.id, status: r.status, imageUrl: hasImage ? receiptImagePath(r.id) : null, aiStatus: r.aiStatus,
    entity: r.entity, category: r.category, vendor: r.vendor, receiptDate: r.receiptDate,
    subtotalCents: r.subtotalCents, taxCents: r.taxCents, totalCents: r.totalCents,
    shippingCents: r.shippingCents ?? null, invoiceNumber: r.invoiceNumber ?? null, orderNumber: r.orderNumber ?? null, description: r.description ?? null,
    contentType: r.contentType,
    paymentMethod: r.paymentMethod, accountRef: r.accountRef, paymentLast4: r.paymentLast4, memo: r.memo,
    funding: r.funding, filingNote: r.filingNote, attentionReasons,
    clarifiedAt: r.clarifiedAt instanceof Date ? r.clarifiedAt.toISOString() : (r.clarifiedAt ? String(r.clarifiedAt) : null),
    clarifiedBy: r.clarifiedBy,
    inventoryVehicleId: r.inventoryVehicleId,
    uploadedBy: r.uploadedBy, createdAt, approvedBy: r.approvedBy, filedBy: r.filedBy, rejectedReason: r.rejectedReason, present,
  }
}

/** The extra read-back facts stored on a row (components of the total + document identifiers) — returned to
 *  the capture screen for review. Shipping and tax are INSIDE total_cents; they are never added on top. */
export function storedExtras(row: Pick<Row, 'subtotalCents' | 'taxCents' | 'shippingCents' | 'invoiceNumber' | 'orderNumber' | 'description'>) {
  return {
    subtotalCents: row.subtotalCents ?? null, taxCents: row.taxCents ?? null, shippingCents: row.shippingCents ?? null,
    invoiceNumber: row.invoiceNumber ?? null, orderNumber: row.orderNumber ?? null, description: row.description ?? null,
  }
}

// ── Gated retrieval decision ─────────────────────────────────────────────────────
// Raster photos, a vendor's PDF invoice, and pasted plain text render inline. Everything else downloads.
// (PDF and text are only ever stored after their own validation — magic bytes / control-char stripping —
// and are served with nosniff, so neither can be re-interpreted as HTML.)
const SAFE_INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'])
export type RetrievalActor = { role: string | null | undefined } | null
export type RetrievalDecision =
  | { ok: false; status: 401 | 403 | 404 }
  | { ok: true; pathname: string; contentType: string; disposition: 'inline' | 'attachment' }

function isManager(role: string | null | undefined): boolean { return role === 'manager' || role === 'admin' }

/**
 * Decide whether to serve a receipt image. Authorize the ACTOR FIRST (anonymous → 401; non-manager →
 * 403) so existence is never leaked to an unauthorized caller. Then resolve the row (looked up by app
 * receipt id upstream): missing / no private image → 404. Content type is clamped to a safe inline
 * allowlist; anything else is served as an octet-stream attachment (never rendered inline).
 */
export function decideRetrieval(actor: RetrievalActor, row: Row | null): RetrievalDecision {
  if (!actor) return { ok: false, status: 401 }
  if (!isManager(actor.role)) return { ok: false, status: 403 }
  if (!row || row.storage !== 'blob_private' || !row.storageRef) return { ok: false, status: 404 }
  const safe = row.contentType && SAFE_INLINE_TYPES.has(row.contentType)
  return {
    ok: true,
    pathname: row.storageRef,
    contentType: safe ? (row.contentType === 'text/plain' ? 'text/plain; charset=utf-8' : (row.contentType as string)) : 'application/octet-stream',
    disposition: safe ? 'inline' : 'attachment',
  }
}
