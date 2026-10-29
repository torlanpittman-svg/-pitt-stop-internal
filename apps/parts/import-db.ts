/**
 * PartsTech-screenshot import — data layer. Facts + orchestration only; the pure validation/normalization
 * lives in ./import-normalize. NO money policy, NO QuickBooks, NO billing. Applying a batch creates ordinary
 * `job_parts` rows (status 'needed', or 'ordered' only for a manager-confirmed purchase) in ONE atomic SQL
 * statement that also writes the append-only `service_order_events` audit — all-or-nothing.
 *
 * Idempotency & safety are DB-enforced (the Neon HTTP driver has no interactive transaction):
 *   - creation dedups on (order, capture_id) and (order, batch_hash) partial-unique indexes;
 *   - the AI read is claimed with a processing token so a stale/late read can't clobber a newer one;
 *   - apply CLAIMS the batch (status proposed→applied) in the same statement, so a double-tap/retry/
 *     concurrent apply inserts nothing the second time (no duplicate parts);
 *   - a per-import-row partial-unique index on job_parts guarantees one live part per source line;
 *   - a per-(order,supplier,order-ref) applied-dedup index blocks two different batches of the same
 *     supplier order from both applying unless a manager explicitly confirms the duplicate.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { getDb } from '@/platform/db'
import { serviceOrders, vehicles } from '@/apps/workflow/schema'
import { jobParts, partImportBatches, partImportImages, partImportRows } from './schema'
import {
  canonicalBatchHash, newRowApplyIssues, supplierConflict,
  normalizeDocumentKind, normalizeLinkDecision, parseCents, normalizeQuantity,
  DESCRIPTION_MAX, PART_NUMBER_MAX, BRAND_MAX, SUPPLIER_MAX,
  type DocumentKind, type LinkDecision,
} from './import-normalize'
import type { ImportProposal } from './import-normalize'

type BatchRow = typeof partImportBatches.$inferSelect
type ImageRow = typeof partImportImages.$inferSelect

function num(v: string | number | null): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
function rowsOf(res: unknown): Record<string, unknown>[] {
  const r = (res as { rows?: unknown[] }).rows ?? (res as unknown[])
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : []
}
/** Postgres unique-violation across neon-http / pglite / node-postgres error shapes. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown }
  if (e?.code === '23505' || e?.cause?.code === '23505') return true
  const text = `${String(e?.message ?? '')} ${String((e?.cause as { message?: unknown })?.message ?? '')} ${String(err)}`
  return /duplicate key value|unique constraint|23505/i.test(text)
}

// ── Job context (order must exist; VIN powers "Copy VIN") ──────────────────────────────────────────────
export interface ImportJobContext { orderId: string; orderNumber: string; vin: string | null; vehicle: string | null }
export async function getImportJobContext(orderId: string): Promise<ImportJobContext | null> {
  const [row] = await getDb()
    .select({ id: serviceOrders.id, orderNumber: serviceOrders.orderNumber, vin: vehicles.vin, year: vehicles.year, make: vehicles.make, model: vehicles.model })
    .from(serviceOrders).innerJoin(vehicles, eq(serviceOrders.vehicleId, vehicles.id))
    .where(eq(serviceOrders.id, orderId)).limit(1)
  if (!row) return null
  const vehicle = [row.year, row.make, row.model].filter(Boolean).join(' ') || null
  return { orderId: row.id, orderNumber: row.orderNumber, vin: row.vin ?? null, vehicle }
}

// ── Create a batch + its images (DB-idempotent) ────────────────────────────────────────────────────────
export interface NewImage { imageHash: string; storageRef: string; contentType: string; byteSize: number }
export interface CreateBatchInput {
  orderId: string; captureId: string | null; images: NewImage[]
  uploadedBy: string | null; uploadedByKey: string | null
}
export interface CreateBatchResult { batchId: string; duplicate: boolean; conflict?: boolean }

/** Dedupe identical member screenshots by content hash (keep first) so the canonical set + the per-batch
 *  unique index both see a clean set — re-attaching the exact same screenshot is a no-op, not a failure. */
function dedupeByHash(images: NewImage[]): NewImage[] {
  const seen = new Set<string>()
  const out: NewImage[] = []
  for (const img of images) { if (seen.has(img.imageHash)) continue; seen.add(img.imageHash); out.push(img) }
  return out
}

export async function findActiveBatchByCapture(orderId: string, captureId: string): Promise<BatchRow | null> {
  if (!captureId) return null
  const [b] = await getDb().select().from(partImportBatches)
    .where(and(eq(partImportBatches.serviceOrderId, orderId), eq(partImportBatches.captureId, captureId), ne(partImportBatches.status, 'cancelled')))
    .orderBy(desc(partImportBatches.createdAt)).limit(1)
  return b ?? null
}
export async function findActiveBatchByHash(orderId: string, batchHash: string): Promise<BatchRow | null> {
  const [b] = await getDb().select().from(partImportBatches)
    .where(and(eq(partImportBatches.serviceOrderId, orderId), eq(partImportBatches.batchHash, batchHash), ne(partImportBatches.status, 'cancelled')))
    .orderBy(desc(partImportBatches.createdAt)).limit(1)
  return b ?? null
}

/**
 * Create a batch AND all its images in ONE atomic SQL statement — so a failure mid-insert strands nothing
 * (a retry then re-creates cleanly). Idempotent on (order, capture_id) and (order, batch_hash): a retry
 * resumes the SAME batch with no second AI read. If a capture_id retry arrives with a DIFFERENT image set
 * (different batch hash) it is flagged `conflict` rather than silently attached to the old batch.
 */
