/**
 * Check-writing schema — physical business checks written from a Pitt Stop bank account,
 * recorded in QuickBooks as a Purchase (PaymentType=Check) and printed on the dedicated
 * Brother HL-L2420DW.
 *
 * ADDITIVE ONLY. Read-only toward existing tables. The check record is the durable Pitt Stop OS
 * source of truth that the CFO/expense system will later consume. Money is always cents (integer).
 *
 * Idempotency + failure-state model (see service.ts):
 *   - A physical check number is reserved from `check_sequence` (row-locked ⇒ no duplicate/concurrent
 *     issue) and bound to ONE `checks` row (unique per bank).
 *   - QuickBooks write is guarded by `qbo_txn_id`: once set it is NEVER re-written (no duplicate expense).
 *   - Printing is a SEPARATE event from the QuickBooks write. `print_status` moves independently; a
 *     reprint reuses the SAME row/number/txn and only bumps `reprint_count`.
 *
 * Aggregated by drizzle/schema.ts. DDL lives in drizzle/migrations/manual/0032_checks.sql.
 */
import { pgTable, uuid, varchar, integer, boolean, date, text, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core'

// One row per physical check. A check is never deleted — it is voided (see qbStatus) so the
// number is never silently reused.
export const checks = pgTable(
  'checks',
  {
    id:              uuid('id').primaryKey().defaultRandom(),

    // Physical + bank identity ------------------------------------------------
    checkNumber:     integer('check_number').notNull(),                      // printed on the paper == QBO DocNumber
    bankKey:         varchar('bank_key', { length: 16 }).notNull(),          // operating | auto_sales
    bankQboAccountId:varchar('bank_qbo_account_id', { length: 32 }).notNull(),// QBO Bank Account.Id money is drawn from

    // Payee -------------------------------------------------------------------
    payeeName:       varchar('payee_name', { length: 200 }).notNull(),
    payeeQboVendorId:varchar('payee_qbo_vendor_id', { length: 32 }),          // resolved QBO Vendor.Id (null until recorded)

    // Money + purpose ---------------------------------------------------------
    amountCents:     integer('amount_cents').notNull(),
    memo:            text('memo'),                                            // "What is this for?" — printed + QBO PrivateNote
    category:        varchar('category', { length: 24 }).notNull(),           // business-language category (see types.ts)
    expenseQboAccountId: varchar('expense_qbo_account_id', { length: 32 }).notNull(), // QBO expense Account.Id (mapped from category)

    // Linkage + isolation -----------------------------------------------------
    entity:          varchar('entity', { length: 16 }).notNull().default('operating'), // operating | auto_sales (CFO boundary)
    linkedJobId:     uuid('linked_job_id'),                                   // service_orders.id (Customer Job) — no FK (soft link)
    linkedVehicleId: uuid('linked_vehicle_id'),                               // inventory_vehicles.id (Auto Sales) — soft link

    checkDate:       date('check_date').notNull(),

    // QuickBooks state --------------------------------------------------------
    qboTxnId:        varchar('qbo_txn_id', { length: 32 }),                   // QBO Purchase.Id — set ONCE; guards idempotency
    qboDocNumber:    varchar('qbo_doc_number', { length: 32 }),               // echo of the check number QBO stored
    qboSyncToken:    varchar('qbo_sync_token', { length: 32 }),
    realmId:         varchar('realm_id', { length: 32 }),                     // provenance (which QB company)
    qbStatus:        varchar('qb_status', { length: 16 }).notNull().default('pending'), // pending | recorded | failed | voided
    qbError:         text('qb_error'),

    // Print state (independent of QB) -----------------------------------------
    printStatus:     varchar('print_status', { length: 16 }).notNull().default('not_printed'), // not_printed | printed | print_failed
    printedAt:       timestamp('printed_at', { withTimezone: true }),
    reprintCount:    integer('reprint_count').notNull().default(0),

    // Attribution -------------------------------------------------------------
    idempotencyKey:  varchar('idempotency_key', { length: 64 }).notNull(),    // per-confirm; prevents double-submit
    actorKey:        varchar('actor_key', { length: 40 }),
    actorName:       varchar('actor_name', { length: 120 }),

    createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A check number is unique PER bank account — two checks can never share it. (A voided check keeps
    // its number so it can never be silently reused; uniqueness therefore spans all statuses.)
    unique('checks_bank_number_uniq').on(t.bankKey, t.checkNumber),
    unique('checks_idempotency_uniq').on(t.idempotencyKey),
    index('checks_qbo_txn_idx').on(t.qboTxnId),
    index('checks_created_idx').on(t.createdAt),
  ],
)

// Append-only audit trail per check (created, recorded, printed, print_failed, reprinted, voided …).
export const checkEvents = pgTable(
  'check_events',
  {
    id:        uuid('id').primaryKey().defaultRandom(),
    checkId:   uuid('check_id').notNull().references(() => checks.id, { onDelete: 'cascade' }),
    actor:     varchar('actor', { length: 120 }),
    action:    varchar('action', { length: 40 }).notNull(),
    detail:    jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('check_events_check_idx').on(t.checkId)],
)

// Cloud print QUEUE — decouples Pitt Stop OS (Vercel) from the physical printer. A manager enqueues a
// job from any phone; a permanent, always-on Pitt Stop print BRIDGE (Raspberry Pi / mini PC running the
// scripts/print-bridge.mjs agent, or PrintNode) polls this queue with a bridge token, prints the check
// PDF on the dedicated Brother HL-L2420DW, and reports the result. The MacBook can run the same agent
// TODAY as a temporary bridge — no redesign needed to move it to permanent hardware later.
//
// `payload` is a self-contained snapshot (page size + positioned fields) captured at enqueue time, so the
// printed artifact is deterministic even if layout config later changes. The bridge is intentionally dumb:
// it prints bytes and reports status — it never runs business logic or arbitrary commands.
export const printJobs = pgTable(
  'print_jobs',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    checkId:     uuid('check_id').references(() => checks.id, { onDelete: 'cascade' }),
    kind:        varchar('kind', { length: 16 }).notNull().default('check'),   // check | reprint
    status:      varchar('status', { length: 16 }).notNull().default('queued'),// queued | claimed | printed | failed | canceled
    printerTarget: varchar('printer_target', { length: 120 }),                 // logical/CUPS name (bridge may override)
    payload:     jsonb('payload').notNull(),                                   // { pageWidthIn, pageHeightIn, fields:[…] }
    attempts:    integer('attempts').notNull().default(0),
    claimedBy:   varchar('claimed_by', { length: 120 }),                       // bridge id that claimed it
    claimedAt:   timestamp('claimed_at', { withTimezone: true }),
    printedAt:   timestamp('printed_at', { withTimezone: true }),
    failedAt:    timestamp('failed_at', { withTimezone: true }),
    error:       text('error'),
    createdBy:   varchar('created_by', { length: 120 }),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('print_jobs_status_idx').on(t.status), index('print_jobs_check_idx').on(t.checkId)],
)

// One row per bank's physical check sequence. `nextNumber` is the number of the NEXT blank check in
// the tray. Reserved atomically (UPDATE … RETURNING) so concurrent managers never get the same number.
// A row exists ONLY after the owner initializes the starting number — the system never invents one.
export const checkSequence = pgTable('check_sequence', {
  bankKey:    varchar('bank_key', { length: 16 }).primaryKey(),              // operating | auto_sales
  nextNumber: integer('next_number').notNull(),
  updatedBy:  varchar('updated_by', { length: 120 }),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
