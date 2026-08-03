/**
 * Quick Entry service catalog — database schema.
 * Imported by drizzle/schema.ts.
 *
 * service_catalog        packages / add-ons / placeholders sold as "packages"
 * service_price_tiers    per-size / per-condition starting prices for a catalog item
 * service_aliases        historical QB descriptions grouped under a catalog item (AI needs approval)
 * technician_instructions non-billable tech guidance / condition flags (never invoice lines)
 *
 * V1 rules: every price is editable and fully audited; NO manager-approval gates
 * (role-based permissions come later). Dealer prices come from the Dealer Check-In
 * rules engine, not AI. AutoLeap mapping is pending an API.
 */
import { pgTable, uuid, text, varchar, integer, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core'

export const serviceCatalog = pgTable(
  'service_catalog',
  {
    id:                uuid('id').primaryKey().defaultRandom(),
    slug:              varchar('slug', { length: 80 }).notNull().unique(),
    name:              varchar('name', { length: 120 }).notNull(),
    kind:              varchar('kind', { length: 20 }).notNull(),          // package | addon | placeholder
    quickEntry:        boolean('quick_entry').notNull().default(false),
    hasSize:           boolean('has_size').notNull().default(false),
    hasCondition:      boolean('has_condition').notNull().default(false),
    defaultPriceCents: integer('default_price_cents'),                     // null for tiered / price-TBD
    priceEditable:     boolean('price_editable').notNull().default(true),
    active:            boolean('active').notNull().default(true),
    sortOrder:         integer('sort_order').notNull().default(0),
    source:            varchar('source', { length: 40 }),                 // provenance: seed_v1 | owner | ai | dealer_rules
    requiresNotes:     boolean('requires_notes').notNull().default(false),
    requiresPhoto:     boolean('requires_photo').notNull().default(false),
    qbItemRef:         varchar('qb_item_ref', { length: 40 }),            // existing QB Item Id, or null
    qbItemStatus:      varchar('qb_item_status', { length: 30 }).notNull().default('existing'), // existing | new_create_at_golive | mapping_review
    qbSyncEnabled:     boolean('qb_sync_enabled').notNull().default(true),
    autoleapMapStatus: varchar('autoleap_map_status', { length: 40 }).notNull().default('unmapped_pending_api'),
    reviewFlag:        boolean('review_flag').notNull().default(false),
    notes:             text('notes'),
    archivedAt:        timestamp('archived_at', { withTimezone: true }),  // soft delete
    createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('service_catalog_kind_idx').on(t.kind),
    index('service_catalog_quick_idx').on(t.quickEntry),
    index('service_catalog_active_idx').on(t.active),
  ],
)

export const servicePriceTiers = pgTable(
  'service_price_tiers',
  {
    id:              uuid('id').primaryKey().defaultRandom(),
    catalogId:       uuid('catalog_id').notNull().references(() => serviceCatalog.id, { onDelete: 'cascade' }),
    size:            varchar('size', { length: 40 }).notNull().default(''),      // '' = none
    condition:       varchar('condition', { length: 20 }).notNull().default(''), // '' = none
    startPriceCents: integer('start_price_cents').notNull(),
    sortOrder:       integer('sort_order').notNull().default(0),
  },
  (t) => [
    unique('service_price_tiers_uniq').on(t.catalogId, t.size, t.condition),
    index('service_price_tiers_catalog_idx').on(t.catalogId),
  ],
)

export const serviceAliases = pgTable(
  'service_aliases',
  {
    id:            uuid('id').primaryKey().defaultRandom(),
    catalogId:     uuid('catalog_id').notNull().references(() => serviceCatalog.id, { onDelete: 'cascade' }),
    alias:         text('alias').notNull(),
    source:        varchar('source', { length: 40 }).notNull().default('quickbooks'),
    approvedForAi: boolean('approved_for_ai').notNull().default(false),
    approvedBy:    varchar('approved_by', { length: 120 }),
    approvedAt:    timestamp('approved_at', { withTimezone: true }),
  },
  (t) => [
    unique('service_aliases_uniq').on(t.catalogId, t.alias),
    index('service_aliases_catalog_idx').on(t.catalogId),
    index('service_aliases_ai_idx').on(t.approvedForAi),
  ],
)

export const technicianInstructions = pgTable(
  'technician_instructions',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    slug:       varchar('slug', { length: 80 }).notNull().unique(),
    label:      varchar('label', { length: 160 }).notNull(),
    groupName:  varchar('group_name', { length: 40 }).notNull(),
    billable:   boolean('billable').notNull().default(false),
    sortOrder:  integer('sort_order').notNull().default(0),
    active:     boolean('active').notNull().default(true),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('technician_instructions_group_idx').on(t.groupName)],
)