export async function createBatchWithImages(input: CreateBatchInput): Promise<CreateBatchResult> {
  const db = getDb()
  const images = dedupeByHash(input.images)
  const batchHash = canonicalBatchHash(images.map((i) => i.imageHash))
  // Resume by capture id — but reject a conflicting retry payload (same capture, different screenshots).
  if (input.captureId) {
    const byCapture = await findActiveBatchByCapture(input.orderId, input.captureId)
    if (byCapture) {
      if (byCapture.batchHash && byCapture.batchHash !== batchHash) return { batchId: byCapture.id, duplicate: true, conflict: true }
      return { batchId: byCapture.id, duplicate: true }
    }
  }
  const byHash = await findActiveBatchByHash(input.orderId, batchHash)
  if (byHash) return { batchId: byHash.id, duplicate: true }

  const imagesJson = JSON.stringify(images.map((img, i) => ({
    ordinal: i, image_hash: img.imageHash, storage_ref: img.storageRef, content_type: img.contentType, byte_size: img.byteSize,
  })))
  try {
    const res = await db.execute(sql`
      WITH b AS (
        INSERT INTO part_import_batches (service_order_id, status, capture_id, batch_hash, uploaded_by, uploaded_by_key)
        VALUES (${input.orderId}, 'uploaded', ${input.captureId}, ${batchHash}, ${input.uploadedBy}, ${input.uploadedByKey})
        RETURNING id
      ), imgs AS (
        INSERT INTO part_import_images (batch_id, ordinal, image_hash, storage_ref, content_type, byte_size)
        SELECT b.id, x.ordinal, x.image_hash, x.storage_ref, x.content_type, x.byte_size
        FROM b, jsonb_to_recordset(${imagesJson}::jsonb) AS x(ordinal int, image_hash text, storage_ref text, content_type text, byte_size int)
        RETURNING id
      )
      SELECT (SELECT id FROM b) AS batch_id
    `)
    return { batchId: String(rowsOf(res)[0]?.batch_id), duplicate: false }
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost the race to a concurrent create. Resume by capture id — but a same-capture row with a DIFFERENT
      // image set is a conflicting retry (same guard as the precheck), never silently attached.
      const byCapture = input.captureId ? await findActiveBatchByCapture(input.orderId, input.captureId) : null
      if (byCapture) {
        if (byCapture.batchHash && byCapture.batchHash !== batchHash) return { batchId: byCapture.id, duplicate: true, conflict: true }
        return { batchId: byCapture.id, duplicate: true }
      }
      const byHash = await findActiveBatchByHash(input.orderId, batchHash)
      if (byHash) return { batchId: byHash.id, duplicate: true }
    }
    throw err
  }
}

export async function listBatchImages(batchId: string): Promise<ImageRow[]> {
  return getDb().select().from(partImportImages).where(eq(partImportImages.batchId, batchId)).orderBy(partImportImages.ordinal)
}

// ── Claim + apply the AI read (processing-token guarded) ───────────────────────────────────────────────
const READ_STALE_MS = 3 * 60 * 1000

/** Atomically CLAIM a batch for reading (status uploaded/failed → reading). A second concurrent read loses
 *  the claim. Returns the token + images. Stale 'reading' claims (a crashed read) can be re-claimed. */
export async function claimBatchReading(batchId: string): Promise<{ ok: true; token: string; images: ImageRow[] } | { ok: false; error: string; busy?: boolean }> {
  const db = getDb()
  const token = randomUUID()
  const staleCutoff = new Date(Date.now() - READ_STALE_MS)
  const claimed = await db.update(partImportBatches)
    .set({ status: 'reading', processingToken: token, revision: sql`${partImportBatches.revision} + 1`, updatedAt: new Date() })
    .where(and(
      eq(partImportBatches.id, batchId),
      sql`(${partImportBatches.status} IN ('uploaded','failed') OR (${partImportBatches.status} = 'reading' AND ${partImportBatches.updatedAt} < ${staleCutoff}))`,
    ))
    .returning({ id: partImportBatches.id })
  if (claimed.length === 0) return { ok: false, busy: true, error: 'This import is already being read — try again in a moment.' }
  const images = await listBatchImages(batchId)
  return { ok: true, token, images }
}

export async function releaseBatchReading(batchId: string, token: string, failed = false): Promise<void> {
  await getDb().update(partImportBatches)
    .set({ status: failed ? 'failed' : 'uploaded', aiStatus: failed ? 'failed' : undefined, processingToken: null, updatedAt: new Date() })
    .where(and(eq(partImportBatches.id, batchId), eq(partImportBatches.status, 'reading'), eq(partImportBatches.processingToken, token)))
}

export interface ReadWarnings { supplier: boolean; orderReference: boolean; documentKind: boolean; unreadImages: number; truncated: boolean }
export interface MergedExtraction {
  aiStatus: 'extracted' | 'failed'; aiModel: string | null; aiRaw: unknown
  documentKind: DocumentKind; supplier: string | null; orderReference: string | null
  taxCents: number | null; shippingCents: number | null; coreCents: number | null
  rows: Array<{ sourceImageId: string | null } & ImportProposal['rows'][number]>
  readWarnings?: ReadWarnings | null
}

/**
 * Apply the AI read result to a batch WE HOLD THE READING LOCK ON (token-guarded), in ONE atomic statement:
 * claim (reading→proposed|failed, token-guarded) + replace the proposal rows. If the row write FAILS the
 * whole statement rolls back and the batch stays 'reading' (the caller then marks it failed via release) —
 * a partial/empty proposal can never be exposed as a completed one. A read that produced ZERO usable rows
 * lands 'failed' (actionable), never 'proposed'. A stale/superseded attempt (token mismatch) no-ops. THROWS
 * on a genuine DB failure so the caller can recover; returns {ok:false,stale} only for a lost lock.
 */
