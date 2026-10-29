/**
 * Parts purchasing & tracking schema.
 *
 * One row per part line tracked against a repair order (`service_orders`). This is the
 * PROCUREMENT record — needed → ordered → received, with supplier confirmation, expected
 * arrival, received quantities, and returns/core credits. It is deliberately separate from
 * the estimate/invoice line items (`job_line_items`): billing stays authoritative there, and
 * a part is only "ordered" once a real order is recorded. An optional `jobLineItemId` links a
 * tracked part back to its billing line so costs are never double-counted.
 *
 * Applied via drizzle/migrations/manual/0044_job_parts.sql.
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  date,
  varchar,
  integer,
  jsonb,
  numeric,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { serviceOrders, jobLineItems, jobServices } from '@/apps/workflow/schema'

// needed → ordered → partially_received → received ; cancelled is terminal.
export const jobParts = pgTable(
  'job_parts',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    serviceOrderId: uuid('service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    // Optional link to the estimate/invoice line this part bills under (prevents double billing).
    jobLineItemId:  uuid('job_line_item_id').references(() => jobLineItems.id, { onDelete: 'set null' }),
    // The estimate row (job_services.kind='part') that bills this part. Null for customer-supplied parts.
    jobServiceId:   uuid('job_service_id').references(() => jobServices.id, { onDelete: 'set null' }),
    // 'shop' = special-order part we buy for this job; 'customer' = customer-supplied (no parts charge).
    supply:         varchar('supply', { length: 12 }).notNull().default('shop'),
    fitment:        text('fitment'),

    // Installation-labor review (migration 0052). needs_review | labor_added | included | part_only | waived.
    // labor_added/included point at the covering labor service; if it is removed (SET NULL) or no
    // longer covers the part, the review re-opens (apps/parts/labor-review.ts).
    laborStatus:    varchar('labor_status', { length: 16 }).notNull().default('needs_review'),
    laborServiceId: uuid('labor_service_id').references(() => jobServices.id, { onDelete: 'set null' }),
    // The service line a "clarify as part" operation attached this part to — the idempotency CLAIM for
    // that operation (migration 0054). Only set by clarifyServiceWithPart; null for every other part,
    // so ordinary same-named parts with different sources are never constrained.
    clarifiesServiceId: uuid('clarifies_service_id').references(() => jobServices.id, { onDelete: 'set null' }),
    // Provenance for a part CREATED (or linked) by a PartsTech-screenshot import (migration 0066). Points
    // at the import proposal row it came from, so an applied part is traceable and a re-apply is blocked by
    // the partial unique index below. The FK is declared in the SQL migration only (ON DELETE SET NULL) to
    // avoid a mutual schema import with part_import_rows; the link clears if the import batch is purged, it
    // never deletes the tracked part. Null for every manually-entered part.
    importRowId:    uuid('import_row_id'),
    laborNote:      text('labor_note'),
    laborDecidedBy: varchar('labor_decided_by', { length: 200 }),
    laborDecidedAt: timestamp('labor_decided_at', { withTimezone: true }),

    description:    text('description').notNull(),
    partNumber:     varchar('part_number', { length: 80 }),
    brand:          varchar('brand', { length: 80 }),
    supplier:       varchar('supplier', { length: 120 }),
    // Future direct-ordering provider (e.g. PartsTech) + its reference; null for manual entry.
    provider:       varchar('provider', { length: 40 }),
    providerRef:    varchar('provider_ref', { length: 120 }),

    quantity:       numeric('quantity', { precision: 10, scale: 2 }).notNull().default('1'),
    // Manager-only pricing (cost = what we pay the supplier, sell = what the customer is billed).
    unitCostCents:  integer('unit_cost_cents'),
    sellPriceCents: integer('sell_price_cents'),

    status:             varchar('status', { length: 24 }).notNull().default('needed'),
    supplierOrderNumber: varchar('supplier_order_number', { length: 120 }),
    orderedAt:          timestamp('ordered_at', { withTimezone: true }),
    expectedArrival:    date('expected_arrival'),

    receivedQuantity:   numeric('received_quantity', { precision: 10, scale: 2 }).notNull().default('0'),

    // Returns & core-credit tracking.
    isCore:             boolean('is_core').notNull().default(false),
    coreCreditCents:    integer('core_credit_cents'),
    returnedQuantity:   numeric('returned_quantity', { precision: 10, scale: 2 }).notNull().default('0'),
    returnCreditCents:  integer('return_credit_cents'),

    notes:          text('notes'),
    createdBy:      varchar('created_by', { length: 200 }),
    updatedBy:      varchar('updated_by', { length: 200 }),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_parts_order_idx').on(t.serviceOrderId),
    index('job_parts_status_idx').on(t.status),
    index('job_parts_service_idx').on(t.jobServiceId),
    index('job_parts_labor_service_idx').on(t.laborServiceId),
    // One live part record per estimate part row (migration 0053) — a retried conversion can't duplicate it.
    uniqueIndex('job_parts_active_service_uniq').on(t.jobServiceId).where(sql`job_service_id IS NOT NULL AND status <> 'cancelled'`),
    // At most one live clarification part per (clarified service line, description, source) — migration
    // 0054. A retried, double-tapped, or concurrent "clarify as part" collapses to ONE part (the whole
    // operation is a single atomic statement), while ordinary parts (clarifies_service_id null) are free.
    uniqueIndex('job_parts_clarify_uniq').on(t.clarifiesServiceId, t.description, t.supply).where(sql`clarifies_service_id IS NOT NULL AND status <> 'cancelled'`),
    index('job_parts_import_row_idx').on(t.importRowId),
    // At most one LIVE tracked part per import proposal row (migration 0066) — a retried/double-tapped/
    // concurrent apply of the same screenshot batch can never create two parts for the same source line.
    uniqueIndex('job_parts_import_row_uniq').on(t.importRowId).where(sql`import_row_id IS NOT NULL AND status <> 'cancelled'`),
  ]
)

/**
 * PartsTech-screenshot IMPORT (migration 0066). The owner's quickest phone workflow: a manager/employee
 * opens app.partstech.com in another tab (logged in, NAPA/O'Reilly), screenshots the cart/quote/order, then
 * uploads 1–4 screenshots HERE against a specific Job. The AI reads the line items into a PROPOSAL a manager
 * reviews; applying it creates ordinary `job_parts` rows (status 'needed'). It NEVER bills, never writes to
 * QuickBooks, never records an order/received/paid state on its own. Three tables:
 *   - part_import_batches : one upload session bound to a service order (document-level metadata + lifecycle)
 *   - part_import_images  : the preserved private screenshots of a batch (evidence; deduped per-batch by hash)
 *   - part_import_rows    : the extracted line-item PROPOSAL (unverified; manager reviews/links/applies)
 */

