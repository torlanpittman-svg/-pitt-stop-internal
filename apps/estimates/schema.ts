import { pgTable, uuid, varchar, text, timestamp, jsonb } from 'drizzle-orm/pg-core'
import { serviceOrders } from '@/apps/workflow/schema'

// Separate QB Estimate linkage: never reuse job_estimates.qb_invoice_id.
export const estimateIntakes = pgTable('estimate_intakes', {
  orderId: uuid('order_id').primaryKey().references(() => serviceOrders.id, { onDelete: 'cascade' }),
  qbEstimateId: varchar('qb_estimate_id', { length: 100 }).unique(),
  qbEstimateNumber: varchar('qb_estimate_number', { length: 100 }),
  qbHash: text('qb_hash'),
  sentHash: text('sent_hash'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  // Persist the exact first request before calling QB; retries cannot create a new estimate.
  createBody: jsonb('create_body').$type<Record<string, unknown>>(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
})