export async function applyExtraction(batchId: string, token: string, m: MergedExtraction): Promise<{ ok: boolean; stale?: boolean }> {
  const db = getDb()
  const usable = m.rows.filter((r) => r.description || r.partNumber || r.unitCostCents != null || r.listPriceCents != null || r.lineTotalCents != null)
  const finalStatus = m.aiStatus === 'extracted' && usable.length > 0 ? 'proposed' : 'failed'
  const rowsJson = JSON.stringify(usable.map((r, i) => ({
    source_image_id: r.sourceImageId, ordinal: i,
    description: r.description, part_number: r.partNumber, brand: r.brand, supplier: r.supplier,
    quantity: r.quantity, unit_cost_cents: r.unitCostCents, list_price_cents: r.listPriceCents, line_total_cents: r.lineTotalCents,
  })))
  const res = await db.execute(sql`
    WITH claim AS (
      UPDATE part_import_batches SET
        status = ${finalStatus}, ai_status = ${m.aiStatus}, ai_model = ${m.aiModel},
        ai_raw = ${JSON.stringify(m.aiRaw ?? null)}::jsonb,
        read_warnings = ${JSON.stringify(m.readWarnings ?? null)}::jsonb,
        document_kind = ${m.documentKind}, supplier = ${m.supplier}, order_reference = ${m.orderReference},
        tax_cents = ${m.taxCents}, shipping_cents = ${m.shippingCents}, core_cents = ${m.coreCents},
        processing_token = NULL, revision = revision + 1, updated_at = now()
      WHERE id = ${batchId} AND status = 'reading' AND processing_token = ${token}
      RETURNING id
    ), del AS (
      DELETE FROM part_import_rows WHERE batch_id IN (SELECT id FROM claim) RETURNING id
    ), ins AS (
      INSERT INTO part_import_rows
        (batch_id, source_image_id, ordinal, description, part_number, brand, supplier, quantity, unit_cost_cents, list_price_cents, line_total_cents, link_decision)
      SELECT c.id,
             CASE WHEN x.source_image_id IN (SELECT id FROM part_import_images WHERE batch_id = c.id) THEN x.source_image_id ELSE NULL END,
             x.ordinal, x.description, x.part_number, x.brand, x.supplier, x.quantity, x.unit_cost_cents, x.list_price_cents, x.line_total_cents, 'new'
      FROM claim c, jsonb_to_recordset(${rowsJson}::jsonb)
        AS x(source_image_id uuid, ordinal int, description text, part_number text, brand text, supplier text, quantity numeric, unit_cost_cents int, list_price_cents int, line_total_cents int)
      RETURNING id
    )
    SELECT (SELECT count(*) FROM claim)::int AS claimed
  `)
  const claimed = Number(rowsOf(res)[0]?.claimed ?? 0)
  if (claimed === 0) return { ok: false, stale: true }
  return { ok: true }
}

// ── Read models ────────────────────────────────────────────────────────────────────────────────────────
export interface ImportRowView {
  id: string; sourceImageId: string | null; ordinal: number
  description: string | null; partNumber: string | null; brand: string | null; supplier: string | null
  quantity: number | null; unitCostCents: number | null; listPriceCents: number | null; lineTotalCents: number | null
  linkDecision: LinkDecision; matchedPartId: string | null
  appliedPartId: string | null       // derived: the live tracked part created/linked from this row
  issues: string[]                   // newRowApplyIssues (empty for link/skip)
  skuWarning: boolean                // this part number already exists as a live tracked part on the job
}
export interface ExistingPartLite { id: string; description: string; partNumber: string | null; supplier: string | null; status: string; billed: boolean; quantity: number | null; supplierOrderNumber: string | null; unitCostCents: number | null }
export interface BatchView {
  id: string; serviceOrderId: string; status: string; aiStatus: string; revision: number
  documentKind: DocumentKind; supplier: string | null; orderReference: string | null
  taxCents: number | null; shippingCents: number | null; coreCents: number | null
  markOrdered: boolean; duplicateConfirmed: boolean
  uploadedBy: string | null; reviewedBy: string | null; appliedBy: string | null
  appliedAt: string | null; createdAt: string
  images: Array<{ id: string; ordinal: number; contentType: string | null }>
  rows: ImportRowView[]
  warnings: {
    mixedSupplier: boolean; suppliers: string[]; duplicateSupplierOrder: boolean; overlappingImages: boolean
    // Read-time page disagreements the manager must reconcile, how many screenshots could not be read, and
    // whether the line list was truncated at the cap.
    pageConflicts: { supplier: boolean; orderReference: boolean; documentKind: boolean }
    unreadImages: number; truncated: boolean
  }
  canMarkOrdered: boolean    // eligibility for the "already placed" fast-path (purchase + supplier + ref + not mixed)
  existingParts: ExistingPartLite[]
}

function batchViewBase(b: BatchRow): Omit<BatchView, 'images' | 'rows' | 'warnings' | 'canMarkOrdered' | 'existingParts'> {
  return {
    id: b.id, serviceOrderId: b.serviceOrderId, status: b.status, aiStatus: b.aiStatus, revision: b.revision,
    documentKind: b.documentKind as DocumentKind, supplier: b.supplier, orderReference: b.orderReference,
    taxCents: b.taxCents, shippingCents: b.shippingCents, coreCents: b.coreCents,
    markOrdered: b.markOrdered, duplicateConfirmed: b.duplicateConfirmed,
    uploadedBy: b.uploadedBy, reviewedBy: b.reviewedBy, appliedBy: b.appliedBy,
    appliedAt: b.appliedAt ? b.appliedAt.toISOString() : null, createdAt: b.createdAt.toISOString(),
  }
}

export async function getBatch(batchId: string, orderId: string): Promise<BatchRow | null> {
  const [b] = await getDb().select().from(partImportBatches)
    .where(and(eq(partImportBatches.id, batchId), eq(partImportBatches.serviceOrderId, orderId))).limit(1)
  return b ?? null
}

/** Live (non-cancelled) tracked parts on the order — suggests links + warns on same SKU/supplier, and
 *  carries the fields the link-conflict checks + the reviewer UI need (qty, existing order #, existing cost). */
export async function listExistingParts(orderId: string): Promise<ExistingPartLite[]> {
  const rows = await getDb()
    .select({ id: jobParts.id, description: jobParts.description, partNumber: jobParts.partNumber, supplier: jobParts.supplier, status: jobParts.status, line: jobParts.jobLineItemId, quantity: jobParts.quantity, supplierOrderNumber: jobParts.supplierOrderNumber, unitCostCents: jobParts.unitCostCents })
    .from(jobParts).where(and(eq(jobParts.serviceOrderId, orderId), ne(jobParts.status, 'cancelled')))
    .orderBy(jobParts.createdAt)
  return rows.map((r) => ({ id: r.id, description: r.description, partNumber: r.partNumber, supplier: r.supplier, status: r.status, billed: r.line != null, quantity: num(r.quantity), supplierOrderNumber: r.supplierOrderNumber, unitCostCents: r.unitCostCents }))
}