// uploaded → reading → proposed → applied ; failed/cancelled are recoverable/terminal.
// 'proposed' = AI read finished (even if it found nothing) and a manager may review+apply.
export const partImportBatches = pgTable(
  'part_import_batches',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    serviceOrderId: uuid('service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    status:         varchar('status', { length: 16 }).notNull().default('uploaded'),

    // Stable per-capture id the client keeps across retries so a lost/timed-out response resumes the SAME
    // batch instead of creating a second one. Canonical content hash = sha-256 over the sorted member image
    // hashes: re-uploading the SAME screenshots to the SAME job resumes the existing batch (no AI re-run).
    captureId:      varchar('capture_id', { length: 64 }),
    batchHash:      varchar('batch_hash', { length: 64 }),

    // Document-level metadata from the AI — an UNVERIFIED PROPOSAL a manager confirms, never turned into
    // sell price/tax arithmetic. documentKind distinguishes a real purchase/order from a quote/cart/unknown.
    documentKind:   varchar('document_kind', { length: 12 }).notNull().default('unknown'), // purchase|quote|cart|unknown
    supplier:       varchar('supplier', { length: 120 }),
    orderReference: varchar('order_reference', { length: 120 }),
    // Separate document metadata only (never auto-allocated onto line costs or marked up).
    taxCents:       integer('tax_cents'),
    shippingCents:  integer('shipping_cents'),
    coreCents:      integer('core_cents'),

    // Manager review choice "this order has already been placed" — honored at apply ONLY when it is a
    // confirmed purchase with BOTH a supplier and an order reference (re-validated server-side), so NEW
    // parts land 'ordered' (supplier + order #) in one tap instead of retyping Mark Ordered. Quote/cart/
    // unknown stay 'needed'. Never marks received/paid, never places a real supplier order.
    markOrdered:       boolean('mark_ordered').notNull().default(false),
    // Explicit manager confirmation that this is a LEGITIMATE additional import for a supplier/order that
    // was already imported (not an accidental re-apply). Required to clear the applied-dedup unique guard.
    duplicateConfirmed: boolean('duplicate_confirmed').notNull().default(false),

    // Optimistic-concurrency revision: bumped on every claim/read/review/apply/cancel. The UI echoes the
    // revision it last saw; a review/apply/cancel for a stale revision is rejected so a manager can never
    // overwrite — or apply — edits they did not see.
    revision:       integer('revision').notNull().default(0),

    // AI proposal status + audit-only raw output (never logged; manager-only).
    aiStatus:       varchar('ai_status', { length: 16 }).notNull().default('pending'), // pending|extracted|failed
    aiModel:        varchar('ai_model', { length: 60 }),
    aiRaw:          jsonb('ai_raw'),
    // Read-time, non-sensitive warnings the reviewer must see: pages that disagreed on supplier/order/kind,
    // how many screenshots could not be read, and whether the line list was truncated. Surfaced in the view.
    readWarnings:   jsonb('read_warnings'),
    // Extraction-attempt ownership token (same pattern as receipts): a late/stale read can't overwrite a
    // newer attempt or a manager correction.
    processingToken: varchar('processing_token', { length: 40 }),

    uploadedBy:     varchar('uploaded_by', { length: 200 }),
    uploadedByKey:  varchar('uploaded_by_key', { length: 60 }),
    reviewedBy:     varchar('reviewed_by', { length: 200 }),
    reviewedAt:     timestamp('reviewed_at', { withTimezone: true }),
    appliedBy:      varchar('applied_by', { length: 200 }),
    appliedAt:      timestamp('applied_at', { withTimezone: true }),
    cancelledAt:    timestamp('cancelled_at', { withTimezone: true }),
    notes:          text('notes'),

    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('part_import_batches_order_idx').on(t.serviceOrderId),
    index('part_import_batches_status_idx').on(t.status),
    index('part_import_batches_supplier_idx').on(t.serviceOrderId, t.supplier, t.orderReference),
    // One active (non-cancelled) batch per (order, capture_id): a retry after a lost response resumes it.
    uniqueIndex('part_import_batches_capture_uniq').on(t.serviceOrderId, t.captureId).where(sql`capture_id IS NOT NULL AND status <> 'cancelled'`),
    // One active (non-cancelled) batch per (order, batch_hash): identical screenshots to the SAME job
    // collapse to one batch (no duplicate AI read). A DIFFERENT job may upload the same screenshots freely.
    uniqueIndex('part_import_batches_hash_uniq').on(t.serviceOrderId, t.batchHash).where(sql`batch_hash IS NOT NULL AND status <> 'cancelled'`),
    // Applied-dedup GUARD (CASE-INSENSITIVE): at most one APPLIED, non-duplicate-confirmed batch per
    // (order, lower(supplier), lower(order reference)). Two concurrent applies of the same supplier order —
    // even "NAPA/REF" vs "napa/ref" — can't BOTH reach 'applied'; the loser unique-violates and must be
    // reviewed. A genuine additional import is allowed only via duplicate_confirmed. This is the DB-level
    // guarantee; the JS precheck is only a friendly early message, never the concurrency guard.
    uniqueIndex('part_import_batches_applied_order_uniq')
      .on(t.serviceOrderId, sql`lower(${t.supplier})`, sql`lower(${t.orderReference})`)
      .where(sql`status = 'applied' AND duplicate_confirmed = false AND supplier IS NOT NULL AND order_reference IS NOT NULL`),
    check('part_import_batches_status_chk', sql`status IN ('uploaded','reading','proposed','applied','failed','cancelled')`),
    check('part_import_batches_kind_chk', sql`document_kind IN ('purchase','quote','cart','unknown')`),
    check('part_import_batches_ai_status_chk', sql`ai_status IN ('pending','extracted','failed')`),
    check('part_import_batches_cents_chk', sql`(tax_cents IS NULL OR tax_cents >= 0) AND (shipping_cents IS NULL OR shipping_cents >= 0) AND (core_cents IS NULL OR core_cents >= 0)`),
  ]
)

