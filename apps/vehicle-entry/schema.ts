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
  integer,
  index,
} from 'drizzle-orm/pg-core'

// ── Invoice batches ────────────────────────────────────────────────────────
// Each active batch links one dealership to one QuickBooks invoice.
// Pitt Stop controls whether an invoice can receive new vehicles via
// pittStopStatus — independent of QuickBooks payment state.

export const invoiceBatches = pgTable(
  'invoice_batches',
  {
    id:                      uuid('id').primaryKey().defaultRandom(),
    dealershipId:            uuid('dealership_id').notNull(),
    dealershipName:          varchar('dealership_name', { length: 200 }).notNull(),
    quickbooksCustomerId:    varchar('quickbooks_customer_id', { length: 200 }),
    quickbooksInvoiceId:     varchar('quickbooks_invoice_id', { length: 200 }),
    quickbooksInvoiceNumber: varchar('quickbooks_invoice_number', { length: 100 }),
    // draft | active | finalized | closed | cancelled
    pittStopStatus:  varchar('pitt_stop_status', { length: 20 }).notNull().default('draft'),
    batchStartDate:  timestamp('batch_start_date', { withTimezone: true }).notNull().defaultNow(),
    finalizedDate:   timestamp('finalized_date', { withTimezone: true }),
    closedDate:      timestamp('closed_date', { withTimezone: true }),
    createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('batches_dealership_idx').on(t.dealershipId),
    index('batches_status_idx').on(t.pittStopStatus),
  ]
)

// ── Mock QuickBooks invoices ────────────────────────────────────────────────
// Phase 1 only. Each row is one simulated QB invoice.
// Phase 2 will replace calls to the mock provider with the real QB API.