export async function getBatchView(batchId: string, orderId: string): Promise<BatchView | null> {
  const db = getDb()
  const b = await getBatch(batchId, orderId)
  if (!b) return null
  const images = await listBatchImages(batchId)
  const rowRows = await db.select().from(partImportRows).where(eq(partImportRows.batchId, batchId)).orderBy(partImportRows.ordinal)
  // Provenance: which live tracked part came from each import row.
  const provIds = rowRows.map((r) => r.id)
  const provenance = provIds.length
    ? await db.select({ importRowId: jobParts.importRowId, id: jobParts.id })
        .from(jobParts).where(and(inArray(jobParts.importRowId, provIds), ne(jobParts.status, 'cancelled')))
    : []
  const provMap = new Map(provenance.filter((p) => p.importRowId).map((p) => [p.importRowId as string, p.id]))
  const existingParts = await listExistingParts(orderId)
  const existingSkus = new Set(existingParts.filter((p) => p.partNumber).map((p) => p.partNumber!.toLowerCase()))
  const rows: ImportRowView[] = rowRows.map((r) => {
    const quantity = num(r.quantity)
    const decision = normalizeLinkDecision(r.linkDecision)
    const appliedPartId = provMap.get(r.id) ?? null
    return {
      id: r.id, sourceImageId: r.sourceImageId, ordinal: r.ordinal,
      description: r.description, partNumber: r.partNumber, brand: r.brand, supplier: r.supplier,
      quantity, unitCostCents: r.unitCostCents, listPriceCents: r.listPriceCents, lineTotalCents: r.lineTotalCents,
      linkDecision: decision, matchedPartId: r.matchedPartId,
      appliedPartId,
      issues: decision === 'new' ? newRowApplyIssues({ description: r.description, quantity }) : [],
      // Warn when the same part number is already tracked on the job (unless THIS row produced it).
      skuWarning: !appliedPartId && !!r.partNumber && existingSkus.has(r.partNumber.toLowerCase()),
    }
  })
  const conflict = supplierConflict(rows, b.supplier)
  const dupOrder = await hasDuplicateAppliedOrder(orderId, b.supplier, b.orderReference, b.id)
  const overlap = await hasOverlappingImages(orderId, images.map((i) => i.imageHash), b.id)
  const canMark = b.documentKind === 'purchase' && !!b.supplier && !!b.orderReference && !conflict.mixed
  const rw = (b.readWarnings && typeof b.readWarnings === 'object' ? b.readWarnings : {}) as Partial<ReadWarnings>
  return {
    ...batchViewBase(b),
    images: images.map((i) => ({ id: i.id, ordinal: i.ordinal, contentType: i.contentType })),
    rows,
    warnings: {
      mixedSupplier: conflict.mixed, suppliers: conflict.suppliers, duplicateSupplierOrder: dupOrder, overlappingImages: overlap,
      pageConflicts: { supplier: !!rw.supplier, orderReference: !!rw.orderReference, documentKind: !!rw.documentKind },
      unreadImages: Number(rw.unreadImages ?? 0), truncated: !!rw.truncated,
    },
    canMarkOrdered: canMark,
    existingParts,
  }
}

/** Parts a proposal row may actually LINK to at APPLY time — live, shop-supplied (not customer parts), and
 *  not already import-linked. The apply CTE re-checks the same predicate atomically. */
export async function eligibleLinkTargets(orderId: string): Promise<Set<string>> {
  const rows = await getDb().select({ id: jobParts.id }).from(jobParts)
    .where(and(
      eq(jobParts.serviceOrderId, orderId), ne(jobParts.status, 'cancelled'),
      eq(jobParts.supply, 'shop'), sql`${jobParts.importRowId} IS NULL`,
    ))
  return new Set(rows.map((r) => r.id))
}

export interface BatchSummary { id: string; status: string; documentKind: string; supplier: string | null; orderReference: string | null; rowCount: number; appliedCount: number; createdAt: string; uploadedBy: string | null }
export async function listBatchesForOrder(orderId: string): Promise<BatchSummary[]> {
  const db = getDb()
  const batches = await db.select().from(partImportBatches)
    .where(and(eq(partImportBatches.serviceOrderId, orderId), ne(partImportBatches.status, 'cancelled')))
    .orderBy(desc(partImportBatches.createdAt))
  if (batches.length === 0) return []
  const ids = batches.map((b) => b.id)
  const counts = await db.select({ batchId: partImportRows.batchId, n: sql<number>`count(*)::int` })
    .from(partImportRows).where(inArray(partImportRows.batchId, ids)).groupBy(partImportRows.batchId)
  const countMap = new Map(counts.map((c) => [c.batchId, Number(c.n)]))
  // Applied provenance count per batch.
  const applied = await db.select({ batchId: partImportRows.batchId, n: sql<number>`count(*)::int` })
    .from(jobParts).innerJoin(partImportRows, eq(partImportRows.id, jobParts.importRowId))
    .where(and(inArray(partImportRows.batchId, ids), ne(jobParts.status, 'cancelled'))).groupBy(partImportRows.batchId)
  const appliedMap = new Map(applied.map((c) => [c.batchId, Number(c.n)]))
  return batches.map((b) => ({
    id: b.id, status: b.status, documentKind: b.documentKind, supplier: b.supplier, orderReference: b.orderReference,
    rowCount: countMap.get(b.id) ?? 0, appliedCount: appliedMap.get(b.id) ?? 0,
    createdAt: b.createdAt.toISOString(), uploadedBy: b.uploadedBy,
  }))
}

