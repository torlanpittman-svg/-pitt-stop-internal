import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  varchar,
  integer,
  numeric,
  index,
  unique,
} from 'drizzle-orm/pg-core'

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

    estimateId:         uuid('estimate_id'),
    quotedPriceCents:   integer('quoted_price_cents'),
    approvedPriceCents: integer('approved_price_cents'),

    notes:       text('notes'),
    // Selected service labels for the Work Board card (Quick Entry: standard package
    // names + custom "Other" text). Display-only; null for legacy / non-Quick-Entry orders.
    services:    jsonb('services').$type<string[]>(),
    // Display title for the Work Board card: retail customer name (Quick Entry) or
    // dealer name (Dealer Check-In). Null → card falls back to "Unknown Customer".
    customerName: varchar('customer_name', { length: 200 }),
    checkedInBy: varchar('checked_in_by', { length: 200 }),

    arrivedAt:   timestamp('arrived_at',   { withTimezone: true }),
    startedAt:   timestamp('started_at',   { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }), // true completion (Ready); count-once
    completedBy:  varchar('completed_by', { length: 200 }),
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
    createdBy:              varchar('created_by', { length: 200 }),
    updatedBy:              varchar('updated_by', { length: 200 }),
    createdAt:              timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:              timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // NOTE: a partial UNIQUE index on qb_invoice_id (one QB invoice ↔ one estimate) is
  // created in migration 0019 — enforced in the DB, not modeled here.
  (t) => [unique('job_estimates_order_uniq').on(t.serviceOrderId)],
)

export const jobServices = pgTable(
  'job_services',
  {
    id:            uuid('id').primaryKey().defaultRandom(),
    jobEstimateId: uuid('job_estimate_id').notNull().references(() => jobEstimates.id, { onDelete: 'cascade' }),
    title:         varchar('title', { length: 200 }).notNull(),
    approvalState: varchar('approval_state', { length: 16 }).notNull().default('pending'),
    technician:    varchar('technician', { length: 200 }),
    notes:         text('notes'),
    source:        varchar('source', { length: 24 }).notNull().default('manual'),
    sortOrder:     integer('sort_order').notNull().default(0),
    createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_services_estimate_idx').on(t.jobEstimateId)],
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
