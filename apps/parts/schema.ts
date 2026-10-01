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
} from 'drizzle-orm/pg-core'
import { serviceOrders, jobLineItems } from '@/apps/workflow/schema'

// needed → ordered → partially_received → received ; cancelled is terminal.
export const jobParts = pgTable(
  'job_parts',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    serviceOrderId: uuid('service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    // Optional link to the estimate/invoice line this part bills under (prevents double billing).
    jobLineItemId:  uuid('job_line_item_id').references(() => jobLineItems.id, { onDelete: 'set null' }),

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
  ]
)