// ── Duplicate detection ──────────────────────────────────────────────────────────────────────────────
export async function hasDuplicateAppliedOrder(orderId: string, supplier: string | null, orderReference: string | null, excludeBatchId: string): Promise<boolean> {
  if (!supplier || !orderReference) return false
  const [d] = await getDb().select({ id: partImportBatches.id }).from(partImportBatches)
    .where(and(
      eq(partImportBatches.serviceOrderId, orderId), eq(partImportBatches.status, 'applied'),
      ne(partImportBatches.id, excludeBatchId),
      sql`lower(${partImportBatches.supplier}) = lower(${supplier})`,
      sql`lower(${partImportBatches.orderReference}) = lower(${orderReference})`,
    )).limit(1)
  return !!d
}
export async function hasOverlappingImages(orderId: string, imageHashes: string[], excludeBatchId: string): Promise<boolean> {
  if (imageHashes.length === 0) return false
  const [d] = await getDb().select({ id: partImportImages.id }).from(partImportImages)
    .innerJoin(partImportBatches, eq(partImportBatches.id, partImportImages.batchId))
    .where(and(
      eq(partImportBatches.serviceOrderId, orderId), ne(partImportBatches.status, 'cancelled'),
      ne(partImportImages.batchId, excludeBatchId), inArray(partImportImages.imageHash, imageHashes),
    )).limit(1)
  return !!d
}

// ── Manager review (correct rows + document metadata) ──────────────────────────────────────────────────
const REVIEWABLE = ['uploaded', 'proposed', 'failed'] as const
export interface ReviewRowInput {
  id: string
  description?: string | null; partNumber?: string | null; brand?: string | null; supplier?: string | null
  quantity?: number | null; unitCostCents?: number | null; listPriceCents?: number | null; lineTotalCents?: number | null
  linkDecision?: LinkDecision; matchedPartId?: string | null
}
export interface ReviewBatchInput {
  documentKind?: DocumentKind; supplier?: string | null; orderReference?: string | null
  taxCents?: number | null; shippingCents?: number | null; coreCents?: number | null
  markOrdered?: boolean; notes?: string | null
  rows?: ReviewRowInput[]
  expectedRevision?: number
}
function clip(s: string | null | undefined, max: number): string | null { const t = (s ?? '').trim(); return t ? t.slice(0, max) : null }
const centsFromCents = (v: number | null | undefined): number | null => (v == null ? null : parseCents(v / 100))

/**
 * Persist a manager's review in ONE atomic statement: claim the batch (reviewable status + optional expected
 * revision), bump the revision, update the batch's document metadata, and apply the per-row edits — all or
 * nothing. Row edits are MERGED over the stored row (unspecified fields preserved), so a partial edit never
 * nulls other fields. Validates provenance (each row is in THIS batch; each link target is a LIVE part on
 * THIS order; no two rows link the same part) BEFORE the write. The optimistic revision guard means a
 * manager cannot overwrite — or later apply — edits they did not see. Only from a reviewable state.
 */
export async function saveBatchReview(batchId: string, orderId: string, input: ReviewBatchInput, actor: string | null): Promise<{ ok: boolean; error?: string; conflict?: boolean }> {
  const db = getDb()
  const b = await getBatch(batchId, orderId)
  if (!b) return { ok: false, error: 'Import not found on this order.' }
  if (!(REVIEWABLE as readonly string[]).includes(b.status)) return { ok: false, error: `This import is "${b.status}" — it can no longer be edited.` }

  // Merge the row edits over the stored rows (preserve unspecified fields) + validate provenance/links.
  let rowsJson = '[]'
  if (input.rows && input.rows.length) {
    const existing = await db.select().from(partImportRows).where(eq(partImportRows.batchId, batchId))
    const byId = new Map(existing.map((r) => [r.id, r]))
    const livePartIds = new Set((await listExistingParts(orderId)).map((p) => p.id))
    const linkTargets = new Map<string, string>()
    let merged: Array<Record<string, unknown>>
    try {
      merged = input.rows.map((r) => {
      const cur = byId.get(r.id)
      if (!cur) throw new ReviewError('A reviewed row is not part of this import.')
      const decision = r.linkDecision ? normalizeLinkDecision(r.linkDecision) : (cur.linkDecision as LinkDecision)
      const matched = decision === 'link' ? (r.matchedPartId !== undefined ? r.matchedPartId : cur.matchedPartId) : null
      if (decision === 'link') {
        if (!matched || !livePartIds.has(matched)) throw new ReviewError('Choose a current part on this job to link to.')
        if (linkTargets.has(matched)) throw new ReviewError('Two lines can’t link to the same existing part — pick different parts.')
        linkTargets.set(matched, r.id)
      }
      const q = r.quantity !== undefined ? normalizeQuantity(r.quantity) : num(cur.quantity)
      return {
        id: r.id,
        description: r.description !== undefined ? clip(r.description, DESCRIPTION_MAX) : cur.description,
        part_number: r.partNumber !== undefined ? clip(r.partNumber, PART_NUMBER_MAX) : cur.partNumber,
        brand: r.brand !== undefined ? clip(r.brand, BRAND_MAX) : cur.brand,
        supplier: r.supplier !== undefined ? clip(r.supplier, SUPPLIER_MAX) : cur.supplier,
        quantity: q,
        unit_cost_cents: r.unitCostCents !== undefined ? centsFromCents(r.unitCostCents) : cur.unitCostCents,
        list_price_cents: r.listPriceCents !== undefined ? centsFromCents(r.listPriceCents) : cur.listPriceCents,
        line_total_cents: r.lineTotalCents !== undefined ? centsFromCents(r.lineTotalCents) : cur.lineTotalCents,
        link_decision: decision,
        matched_part_id: matched,
      }
      })
    } catch (e) {
      if (e instanceof ReviewError) return { ok: false, error: e.message }
      throw e
    }
    rowsJson = JSON.stringify(merged)
  }

  // Build the batch SET list — only provided fields change (others keep their column value).
  const sets = [sql`revision = revision + 1`, sql`reviewed_by = ${actor}`, sql`reviewed_at = now()`, sql`updated_at = now()`]
  if (input.documentKind !== undefined) sets.push(sql`document_kind = ${normalizeDocumentKind(input.documentKind)}`)
  if (input.supplier !== undefined) sets.push(sql`supplier = ${clip(input.supplier, SUPPLIER_MAX)}`)
  if (input.orderReference !== undefined) sets.push(sql`order_reference = ${clip(input.orderReference, 120)}`)
  if (input.taxCents !== undefined) sets.push(sql`tax_cents = ${centsFromCents(input.taxCents)}`)
  if (input.shippingCents !== undefined) sets.push(sql`shipping_cents = ${centsFromCents(input.shippingCents)}`)
  if (input.coreCents !== undefined) sets.push(sql`core_cents = ${centsFromCents(input.coreCents)}`)
  if (input.markOrdered !== undefined) sets.push(sql`mark_ordered = ${input.markOrdered === true}`)
  if (input.notes !== undefined) sets.push(sql`notes = ${clip(input.notes, 2000)}`)

  const revGuard = input.expectedRevision !== undefined ? sql` AND revision = ${input.expectedRevision}` : sql``
  const rowCte = rowsJson !== '[]'
    ? sql`, upd AS (
        UPDATE part_import_rows r SET
          description = x.description, part_number = x.part_number, brand = x.brand, supplier = x.supplier,
          quantity = x.quantity, unit_cost_cents = x.unit_cost_cents, list_price_cents = x.list_price_cents,
          line_total_cents = x.line_total_cents, link_decision = x.link_decision, matched_part_id = x.matched_part_id,
          updated_at = now()
        FROM claim c, jsonb_to_recordset(${rowsJson}::jsonb)
          AS x(id uuid, description text, part_number text, brand text, supplier text, quantity numeric, unit_cost_cents int, list_price_cents int, line_total_cents int, link_decision text, matched_part_id uuid)
        WHERE r.id = x.id AND r.batch_id = c.id
        RETURNING r.id
      )`
    : sql``
  const res = await db.execute(sql`
    WITH claim AS (
      UPDATE part_import_batches SET ${sql.join(sets, sql`, `)}
      WHERE id = ${batchId} AND service_order_id = ${orderId} AND status IN ('uploaded','proposed','failed')${revGuard}
      RETURNING id
    )${rowCte}
    SELECT (SELECT count(*) FROM claim)::int AS claimed
  `)
  const claimed = Number(rowsOf(res)[0]?.claimed ?? 0)
  if (claimed === 0) return { ok: false, conflict: true, error: 'This import was just updated by someone else — refresh and try again.' }
  return { ok: true }
}

