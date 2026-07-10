/**
 * Vehicle Entry — database schema.
 * Imported by drizzle/schema.ts (the platform aggregator).
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  varchar,
  index,
} from 'drizzle-orm/pg-core'

export const vehicleEntries = pgTable(
  'vehicle_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    photoUrl: text('photo_url').notNull(),

    year:        varchar('year',         { length: 4   }),
    make:        varchar('make',         { length: 100 }),
    model:       varchar('model',        { length: 100 }),
    color:       varchar('color',        { length: 100 }),
    customColor: varchar('custom_color', { length: 100 }),
    stockNumber: varchar('stock_number', { length: 100 }),

    // Per-field confidence scores (0.0–1.0) from the AI provider
    ocrConfidence:   jsonb('ocr_confidence').$type<Record<string, number>>(),
    // Full raw AI response stored for audit and debugging
    rawOcrResponse:  jsonb('raw_ocr_response'),

    wasCorrected: boolean('was_corrected').notNull().default(false),

    // pending_quickbooks | ready_for_quickbooks | quickbooks_updated | quickbooks_error | needs_review
    status: varchar('status', { length: 50 }).notNull().default('ready_for_quickbooks'),

    quickbooksInvoiceId: varchar('quickbooks_invoice_id', { length: 100 }),
  },
  (table) => [
    index('entries_status_idx').on(table.status),
    index('entries_created_at_idx').on(table.createdAt),
  ]
)
