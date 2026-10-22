import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  varchar,
  integer,
  numeric,
  index,
  unique,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const employees = pgTable('employees', {
  id:        uuid('id').primaryKey().defaultRandom(),
  name:      varchar('name', { length: 200 }).notNull(),
  role:      varchar('role', { length: 20 }).notNull().default('employee'), // employee | manager | admin
  pinHash:   varchar('pin_hash', { length: 120 }),                          // scrypt; only managers/admins
  active:    boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const locations = pgTable('locations', {
  id:       uuid('id').primaryKey().defaultRandom(),
  name:     varchar('name', { length: 200 }).notNull(),
  timezone: varchar('timezone', { length: 50 }).notNull().default('America/New_York'),
  active:   boolean('active').notNull().default(true),
})

export const vehicles = pgTable(
  'vehicles',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    vin:          varchar('vin', { length: 17 }),
    year:         varchar('year', { length: 4 }),
    make:         varchar('make', { length: 100 }),
    model:        varchar('model', { length: 100 }),
    color:        varchar('color', { length: 100 }),
    licensePlate: varchar('license_plate', { length: 20 }),
    bodyClass:    varchar('body_class', { length: 100 }),
    vinRaw:       jsonb('vin_raw'),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vehicles_vin_idx').on(t.vin)]
)

// Status values:
// arrived → in_progress ↔ paused → drying → qc_ready → ready → delivered | cancelled
export const serviceOrders = pgTable(
  'service_orders',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    orderNumber: varchar('order_number', { length: 20 }).notNull().unique(),
    locationId:  uuid('location_id').references(() => locations.id),
    vehicleId:   uuid('vehicle_id').notNull().references(() => vehicles.id),

    source:       varchar('source',       { length: 30 }).notNull().default('walk_in'),
    serviceType:  varchar('service_type', { length: 30 }),
    serviceFocus: varchar('service_focus', { length: 50 }),

    status: varchar('status', { length: 30 }).notNull().default('arrived'),

    // Operational urgency (independent of source/status). false = Normal, true = Urgent ("needs back
    // ASAP"). Visual/sort priority only — never changes status/pricing/production/QB.
    isUrgent: boolean('is_urgent').notNull().default(false),

    estimateId:         uuid('estimate_id'),
    quotedPriceCents:   integer('quoted_price_cents'),
    approvedPriceCents: integer('approved_price_cents'),

    notes:       text('notes'),
    // Canonical customer directory link (apps/directory `customers.id`), set GOING FORWARD
    // when a repair order is started from a customer profile. The actual FK is declared in
    // migration 0043 (SQL only) to avoid a circular schema import with apps/directory. This
    // is the person who AUTHORIZED the repair — which may differ from a vehicle's current
    // owner (customer_vehicles). Null for legacy rows; matched by vehicle/phone/email at read.
    customerId:  uuid('customer_id'),
    // Selected service labels for the Work Board card (Quick Entry: standard package
    // names + custom "Other" text). Display-only; null for legacy / non-Quick-Entry orders.
    services:    jsonb('services').$type<string[]>(),
    // Display title for the Work Board card: retail customer name (Quick Entry) or
    // dealer name (Dealer Check-In). Null → card falls back to "Unknown Customer".
    customerName: varchar('customer_name', { length: 200 }),
    checkedInBy: varchar('checked_in_by', { length: 200 }),

    // ── Occasional third-party billing (migration 0049) ──────────────────────────────────────
    // When someone OTHER than the service customer pays (a company covering a resident's repair, a
    // body shop account, etc.). All NULL for ordinary jobs → bill the service customer as today.
    // These NEVER change vehicle ownership (customer_vehicles) or whose history this is (customerId).
    // Canonical directory customer to BILL (the payer). FK declared in migration 0049 (SQL only) to
    // avoid a circular schema import with apps/directory. Null → bill the service customer.
    billingCustomerId: uuid('billing_customer_id'),
    // Address the QB invoice is SENT to (Invoice.BillEmail only — never written onto the billing
    // customer record, so a company's main email is never overwritten by a specific advisor).
    invoiceRecipientEmail: varchar('invoice_recipient_email', { length: 240 }),
    // The specific person who brought the vehicle in on behalf of the payer (service advisor), for
    // THIS order only. Display/record; does not change identity matching.
    jobContactName: varchar('job_contact_name', { length: 200 }),

    arrivedAt:   timestamp('arrived_at',   { withTimezone: true }),
    startedAt:   timestamp('started_at',   { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }), // true completion (Ready); count-once
    completedBy:  varchar('completed_by', { length: 200 }),
    // Daily Production day override (manager correction). A bare shop-calendar date; when set,
    // the Job counts/shows on THIS day instead of the day derived from completed_at — WITHOUT
    // touching completed_at (the truthful "when Finish Job was submitted"). null = use completed_at.
    productionDateOverride: date('production_date_override'),
    completionChecklist: jsonb('completion_checklist').$type<Record<string, unknown>>(),
    qcRequired:  boolean('qc_required').notNull().default(false),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('service_orders_status_idx').on(t.status),
    index('service_orders_vehicle_idx').on(t.vehicleId),
    index('service_orders_created_idx').on(t.createdAt),
    index('service_orders_customer_idx').on(t.customerId),
  ]
)

// One row per tech work session — null stoppedAt = currently active
export const serviceOrderAssignments = pgTable(
  'service_order_assignments',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    serviceOrderId: uuid('service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    employeeName:   varchar('employee_name', { length: 200 }).notNull(),
    startedAt:      timestamp('started_at', { withTimezone: true }).notNull(),
    stoppedAt:      timestamp('stopped_at', { withTimezone: true }),
  },
  (t) => [index('assignments_order_idx').on(t.serviceOrderId)]
)

// Append-only audit trail — never update or delete rows
export const serviceOrderEvents = pgTable(
  'service_order_events',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    serviceOrderId: uuid('service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    eventType:      varchar('event_type', { length: 50 }).notNull(),
    employeeName:   varchar('employee_name', { length: 200 }),
    oldStatus:      varchar('old_status', { length: 30 }),
    newStatus:      varchar('new_status', { length: 30 }),
    note:           text('note'),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_order_idx').on(t.serviceOrderId)]
)

// ── Phase 3: optional Job Estimate layer (manager-only) ─────────────────────
export const jobEstimates = pgTable(
  'job_estimates',
  {
    id:                     uuid('id').primaryKey().defaultRandom(),
    serviceOrderId:         uuid('service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    status:                 varchar('status', { length: 24 }).notNull().default('draft'),
    taxRateBps:             integer('tax_rate_bps').notNull().default(825),
    taxableSubtotalCents:   integer('taxable_subtotal_cents').notNull().default(0),
    nontaxableSubtotalCents:integer('nontaxable_subtotal_cents').notNull().default(0),
    discountCents:          integer('discount_cents').notNull().default(0),
    taxCents:               integer('tax_cents').notNull().default(0),
    totalCents:             integer('total_cents').notNull().default(0),
    needsTaxReview:         boolean('needs_tax_review').notNull().default(false),
    // P-B commercial-layer fields (additive). Defaults preserve today's behavior:
    // 'itemized' + unpriced. A manager sets these later (P-B2+); the fee engine reads
    // them only when price_mode is not 'itemized'.
    priceMode:              varchar('price_mode', { length: 20 }).notNull().default('itemized'), // itemized|explicit_pretax|out_the_door
    explicitTotalCents:     integer('explicit_total_cents'),
    explicitTaxCategory:    varchar('explicit_tax_category', { length: 30 }).notNull().default('review'),
    waiveShopSupplies:      boolean('waive_shop_supplies').notNull().default(false),
    waiveCardFee:           boolean('waive_card_fee').notNull().default(false),
    taxExempt:              boolean('tax_exempt').notNull().default(false),
    pricingSetBy:           varchar('pricing_set_by', { length: 200 }),
    pricingSetAt:           timestamp('pricing_set_at', { withTimezone: true }),
    // Employee-set EXPECTED/operational Job value at intake (pre-fee/pre-tax). SEPARATE from the
    // manager-authoritative explicit_total_cents/invoice: this drives the Production number when no
    // manager price exists, but never the customer invoice. agreed_meta keeps the per-service audit
    // (employee text, matched historical family, suggested price + sample size, confirmed price).
    agreedPriceCents:       integer('agreed_price_cents'),
    agreedMeta:             jsonb('agreed_meta'),
    customerNotes:          text('customer_notes'),
    internalNotes:          text('internal_notes'),
    sentAt:                 timestamp('sent_at', { withTimezone: true }),
    decidedAt:              timestamp('decided_at', { withTimezone: true }),
    convertedAt:            timestamp('converted_at', { withTimezone: true }),
    // P-D3.0 retail QuickBooks linkage (additive; all nullable). Populated only when a
    // manager creates a retail QB invoice from the Invoice Draft (P-D3.3+). Until then
    // qb_status='none' and this Job has no QB invoice. These fields are the idempotency
    // anchor: once qb_invoice_id is set, Create can never make a second invoice.
    // NOTE: dealer QuickBooks invoicing does NOT use these (dealer state lives on
    // dealer_scans.qb_*) — retail and dealer stay isolated.
    qbInvoiceId:            varchar('qb_invoice_id', { length: 100 }),      // QBO Invoice.Id
    qbInvoiceNumber:        varchar('qb_invoice_number', { length: 100 }),  // QBO DocNumber
    qbSyncToken:            varchar('qb_sync_token', { length: 50 }),       // for safe read-modify-write
    qbStatus:               varchar('qb_status', { length: 20 }).notNull().default('none'), // none|creating|created|sent|error
    qbContentHash:          varchar('qb_content_hash', { length: 64 }),     // draft fingerprint → detect drift for Sync
    qbSyncedAt:             timestamp('qb_synced_at', { withTimezone: true }),
    qbSentAt:               timestamp('qb_sent_at', { withTimezone: true }),
    qbSyncError:            text('qb_sync_error'),
    qbLastRequestId:        varchar('qb_last_request_id', { length: 80 }),  // client idempotency correlation
    // Retail Record Payment (migration 0059). SEPARATE from qb_status (invoice create/send) and from the
    // paid-invoice email below, so an email failure can never make a paid invoice look unpaid.
    // qb_payment_status: none|recording|recorded|paid|uncertain|error|review. `paid` is set ONLY after QuickBooks
    // reports a zero balance; `recorded` = the latest installment is confirmed and a balance remains. qb_payment_request_id = the attempt id (QBO requestid + PSPAY tag) reused on
    // an uncertain retry so QuickBooks itself de-duplicates. History lives in service_order_events.
    qbPaymentStatus:        varchar('qb_payment_status', { length: 20 }).notNull().default('none'),
    qbPaymentId:            varchar('qb_payment_id', { length: 100 }),
    qbPaymentMethod:        varchar('qb_payment_method', { length: 20 }),     // cash|card_terminal|check|online|other
    qbPaymentAmountCents:   integer('qb_payment_amount_cents'),
    qbPaymentRequestId:     varchar('qb_payment_request_id', { length: 80 }),
    qbPaymentError:         text('qb_payment_error'),
    qbPaymentStartedAt:     timestamp('qb_payment_started_at', { withTimezone: true }),
    // Cash / Check: THIS attempt removed the card-payment charge (waive_card_fee) so the same invoice could be
    // synced to the cash total before paying. Lets an interrupted attempt be resumed (re-sync, then pay) and a
    // definitely-failed one undone. Reset when a new attempt starts.
    qbPaymentCardFeeRemoved: boolean('qb_payment_card_fee_removed').notNull().default(false),
    qbPaidAt:               timestamp('qb_paid_at', { withTimezone: true }),
    qbPaidBy:               varchar('qb_paid_by', { length: 200 }),
    // Installments (migration 0061). qb_payment_status above is the LATEST ATTEMPT (adds 'recorded' = that
    // installment is confirmed and a balance remains); these cache the invoice's QuickBooks-confirmed AGGREGATE
    // from the last read: unpaid|partial|paid (null = never read). Display + invoice lock only — QuickBooks
    // stays the money authority and per-payment history is read from it (audit in service_order_events).
    qbPaymentBalanceState:  varchar('qb_payment_balance_state', { length: 20 }),
    qbPaymentTotalCents:    integer('qb_payment_total_cents'),
    qbPaymentBalanceCents:  integer('qb_payment_balance_cents'),
    qbPaymentReceivedCents: integer('qb_payment_received_cents'),
    qbPaymentCreditCents:   integer('qb_payment_credit_cents'),
    qbPaymentCheckedAt:     timestamp('qb_payment_checked_at', { withTimezone: true }),
    // "Email Paid Invoice": none|sending|sent|uncertain|error (independent of qb_status='sent').
    qbPaidEmailStatus:      varchar('qb_paid_email_status', { length: 20 }).notNull().default('none'),
    qbPaidEmailTo:          varchar('qb_paid_email_to', { length: 320 }),
    qbPaidEmailStartedAt:   timestamp('qb_paid_email_started_at', { withTimezone: true }),
    qbPaidEmailSentAt:      timestamp('qb_paid_email_sent_at', { withTimezone: true }),
    qbPaidEmailError:       text('qb_paid_email_error'),
    qbPaidEmailPriorDeliveryAt: timestamp('qb_paid_email_prior_delivery_at', { withTimezone: true }),
    // Shared retail invoice (migration 0062). Fingerprint of the QuickBooks line set Pitt Stop last wrote or
    // verified on this (anchor) invoice — a shared-invoice update refuses when QuickBooks' lines no longer match
    // it (someone edited the invoice in QuickBooks), so unrelated lines are never overwritten.
    qbLinesFingerprint:     varchar('qb_lines_fingerprint', { length: 64 }),
    createdBy:              varchar('created_by', { length: 200 }),
    updatedBy:              varchar('updated_by', { length: 200 }),
    createdAt:              timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:              timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // NOTE: a partial UNIQUE index on qb_invoice_id (one QB invoice ↔ one estimate) is
  // created in migration 0019 — enforced in the DB, not modeled here.
  (t) => [unique('job_estimates_order_uniq').on(t.serviceOrderId)],
)

/**
 * Shared retail invoice membership (migration 0062). One QuickBooks invoice billing several retail Jobs for the
 * same customer. The ANCHOR Job keeps owning the invoice exactly as before (job_estimates.qb_invoice_id + its
 * PSID + the one-invoice-per-estimate unique index); every other Job on it is a MEMBER row here. A member's own
 * job_estimates row never gets a qb_invoice_id — its qb_status is 'linked', which the Create compare-and-set
 * refuses, so a member can never also get a standalone invoice.
 *   state: pending (linked, charges not on the QuickBooks invoice yet) → applied (charges written by a reviewed
 *          update) | removed (unlinked before its charges were applied — row kept for history).
 * The audit trail is service_order_events on BOTH Jobs; this table is current state, not a ledger.
 */
export const retailInvoiceMembers = pgTable(
  'retail_invoice_members',
  {
    id:                   uuid('id').primaryKey().defaultRandom(),
    anchorEstimateId:     uuid('anchor_estimate_id').notNull().references(() => jobEstimates.id, { onDelete: 'cascade' }),
    anchorServiceOrderId: uuid('anchor_service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    memberEstimateId:     uuid('member_estimate_id').notNull().references(() => jobEstimates.id, { onDelete: 'cascade' }),
    memberServiceOrderId: uuid('member_service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    qbInvoiceId:          varchar('qb_invoice_id', { length: 100 }).notNull(),
    qbInvoiceNumber:      varchar('qb_invoice_number', { length: 100 }),
    state:                varchar('state', { length: 20 }).notNull().default('pending'), // pending | applied | removed
    linkRequestId:        varchar('link_request_id', { length: 80 }),
    linkedBy:             varchar('linked_by', { length: 200 }),
    linkedAt:             timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt:            timestamp('applied_at', { withTimezone: true }),
    appliedBy:            varchar('applied_by', { length: 200 }),
    appliedTotalCents:    integer('applied_total_cents'),   // this Job's total as last written onto the invoice
    removedAt:            timestamp('removed_at', { withTimezone: true }),
    removedBy:            varchar('removed_by', { length: 200 }),
    removedReason:        text('removed_reason'),
    createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:            timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A Job belongs to at most ONE shared invoice at a time (the DB backstop for double-taps / races).
    uniqueIndex('rim_member_active_uniq').on(t.memberEstimateId).where(sql`state <> 'removed'`),
    index('rim_anchor_active_idx').on(t.anchorEstimateId).where(sql`state <> 'removed'`),
    index('rim_member_estimate_idx').on(t.memberEstimateId),
    index('rim_anchor_estimate_idx').on(t.anchorEstimateId),
    index('rim_member_order_idx').on(t.memberServiceOrderId),
    index('rim_anchor_order_idx').on(t.anchorServiceOrderId),
    check('rim_not_self', sql`anchor_estimate_id <> member_estimate_id`),
    check('rim_state_valid', sql`state IN ('pending', 'applied', 'removed')`),
  ],
)

export const jobServices = pgTable(
  'job_services',
  {
    id:            uuid('id').primaryKey().defaultRandom(),
    jobEstimateId: uuid('job_estimate_id').notNull().references(() => jobEstimates.id, { onDelete: 'cascade' }),
    title:         varchar('title', { length: 200 }).notNull(),
    // STABLE catalog identity (apps/quick-entry service_catalog.id), separate from the editable
    // `title` label. Stamped at insert/rename by the catalog-identity matcher so a QuickBooks
    // invoice line keeps its correct Product/Service item + canonical qb_description even after a
    // manager edits the label (e.g. "Full Detail" → "Full Detail - customer vehicle"). Null for
    // genuinely custom one-off services (generic Labor fallback) and legacy rows pending backfill.
    // The FK is declared in migration 0051 (SQL only) to avoid a circular schema import with
    // apps/quick-entry — same pattern as serviceOrders.customerId. It is ON DELETE RESTRICT: the
    // catalog is soft-deleted (archived_at), never hard-deleted, so historical identity links are
    // retained rather than silently nulled (a null would re-enable label-based remapping). The
    // index needs no cross-module reference, so it is modeled here.
    catalogId:     uuid('catalog_id'),
    // 'service' (work) | 'part' (a special-order part line; procurement detail lives in job_parts).
    kind:          varchar('kind', { length: 12 }).notNull().default('service'),
    // Job-specific detail kept SEPARATE from the title and the catalog identity ("passenger seat",
    // "driver-side mirror"). Appended to the canonical QB description in one approved format
    // (apps/quickbooks/retail-format.ts composeLineDescription) — never free-form invoice text.
    detail:        varchar('detail', { length: 160 }),
    // How the catalog identity was chosen: exact | alias | suggestion | shortcut | custom | legacy.
    matchMethod:   varchar('match_method', { length: 16 }),
    matchedBy:     varchar('matched_by', { length: 200 }),
    matchedAt:     timestamp('matched_at', { withTimezone: true }),
    // Set when a manager explicitly keeps this line alongside a package that already includes it.
    overlapAckBy:  varchar('overlap_ack_by', { length: 200 }),
    overlapAckAt:  timestamp('overlap_ack_at', { withTimezone: true }),
    // The employee's original wording (traceability only; never sent to QuickBooks).
    entryText:     varchar('entry_text', { length: 300 }),
    // Canonical description captured when the catalog identity was chosen → later catalog edits apply
    // to FUTURE additions only. Null on legacy rows = resolve the catalog's current description.
    catalogDescription: text('catalog_description'),
    approvalState: varchar('approval_state', { length: 16 }).notNull().default('pending'),
    technician:    varchar('technician', { length: 200 }),
    notes:         text('notes'),
    source:        varchar('source', { length: 24 }).notNull().default('manual'),
    sortOrder:     integer('sort_order').notNull().default(0),
    createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_services_estimate_idx').on(t.jobEstimateId),
    index('job_services_catalog_idx').on(t.catalogId),
  ],
)

export const jobLineItems = pgTable(
  'job_line_items',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    jobServiceId: uuid('job_service_id').notNull().references(() => jobServices.id, { onDelete: 'cascade' }),
    type:         varchar('type', { length: 12 }).notNull(),            // labor|part|fee|sublet
    name:         varchar('name', { length: 200 }).notNull(),
    description:  text('description'),
    qty:          numeric('qty', { precision: 10, scale: 2 }).notNull().default('1'),
    unit:         varchar('unit', { length: 12 }).notNull().default('each'),
    costCents:    integer('cost_cents').notNull().default(0),
    priceCents:   integer('price_cents').notNull().default(0),
    taxable:      boolean('taxable').notNull().default(false),
    taxCategory:  varchar('tax_category', { length: 30 }).notNull().default('other'),
    sortOrder:    integer('sort_order').notNull().default(0),
    // Generated fee identity (P-A). `generated`=true fee lines are owned by the fee
    // engine and reconciled in place by fee_code; never hand-edited or duplicated.
    generated:    boolean('generated').notNull().default(false),
    feeCode:      varchar('fee_code', { length: 40 }),                 // 'shop_supplies' | 'card_fee'
    partNumber:   varchar('part_number', { length: 80 }),
    brand:        varchar('brand', { length: 80 }),
    supplier:     varchar('supplier', { length: 120 }),
    provider:     varchar('provider', { length: 40 }),
    providerRef:  varchar('provider_ref', { length: 120 }),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_line_items_service_idx').on(t.jobServiceId)],
)