/** Thrown by review validation; converted to a friendly { ok:false } by saveBatchReview's caller path. */
class ReviewError extends Error {}

// ── Cancel (soft; audited; never from applied) ─────────────────────────────────────────────────────────
export async function cancelBatch(batchId: string, orderId: string, actor: string | null, opts?: { expectedRevision?: number }): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const b = await getBatch(batchId, orderId)
  if (!b) return { ok: false, error: 'Import not found on this order.' }
  if (b.status === 'applied') return { ok: false, error: 'An applied import can’t be cancelled — remove the parts individually instead.' }
  if (b.status === 'cancelled') return { ok: true }
  // Soft cancel + append-only audit, atomically (claim guarded so it can’t race an apply into applied).
  const revGuard = opts?.expectedRevision !== undefined ? sql` AND revision = ${opts.expectedRevision}` : sql``
  const res = await db.execute(sql`
    WITH claim AS (
      UPDATE part_import_batches SET status='cancelled', cancelled_at=now(), revision=revision+1, updated_at=now()
      WHERE id=${batchId} AND service_order_id=${orderId} AND status <> 'applied' AND status <> 'cancelled'${revGuard}
      RETURNING id, service_order_id
    ), evt AS (
      INSERT INTO service_order_events (service_order_id, event_type, employee_name, note)
      SELECT service_order_id, 'parts_import_cancelled', ${actor}, ${'Cancelled parts screenshot import'} FROM claim
      RETURNING id
    )
    SELECT (SELECT count(*) FROM claim)::int AS claimed
  `)
  const claimed = Number(rowsOf(res)[0]?.claimed ?? 0)
  if (claimed === 0) return { ok: false, error: 'This import was just updated — refresh and try again.' }
  return { ok: true }
}

// ── Apply (atomic: claim + insert parts + link + audit, all-or-nothing) ────────────────────────────────
export interface ApplyResult {
  ok: boolean; error?: string
  inserted?: number; linked?: number
  needsDuplicateConfirm?: boolean; needsDuplicateAck?: boolean; conflict?: boolean
}
export interface ApplyOpts { duplicateConfirmed?: boolean; acknowledgeDuplicates?: boolean; expectedRevision?: number }
/**
 * Apply a reviewed batch into job_parts in ONE atomic statement that CLAIMS the batch (proposed→applied,
 * optional revision guard) AND fully validates every selected row inside the claim's WHERE — so if ANY
 * selected 'new' row is incomplete, or ANY 'link' target is ineligible (missing / wrong job / cancelled /
 * customer-supplied / already import-linked), the claim affects zero rows and NOTHING is applied (no silent
 * partial apply, no "applied" status). Valid 'new' rows become tracked parts; 'link' rows fill operational
 * fields WITHOUT clobbering billing/sell/received/labor (COALESCE), promoting only a still-'needed' part to
 * 'ordered'. Writes the append-only, money-free audit. A duplicate supplier order is blocked unless
 * `duplicateConfirmed` (also DB-guarded by a partial unique index). Never bills, never touches QuickBooks.
 */