export const mockQbInvoices = pgTable('mock_qb_invoices', {
  id:            varchar('id', { length: 100 }).primaryKey(),
  customerId:    varchar('customer_id',   { length: 200 }).notNull(),
  customerName:  varchar('customer_name', { length: 200 }).notNull().default(''),
  invoiceNumber: varchar('invoice_number', { length: 100 }).notNull(),
  syncToken:     integer('sync_token').notNull().default(1),
  lines:         jsonb('lines').notNull().default([]),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Dealerships ─────────────────────────────────────────────────────────────

export const dealerships = pgTable('dealerships', {
  id:          uuid('id').primaryKey().defaultRandom(),
  name:        varchar('name',         { length: 200 }).notNull(),
  stockPrefix: varchar('stock_prefix', { length: 10  }).notNull(),
  active:      boolean('active').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Pilot interventions ─────────────────────────────────────────────────────
// Logged manually during a pilot session to track manager involvement.

export const pilotInterventions = pgTable('pilot_interventions', {
  id:        uuid('id').primaryKey().defaultRandom(),
  type:      varchar('type', { length: 50 }).notNull(),  // 'help_requested' | 'manager_touched'
  reason:    text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── OCR prompt re-run results ───────────────────────────────────────────────
// Stores results of re-running saved photos through a new/different prompt
// without touching the employee-confirmed ground truth.

export const ocrPromptResults = pgTable('ocr_prompt_results', {
  id:            uuid('id').primaryKey().defaultRandom(),
  entryId:       uuid('entry_id').notNull(),
  promptVersion: varchar('prompt_version', { length: 50  }).notNull(),
  modelName:     varchar('model_name',     { length: 100 }).notNull(),
  aiYear:        varchar('ai_year',   { length: 4   }),
  aiMake:        varchar('ai_make',   { length: 100 }),
  aiModel:       varchar('ai_model',  { length: 100 }),
  aiColor:       varchar('ai_color',  { length: 100 }),
  aiStockNumber: varchar('ai_stock_number', { length: 100 }),
  confidence:    jsonb('confidence'),
  rawResponse:   jsonb('raw_response'),
  processedAt:   timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ocr_rerun_entry_idx').on(t.entryId),
  index('ocr_rerun_prompt_idx').on(t.promptVersion),
])

export const vehicleEntries = pgTable(
  'vehicle_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    photoUrl:         text('photo_url').notNull(),
    originalPhotoUrl: text('original_photo_url'),

    year:        varchar('year',         { length: 4   }),
    make:        varchar('make',         { length: 100 }),
    model:       varchar('model',        { length: 100 }),
    color:       varchar('color',        { length: 100 }),
    customColor: varchar('custom_color', { length: 100 }),
    stockNumber: varchar('stock_number', { length: 100 }),

    // Stock number dedicated pipeline
    stockNumberCropUrl:      text('stock_number_crop_url'),
    stockNumberAiPrediction: varchar('stock_number_ai_prediction', { length: 100 }),
    stockDebugOverlayUrl:    text('stock_debug_overlay_url'),
    stockDebugData:          jsonb('stock_debug_data'),

    // Per-field confidence scores (0.0–1.0) from the AI provider
    ocrConfidence:   jsonb('ocr_confidence').$type<Record<string, number>>(),
    // Full raw AI response stored for audit and debugging
    rawOcrResponse:  jsonb('raw_ocr_response'),

    // VIN fallback path
    vin:            varchar('vin',             { length: 17  }),
    entryMethod:    varchar('entry_method',    { length: 20  }).notNull().default('key-tag'),
    dealershipId:   uuid('dealership_id'),
    dealershipName: varchar('dealership_name', { length: 200 }),

    // QuickBooks invoice sync
    invoiceBatchId:    uuid('invoice_batch_id'),
    quickbooksLineId:  varchar('quickbooks_line_id', { length: 100 }),
    // synced | pending_invoice_assignment | duplicate_skipped | error
    invoiceSyncStatus: varchar('invoice_sync_status', { length: 50 }),
    invoiceSyncedAt:   timestamp('invoice_synced_at', { withTimezone: true }),
    invoiceSyncError:  text('invoice_sync_error'),

    wasCorrected: boolean('was_corrected').notNull().default(false),

    // Per-field correction flags — set at employee confirmation time
    yearWasCorrected:  boolean('year_was_corrected').notNull().default(false),
    makeWasCorrected:  boolean('make_was_corrected').notNull().default(false),
    modelWasCorrected: boolean('model_was_corrected').notNull().default(false),
    colorWasCorrected: boolean('color_was_corrected').notNull().default(false),
    stockWasCorrected: boolean('stock_was_corrected').notNull().default(false),

    // Stock number normalization tracking
    stockRawOcr:           varchar('stock_raw_ocr',           { length: 100 }),  // raw OCR before rules
    normalizationsApplied: jsonb('normalizations_applied'),                       // NormalizationChange[]
    detectedStockPrefix:   varchar('detected_stock_prefix',   { length: 20  }),  // prefix chars found
    expectedDealerPrefix:  varchar('expected_dealer_prefix',  { length: 20  }),  // from dealership config

    // pending_quickbooks | ready_for_quickbooks | quickbooks_updated | quickbooks_error | needs_review
    status: varchar('status', { length: 50 }).notNull().default('ready_for_quickbooks'),

    quickbooksInvoiceId: varchar('quickbooks_invoice_id', { length: 100 }),

    // Data classification: production | pilot | test
    dataType: varchar('data_type', { length: 20 }).notNull().default('production'),

    // Pilot timing — set at each stage for speed analysis
    photoTakenAt:        timestamp('photo_taken_at',        { withTimezone: true }),
    ocrCompletedAt:      timestamp('ocr_completed_at',      { withTimezone: true }),
    employeeConfirmedAt: timestamp('employee_confirmed_at', { withTimezone: true }),
    isPilotEntry:        boolean('is_pilot_entry').notNull().default(false),

    // OCR training data — original AI predictions, never overwritten by employee corrections
    aiYear:        varchar('ai_year',   { length: 4   }),
    aiMake:        varchar('ai_make',   { length: 100 }),
    aiModel:       varchar('ai_model',  { length: 100 }),
    aiColor:       varchar('ai_color',  { length: 100 }),
    promptVersion: varchar('prompt_version', { length: 50  }),
    modelName:     varchar('model_name',     { length: 100 }),
  },
  (table) => [
    index('entries_status_idx').on(table.status),
    index('entries_created_at_idx').on(table.createdAt),
  ]
)