export const partImportImages = pgTable(
  'part_import_images',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    batchId:     uuid('batch_id').notNull().references(() => partImportBatches.id, { onDelete: 'cascade' }),
    ordinal:     integer('ordinal').notNull().default(0),
    // sha-256 of the ORIGINAL bytes + the PRIVATE blob pathname (never a public URL/token).
    imageHash:   varchar('image_hash', { length: 64 }).notNull(),
    storageRef:  text('storage_ref').notNull(),
    contentType: varchar('content_type', { length: 60 }),
    byteSize:    integer('byte_size'),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('part_import_images_batch_idx').on(t.batchId),
    // Same screenshot can't be stored twice in one batch (dedup within the batch).
    uniqueIndex('part_import_images_batch_hash_uniq').on(t.batchId, t.imageHash),
    check('part_import_images_bytes_chk', sql`byte_size IS NULL OR (byte_size > 0 AND byte_size <= 8388608)`),
  ]
)

export const partImportRows = pgTable(
  'part_import_rows',
  {
    id:            uuid('id').primaryKey().defaultRandom(),
    batchId:       uuid('batch_id').notNull().references(() => partImportBatches.id, { onDelete: 'cascade' }),
    // Provenance: which screenshot this line was read from (nullable — a manager can add a blank row).
    sourceImageId: uuid('source_image_id').references(() => partImportImages.id, { onDelete: 'set null' }),
    ordinal:       integer('ordinal').notNull().default(0),

    description:   text('description'),
    partNumber:    varchar('part_number', { length: 80 }),
    brand:         varchar('brand', { length: 80 }),
    supplier:      varchar('supplier', { length: 120 }),
    // NULL when the screenshot's quantity was unreadable — never defaulted to 1. The reviewer confirms a
    // positive quantity before a 'new' row can be applied (enforced in apply + CHECK below).
    quantity:      numeric('quantity', { precision: 10, scale: 2 }),
    // The VISIBLE PURCHASE / unit cost (what the shop pays) — the only cost we carry onto a tracked part.
    // Kept DISTINCT from list/MSRP and the line total, which are metadata only (never used as sell price).
    unitCostCents: integer('unit_cost_cents'),
    listPriceCents: integer('list_price_cents'),   // MSRP / list, metadata only
    lineTotalCents: integer('line_total_cents'),    // line total, metadata only

    // Manager review decision for THIS line: 'new' (create a tracked part), 'link' (attach to an existing
    // tracked part — provenance only, never overwrites its sell/received/billing fields), 'skip' (ignore).
    linkDecision:  varchar('link_decision', { length: 8 }).notNull().default('new'),
    matchedPartId: uuid('matched_part_id').references(() => jobParts.id, { onDelete: 'set null' }),
    // Set when apply creates/links a tracked part for this row (the row→part provenance for the UI).
    appliedPartId: uuid('applied_part_id'),
    notes:         text('notes'),

    createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('part_import_rows_batch_idx').on(t.batchId),
    index('part_import_rows_image_idx').on(t.sourceImageId),
    index('part_import_rows_matched_idx').on(t.matchedPartId),
    check('part_import_rows_decision_chk', sql`link_decision IN ('new','link','skip')`),
    check('part_import_rows_qty_chk', sql`quantity IS NULL OR quantity > 0`),
    check('part_import_rows_cents_chk', sql`(unit_cost_cents IS NULL OR unit_cost_cents >= 0) AND (list_price_cents IS NULL OR list_price_cents >= 0) AND (line_total_cents IS NULL OR line_total_cents >= 0)`),
  ]
)