export async function applyImport(batchId: string, orderId: string, actor: string | null, opts?: ApplyOpts): Promise<ApplyResult> {
  const db = getDb()
  const b = await getBatch(batchId, orderId)
  if (!b) return { ok: false, error: 'Import not found on this order.' }
  if (b.status === 'applied') return { ok: true, inserted: 0, linked: 0 } // idempotent no-op
  if (b.status !== 'proposed') return { ok: false, error: `This import is "${b.status}" — it isn’t ready to apply.` }

  const rowRows = await db.select().from(partImportRows).where(eq(partImportRows.batchId, batchId)).orderBy(partImportRows.ordinal)
  const conflict = supplierConflict(rowRows.map((r) => ({ supplier: r.supplier })), b.supplier)
  const effectiveMarkOrdered = b.markOrdered && b.documentKind === 'purchase' && !!b.supplier && !!b.orderReference && !conflict.mixed
  const eqCI = (a: string | null, c: string | null) => !a || !c || a.trim().toLowerCase() === c.trim().toLowerCase()

  // Friendly pre-checks (the claim WHERE + atomic count assertion below are the real backstops).
  const existing = new Map((await listExistingParts(orderId)).map((p) => [p.id, p]))
  const linkable = await eligibleLinkTargets(orderId)
  const seenTargets = new Set<string>()
  let applicable = 0
  for (const r of rowRows) {
    const decision = normalizeLinkDecision(r.linkDecision)
    if (decision === 'skip') continue
    if (decision === 'new') {
      const issues = newRowApplyIssues({ description: r.description, quantity: num(r.quantity) })
      if (issues.length) return { ok: false, error: `Fix "${r.description || 'a part'}": ${issues.join(' and ')} required (or set it to Skip).` }
    } else {
      if (!r.matchedPartId || !linkable.has(r.matchedPartId)) return { ok: false, error: 'A linked line points at a part that can’t be linked (already imported, cancelled, customer-supplied, or not on this job) — refresh and re-check.' }
      if (seenTargets.has(r.matchedPartId)) return { ok: false, error: 'Two lines link to the same part — fix before applying.' }
      const tgt = existing.get(r.matchedPartId)
      // A link must not keep one supplier while stamping another's order reference.
      if (!eqCI(tgt?.supplier ?? null, r.supplier ?? b.supplier)) {
        return { ok: false, error: `That part is from ${tgt?.supplier}; this import is from ${r.supplier ?? b.supplier}. Fix the supplier before linking.` }
      }
      // A known, different quantity is a real conflict (the import does not silently overwrite the part's qty).
      const rq = num(r.quantity)
      if (rq != null && tgt?.quantity != null && rq !== tgt.quantity) {
        return { ok: false, error: `That part is qty ${tgt.quantity} but this line is qty ${rq}. Fix the quantity before linking.` }
      }
      // Marking as ordered must not contradict an order # already on the part.
      if (effectiveMarkOrdered && tgt?.supplierOrderNumber && b.orderReference && !eqCI(tgt.supplierOrderNumber, b.orderReference)) {
        return { ok: false, error: `That part already has order #${tgt.supplierOrderNumber}; this import is #${b.orderReference}. Fix the order reference before linking.` }
      }
      seenTargets.add(r.matchedPartId)
    }
    applicable++
  }
  if (applicable === 0) return { ok: false, error: 'Nothing to apply — add a description and quantity, or choose a part to link.' }

  const duplicateConfirmed = opts?.duplicateConfirmed === true
  if (!duplicateConfirmed && await hasDuplicateAppliedOrder(orderId, b.supplier, b.orderReference, b.id)) {
    return { ok: false, needsDuplicateConfirm: true, error: 'This supplier order was already imported to this job. Confirm it is a legitimate additional import to continue.' }
  }
  // Saving a NEW part whose SKU is already tracked, or re-using a screenshot already imported here, needs an
  // explicit "yes, additional part" acknowledgement (never a silent duplicate). Confirming a duplicate ORDER
  // already implies this, so it is not re-prompted then.
  if (!duplicateConfirmed && opts?.acknowledgeDuplicates !== true) {
    const existingSkus = new Set([...existing.values()].filter((p) => p.partNumber).map((p) => p.partNumber!.toLowerCase()))
    const newSkus = rowRows.filter((r) => normalizeLinkDecision(r.linkDecision) === 'new' && r.partNumber).map((r) => r.partNumber!.toLowerCase())
    const skuDup = newSkus.some((s) => existingSkus.has(s))                 // same SKU already tracked on the job
    const intraDup = newSkus.length !== new Set(newSkus).size              // the SAME SKU appears twice in THIS import
    const overlap = await hasOverlappingImages(orderId, (await listBatchImages(b.id)).map((i) => i.imageHash), b.id)
    if (skuDup || intraDup || overlap) {
      return { ok: false, needsDuplicateAck: true, error: (skuDup || intraDup)
        ? 'Some parts are already on the job or repeat in this import. Confirm you want to add them as additional parts (or link/skip them).'
        : 'A screenshot here was already imported to this job. Confirm you want to add these as additional parts.' }
    }
  }

  const note = `Applied parts screenshot import${b.supplier ? ` · ${b.supplier}` : ''}${b.orderReference ? ` #${b.orderReference}` : ''}${effectiveMarkOrdered ? ' · marked ordered' : ''}`
  // Always guard on a revision — the API supplies the one the manager saw; a direct service caller uses the
  // revision we just read, so the SQL never applies based on a stale JS pre-read.
  const effectiveRevision = opts?.expectedRevision ?? b.revision
  const ordered = effectiveMarkOrdered // local alias for the SQL CASE branches
  const effSupplier = b.supplier // the batch supplier the link-eligibility check falls back to
  try {
    const res = await db.execute(sql`
      WITH claim AS (
        UPDATE part_import_batches
           SET status='applied', applied_by=${actor}, applied_at=now(), duplicate_confirmed=${duplicateConfirmed}, revision=revision+1, updated_at=now()
         WHERE id=${batchId} AND service_order_id=${orderId} AND status='proposed' AND revision=${effectiveRevision}
           -- every selected 'new' row must be complete …
           AND NOT EXISTS (SELECT 1 FROM part_import_rows r WHERE r.batch_id=${batchId} AND r.link_decision='new'
                 AND (r.description IS NULL OR btrim(r.description)='' OR r.quantity IS NULL OR r.quantity <= 0))
           -- … no two selected 'link' rows target the same part …
           AND NOT EXISTS (SELECT r.matched_part_id FROM part_import_rows r WHERE r.batch_id=${batchId}
                 AND r.link_decision='link' AND r.matched_part_id IS NOT NULL
                 GROUP BY r.matched_part_id HAVING count(*) > 1)
           -- … and every selected 'link' target must be eligible (live, this job, shop, not already imported,
           --     and not a supplier conflict).
           AND NOT EXISTS (SELECT 1 FROM part_import_rows r WHERE r.batch_id=${batchId} AND r.link_decision='link'
                 AND (r.matched_part_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM job_parts jp WHERE jp.id=r.matched_part_id AND jp.service_order_id=${orderId}
                     AND jp.status <> 'cancelled' AND jp.supply = 'shop' AND jp.import_row_id IS NULL
                     AND (jp.supplier IS NULL OR COALESCE(r.supplier, ${effSupplier}) IS NULL
                          OR lower(jp.supplier) = lower(COALESCE(r.supplier, ${effSupplier})))
                     AND (r.quantity IS NULL OR jp.quantity IS NULL OR r.quantity = jp.quantity)
                     AND ${ordered
                       ? sql`(jp.supplier_order_number IS NULL OR ${b.orderReference}::text IS NULL OR lower(jp.supplier_order_number) = lower(${b.orderReference}))`
                       : sql`true`})))
        RETURNING id, service_order_id, supplier, order_reference
      ),
      ins AS (
        INSERT INTO job_parts
          (service_order_id, import_row_id, description, part_number, brand, supplier, provider, provider_ref,
           quantity, unit_cost_cents, status, supplier_order_number, ordered_at, notes, created_by, updated_by)
        SELECT c.service_order_id, r.id, btrim(r.description), r.part_number, r.brand,
               COALESCE(r.supplier, c.supplier), 'partstech_screenshot', c.order_reference,
               r.quantity, r.unit_cost_cents,
               ${ordered ? sql`'ordered'` : sql`'needed'`},
               ${ordered ? sql`c.order_reference` : sql`NULL`},
               ${ordered ? sql`now()` : sql`NULL`},
               r.notes, ${actor}, ${actor}
          FROM part_import_rows r JOIN claim c ON c.id = r.batch_id
         WHERE r.link_decision='new'
        RETURNING id
      ),
      lnk AS (
        UPDATE job_parts jp
           SET import_row_id = r.id,
               supplier = COALESCE(jp.supplier, r.supplier, c.supplier),
               unit_cost_cents = COALESCE(jp.unit_cost_cents, r.unit_cost_cents),
               provider = COALESCE(jp.provider, 'partstech_screenshot'),
               provider_ref = COALESCE(jp.provider_ref, c.order_reference),
               supplier_order_number = ${ordered ? sql`COALESCE(jp.supplier_order_number, c.order_reference)` : sql`jp.supplier_order_number`},
               status = ${ordered ? sql`CASE WHEN jp.status='needed' THEN 'ordered' ELSE jp.status END` : sql`jp.status`},
               ordered_at = ${ordered ? sql`CASE WHEN jp.status='needed' THEN now() ELSE jp.ordered_at END` : sql`jp.ordered_at`},
               updated_at = now(), updated_by = ${actor}
          FROM part_import_rows r JOIN claim c ON c.id = r.batch_id
         WHERE r.link_decision='link' AND r.matched_part_id IS NOT NULL AND jp.id = r.matched_part_id
           AND jp.service_order_id = c.service_order_id AND jp.status <> 'cancelled' AND jp.supply='shop' AND jp.import_row_id IS NULL
           -- Re-check the same eligibility the claim verified, so a target changed concurrently (supplier,
           -- quantity, or an existing order #) is NOT written; the runtime count assertion then rolls back.
           AND (jp.supplier IS NULL OR COALESCE(r.supplier, ${effSupplier}) IS NULL OR lower(jp.supplier) = lower(COALESCE(r.supplier, ${effSupplier})))
           AND (r.quantity IS NULL OR jp.quantity IS NULL OR r.quantity = jp.quantity)
           AND ${ordered ? sql`(jp.supplier_order_number IS NULL OR ${b.orderReference}::text IS NULL OR lower(jp.supplier_order_number) = lower(${b.orderReference}))` : sql`true`}
        RETURNING jp.id
      ),
      selected AS (
        SELECT count(*)::int AS n FROM part_import_rows r JOIN claim c ON c.id = r.batch_id WHERE r.link_decision IN ('new','link')
      ),
      evt AS (
        INSERT INTO service_order_events (service_order_id, event_type, employee_name, note)
        SELECT service_order_id, 'parts_import_applied', ${actor}, ${note} FROM claim
        RETURNING id
      )
      SELECT (SELECT count(*) FROM claim)::int AS claimed,
             (SELECT count(*) FROM ins)::int AS inserted,
             (SELECT count(*) FROM lnk)::int AS linked,
             -- ATOMIC assertion: every selected row must have produced exactly one insert/link, else a
             -- concurrent cancel/trigger silently skipped a write → force a rollback. The denominator is a
             -- RUNTIME value (0 only on mismatch) so Postgres cannot constant-fold it into an always-error.
             (SELECT 1 / CASE WHEN (SELECT n FROM selected) = (SELECT count(*) FROM ins) + (SELECT count(*) FROM lnk)
                              THEN 1 ELSE 0 END) AS assert_ok
    `)
    const out = rowsOf(res)[0] ?? {}
    const claimed = Number(out.claimed ?? 0)
    if (claimed === 0) {
      const cur = await getBatch(batchId, orderId)
      if (cur?.status === 'applied') return { ok: true, inserted: 0, linked: 0 }
      // A guard filtered the claim out (stale revision, or a selected row became invalid under us).
      return { ok: false, conflict: true, error: 'This import can’t be applied as-is — it changed under you (a part or edit is out of date). Refresh and re-check.' }
    }
    return { ok: true, inserted: Number(out.inserted ?? 0), linked: Number(out.linked ?? 0) }
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, needsDuplicateConfirm: true, error: 'This supplier order was already imported to this job. Confirm it is a legitimate additional import to continue.' }
    }
    if (isDivisionByZero(err)) {
      // The count assertion fired: a selected part was cancelled/linked out from under us mid-apply. Nothing
      // was committed (atomic rollback) — surface a recoverable conflict.
      return { ok: false, conflict: true, error: 'A part changed while saving (it was cancelled or imported elsewhere). Nothing was applied — refresh and re-check.' }
    }
    throw err
  }
}

/** Postgres division-by-zero (22012) — our atomic apply assertion uses it to force a rollback on a skipped write. */
function isDivisionByZero(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown }
  if (e?.code === '22012' || e?.cause?.code === '22012') return true
  return /division by zero/i.test(`${String(e?.message ?? '')} ${String((e?.cause as { message?: unknown })?.message ?? '')} ${String(err)}`)
}
