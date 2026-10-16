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
  numeric,
  index,
  uniqueIndex,
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
  ]
)
