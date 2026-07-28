/**
 * Dealer Check-In — database schema.
 * Imported by drizzle/schema.ts (the platform aggregator).
 *
 * dealer_scans      one row per tag scan; the working record from scan → approval
 * dealer_scan_events append-only audit trail of every state change on a scan
 *
 * A scan links to a dealership (resolved from stock prefix), to the QB invoice
 * batch its line was appended to, and to the work-board service order created on
 * approval. Nothing is written to QuickBooks or the work board until the scan is
 * approved ("Looks Good").
 */
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core'

export const dealerScans = pgTable(
  'dealer_scans',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    dealershipId: uuid('dealership_id'),

    // Raw scan
    rawBarcode:   varchar('raw_barcode', { length: 100 }),
    vin:          varchar('vin', { length: 17 }),
    vinSource:    varchar('vin_source', { length: 20 }),   // barcode | ocr | manual
    vinConfidence: integer('vin_confidence'),               // 0–100

    // OCR extractions
    stockNumber:     varchar('stock_number', { length: 100 }),
    stockSource:     varchar('stock_source', { length: 20 }), // ocr | manual
    stockConfidence: integer('stock_confidence'),

    year:  varchar('year',  { length: 4 }),
    make:  varchar('make',  { length: 100 }),
    model: varchar('model', { length: 100 }),
    color: varchar('color', { length: 100 }),

    // Tag signals for the new-vehicle pricing prompt
    tagColor:           varchar('tag_color', { length: 20 }),   // yellow | white | unknown
    pricingPromptShown: boolean('pricing_prompt_shown').notNull().default(false),
    rate:               integer('rate'),                        // 200 | 125 | override

    // NHTSA decode
    nhtsaYear:  varchar('nhtsa_year',  { length: 4 }),
    nhtsaMake:  varchar('nhtsa_make',  { length: 100 }),
    nhtsaModel: varchar('nhtsa_model', { length: 100 }),

    photoUrl: text('photo_url'),
    cropUrl:  text('crop_url'),

    // Outcome: pending | approved | duplicate_skipped | error
    status:     varchar('status', { length: 30 }).notNull().default('pending'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: varchar('approved_by', { length: 200 }),

    // QuickBooks linkage
    invoiceBatchId:  uuid('invoice_batch_id'),
    qbLineId:        varchar('qb_line_id', { length: 100 }),
    qbInvoiceNumber: varchar('qb_invoice_number', { length: 100 }),
    qbSyncStatus:    varchar('qb_sync_status', { length: 30 }), // synced | queued | error
    qbSyncError:     text('qb_sync_error'),
    qbSyncedAt:      timestamp('qb_synced_at', { withTimezone: true }),

    // Work board linkage
    serviceOrderId: uuid('service_order_id'),

    // Data classification: production | pilot | test
    dataType: varchar('data_type', { length: 20 }).notNull().default('production'),
  },
  (t) => [
    index('dealer_scans_status_idx').on(t.status),
    index('dealer_scans_dealership_idx').on(t.dealershipId),
    index('dealer_scans_stock_idx').on(t.stockNumber),
    index('dealer_scans_vin_idx').on(t.vin),
    index('dealer_scans_created_idx').on(t.createdAt),
  ]
)

export const dealerScanEvents = pgTable(
  'dealer_scan_events',
  {
    id:        uuid('id').primaryKey().defaultRandom(),
    scanId:    uuid('scan_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // scanned | corrected | pricing_prompted | approved | invoice_status_checked
    // invoice_created | qb_synced | qb_queued | duplicate_detected
    // work_board_created | error
    eventType: varchar('event_type', { length: 50 }).notNull(),
    actor:     varchar('actor', { length: 200 }),
    oldValue:  jsonb('old_value'),
    newValue:  jsonb('new_value'),
    note:      text('note'),
  },
  (t) => [
    index('dealer_scan_events_scan_idx').on(t.scanId),
    index('dealer_scan_events_type_idx').on(t.eventType),
  ]
)
