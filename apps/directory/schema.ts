/**
 * Customer directory schema — a real customers + customer_vehicles directory built
 * by importing AutoLeap (primary), QuickBooks (secondary), and Quick Entry history.
 * Reuses the canonical `vehicles` table (apps/workflow/schema.ts). Applied via the
 * manual migration drizzle/migrations/manual/0015_customer_directory.sql.
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
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { vehicles } from '@/apps/workflow/schema'

// Canonical people. One row per real customer or prospect, merged across sources.
export const customers = pgTable(
  'customers',
  {
    id:                    uuid('id').primaryKey().defaultRandom(),
    firstName:             varchar('first_name', { length: 120 }),
    lastName:              varchar('last_name', { length: 120 }),
    displayName:           varchar('display_name', { length: 240 }),
    company:               varchar('company', { length: 240 }),
    phone:                 varchar('phone', { length: 40 }),
    normalizedPhone:       varchar('normalized_phone', { length: 20 }),
    email:                 varchar('email', { length: 240 }),
    normalizedEmail:       varchar('normalized_email', { length: 240 }),
    customerType:          varchar('customer_type', { length: 20 }).notNull().default('retail'), // retail|dealer|business|prospect
    active:                boolean('active').notNull().default(true),
    source:                varchar('source', { length: 20 }).notNull().default('autoleap'),      // autoleap|quickbooks|quick_entry|manual
    sourceKey:             varchar('source_key', { length: 240 }),
    autoleapCustomerId:    varchar('autoleap_customer_id', { length: 120 }),
    quickbooksCustomerId:  varchar('quickbooks_customer_id', { length: 120 }),
    autoleapVehicleCount:  integer('autoleap_vehicle_count'),
    sourceValues:          jsonb('source_values').notNull().default({}),
    createdByImportBatchId: uuid('created_by_import_batch_id'),
    firstSeenAt:           timestamp('first_seen_at', { withTimezone: true }),
    createdAt:             timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:             timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('customers_norm_phone_idx').on(t.normalizedPhone),
    index('customers_norm_email_idx').on(t.normalizedEmail),
    index('customers_source_key_idx').on(t.source, t.sourceKey),
    index('customers_batch_idx').on(t.createdByImportBatchId),
  ]
)

// Customer <-> vehicle links (reuses canonical vehicles).
export const customerVehicles = pgTable(
  'customer_vehicles',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    customerId:   uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    vehicleId:    uuid('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
    relationship: varchar('relationship', { length: 20 }).notNull().default('owner'),
    source:       varchar('source', { length: 20 }).notNull().default('autoleap'),
    createdByImportBatchId: uuid('created_by_import_batch_id'),
    firstSeenAt:  timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt:   timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_vehicles_uniq').on(t.customerId, t.vehicleId),
    index('customer_vehicles_vehicle_idx').on(t.vehicleId),
  ]
)

// One row per import run (dry-run or committed). Idempotency + rollback.
export const customerImportBatches = pgTable('customer_import_batches', {
  id:               uuid('id').primaryKey().defaultRandom(),
  source:           varchar('source', { length: 40 }).notNull(),
  fileName:         text('file_name'),
  fileHash:         varchar('file_hash', { length: 64 }),
  status:           varchar('status', { length: 16 }).notNull().default('dry_run'), // dry_run|committed|rolled_back
  totalRows:        integer('total_rows').notNull().default(0),
  matchedExisting:  integer('matched_existing').notNull().default(0),
  newCustomers:     integer('new_customers').notNull().default(0),
  reviewQueued:     integer('review_queued').notNull().default(0),
  skipped:          integer('skipped').notNull().default(0),
  summary:          jsonb('summary').notNull().default({}),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  committedAt:      timestamp('committed_at', { withTimezone: true }),
  rolledBackAt:     timestamp('rolled_back_at', { withTimezone: true }),
})

// Owner review queue: weak matches, never auto-merged.
export const possibleMatches = pgTable(
  'possible_matches',
  {
    id:                  uuid('id').primaryKey().defaultRandom(),
    importBatchId:       uuid('import_batch_id').references(() => customerImportBatches.id, { onDelete: 'cascade' }),
    source:              varchar('source', { length: 20 }).notNull().default('autoleap'),
    incoming:            jsonb('incoming').notNull(),
    candidateCustomerIds: jsonb('candidate_customer_ids').notNull().default([]),
    matchReason:         varchar('match_reason', { length: 60 }).notNull(),
    score:               numeric('score', { precision: 4, scale: 3 }).notNull().default('0'),
    status:              varchar('status', { length: 20 }).notNull().default('pending'), // pending|merged|rejected|imported_as_new
    resolvedCustomerId:  uuid('resolved_customer_id').references(() => customers.id, { onDelete: 'set null' }),
    resolvedBy:          varchar('resolved_by', { length: 200 }),
    resolvedAt:          timestamp('resolved_at', { withTimezone: true }),
    createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('possible_matches_status_idx').on(t.status),
    index('possible_matches_batch_idx').on(t.importBatchId),
  ]
)
