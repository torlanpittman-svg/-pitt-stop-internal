/**
 * Business Receipts / Expense Capture — schema.
 *
 * ONE row per uploaded business-expense receipt (Pitt Stop Detail AND Auto Sales). This is the GENERAL
 * expense path — a general shop expense needs NO vehicle; an expense tied to an inventory vehicle MAY
 * reference the canonical record via `inventory_vehicle_id` (nullable FK, ON DELETE SET NULL — the link
 * clears rather than cascading a delete).
 *
 * Evidence-preserving + review-driven:
 *   - the ORIGINAL image is stored PRIVATELY (Vercel Blob, deduped by sha-256, immutable — never overwritten)
 *   - `ai_raw` (audit only) and `ai_extracted` (the proposal) are kept separate from the MANAGER-
 *     CONFIRMED operational fields (vendor/date/amounts/category/entity/payment/memo)
 *   - `status` is the current review state; `audit_log` is an append-only JSONB trail of actions
 *   - `qb_*` columns are RESERVED for a future export/sync — this module performs NO live QuickBooks
 *     mutation; qb_sync_status stays 'none'/'export_ready' and is never 'synced' unless truly synced.
 *
 * Applied via drizzle/migrations/manual/0038_business_receipts.sql (additive; new table only).
 */
import { pgTable, uuid, text, varchar, integer, date, timestamp, jsonb, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { inventoryVehicles } from '@/apps/auto-sales/schema'

export const businessReceipts = pgTable(
  'business_receipts',
  {
    id:            uuid('id').primaryKey().defaultRandom(),
    // Review lifecycle: uploaded|processing|needs_review|filed|approved|rejected|processing_failed
    //   filed = employee (or manager) OPERATIONAL filing of a complete receipt (NOT accounting approval).
    //   approved = LEGACY manager approval (preserved). needs_review = the "Needs attention" exception queue.
    status:        varchar('status', { length: 20 }).notNull().default('needs_review'),

    // Classification (operational truth, set at filing by the employee or corrected by a manager). entity
    // defaults 'unassigned' until a business is chosen.
    entity:        varchar('entity', { length: 20 }).notNull().default('unassigned'),
    category:      varchar('category', { length: 40 }).notNull().default('uncategorized'),
    vendor:        varchar('vendor', { length: 200 }),
    receiptDate:   date('receipt_date'),                       // business date on the receipt (no tz drift)
    subtotalCents: integer('subtotal_cents'),
    taxCents:      integer('tax_cents'),
    totalCents:    integer('total_cents'),
    paymentMethod: varchar('payment_method', { length: 20 }),  // cash|card|check|ach|other|unknown (INSTRUMENT)
    paymentLast4:  varchar('payment_last4', { length: 4 }),
    accountRef:    varchar('account_ref', { length: 40 }),     // which bank/card (allowlist ref)
    // Funding source (WHO paid / WHETHER paid) — SEPARATE from the payment instrument so reporting can
    // honestly split business cash outflow from a personal reimbursement owed and an unpaid purchase.
    // business|personal|unpaid|unknown. Never inferred into a real bank/card account or a payable.
    funding:       varchar('funding', { length: 16 }).notNull().default('unknown'),
    memo:          text('memo'),
    // The employee's optional short explanation captured at filing time (e.g. for "Other / Not sure" or a
    // personal-money note). Kept distinct from `memo` so a later manager note never rewrites their words.
    filingNote:    text('filing_note'),
    // Why this receipt is in the "Needs attention" queue — an array of ATTENTION_REASONS keys ([] when a
    // clean filing). Set at filing; explains the queue. Not a substitute for the append-only audit_log.
    attentionReasons: jsonb('attention_reasons').notNull().default('[]'),

    // Optional canonical inventory-vehicle association (general expenses leave this null). Additive FK
    // with ON DELETE SET NULL: an expense may reference an inventory vehicle, but deleting/merging a
    // vehicle must NOT delete the receipt — the link simply clears. App-level validation (db.
    // inventoryVehicleExists) rejects a nonexistent id at review/approve time as well.
    inventoryVehicleId: uuid('inventory_vehicle_id').references(() => inventoryVehicles.id, { onDelete: 'set null' }),

    // Original evidence (preserved; deduped by hash; never overwritten).
    storage:       varchar('storage', { length: 16 }).notNull().default('blob_public'), // blob_public|blob_private|none
    storageRef:    text('storage_ref'),
    filename:      varchar('filename', { length: 300 }),
    contentType:   varchar('content_type', { length: 60 }),
    imageHash:     varchar('image_hash', { length: 64 }),      // sha-256, dedup
    byteSize:      integer('byte_size'),

    // AI proposal (unverified). ai_raw is audit-only; ai_extracted is the normalized proposal; confidence
    // holds the per-field presence/uncertainty signal.
    aiStatus:      varchar('ai_status', { length: 16 }).notNull().default('pending'), // pending|extracted|failed|skipped
    aiModel:       varchar('ai_model', { length: 60 }),
    aiRaw:         jsonb('ai_raw'),
    aiExtracted:   jsonb('ai_extracted'),
    confidence:    jsonb('confidence'),

    // Review + approval attribution (real manager identity, server-verified at the action layer).
    reviewedBy:    varchar('reviewed_by', { length: 200 }),
    reviewedAt:    timestamp('reviewed_at', { withTimezone: true }),
    approvedBy:    varchar('approved_by', { length: 200 }),
    approvedAt:    timestamp('approved_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),

    // Operational-filing attribution — the ACTUAL person who completed the filing (an employee for their
    // own receipt, or a manager resolving an exception). Distinct from approvedBy so an employee filing is
    // never misattributed as a manager approval. filedByKey is the server-verified identity key (null for a
    // shared-PIN device — we never invent an individual for a shared session).
    filedBy:       varchar('filed_by', { length: 200 }),
    filedByKey:    varchar('filed_by_key', { length: 60 }),
    filedAt:       timestamp('filed_at', { withTimezone: true }),

    // Append-only audit trail (array of { action, actor, at, changes?, note? }). Never rewritten.
    auditLog:      jsonb('audit_log').notNull().default('[]'),

    uploadedBy:    varchar('uploaded_by', { length: 200 }),
    // Server-verified identity key of the uploader (a named individual), or null for a shared-PIN device.
    // Powers ownership: an employee may finalize ONLY a receipt they uploaded (key match) — one of the
    // authorized paths alongside a signed capture token and the manager role.
    uploadedByKey: varchar('uploaded_by_key', { length: 60 }),

    // Extraction-attempt ownership token. Set on a retry claim (status='processing'); a completion or
    // failure-release only takes effect while the CURRENT token still matches — so a stale/expired attempt
    // that finishes late can never overwrite a newer attempt's state or a manager's correction.
    processingToken: varchar('processing_token', { length: 40 }),

    // RESERVED for a future accountant export / QuickBooks sync. No live mutation happens here.
    qbSyncStatus:  varchar('qb_sync_status', { length: 16 }).notNull().default('none'), // none|export_ready|synced
    qbEntityRef:   varchar('qb_entity_ref', { length: 60 }),
    qbSyncedAt:    timestamp('qb_synced_at', { withTimezone: true }),

    createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('business_receipts_status_idx').on(t.status),
    index('business_receipts_hash_idx').on(t.imageHash),
    index('business_receipts_entity_idx').on(t.entity),
    index('business_receipts_date_idx').on(t.receiptDate),
    index('business_receipts_vehicle_idx').on(t.inventoryVehicleId),
    index('business_receipts_funding_idx').on(t.funding),
    index('business_receipts_uploader_key_idx').on(t.uploadedByKey),
    // DB-enforced upload idempotency: one active (non-rejected) row per content hash → concurrent
    // identical uploads collapse to one receipt (no duplicate expense). Migration 0039.
    uniqueIndex('business_receipts_hash_active_uniq').on(t.imageHash).where(sql`status <> 'rejected'`),
  ]
)

// Durable, server-enforced rate limiting (cross-instance). ATOMIC fixed-window COUNTER: one row per
// (bucket, window_start); a single INSERT … ON CONFLICT DO UPDATE … WHERE count < limit both increments
// and enforces the cap in ONE statement (the ON CONFLICT row lock serializes concurrent independent
// connections — no separate count/insert race). Bucketed by the SERVER-VERIFIED actor (not a forwarded
// header alone). Distinct from the per-receipt extraction lock. Migration 0040.
export const expenseRateCounters = pgTable(
  'expense_rate_counters',
  {
    bucket:      varchar('bucket', { length: 120 }).notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count:       integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
)
