/**
 * Auto-Sales Vehicle Financial System — B0 schema (Canonical Inventory + Basic Ledger).
 *
 * ONE canonical vehicle: inventory_vehicles is 1:1 with the existing `vehicles` table
 * (apps/workflow/schema.ts) — we NEVER create a parallel vehicle identity. VIN is the canonical
 * identity; PS-{VIN suffix} is the human operational stock number.
 *
 * vehicle_financial_events is an APPEND-ONLY factual ledger. It deliberately separates THREE
 * concepts and never collapses them (corrections are new adjustment/reversal rows, never edits):
 *   - economic_category   : what economically happened (acquisition, part, recon, sale, …)
 *   - cashflow_category   : how cash behaved (outflow, inflow, financing, non_cash, pending, …)
 *   - accounting_treatment: how the accountant should book it — defaults 'unknown_confirm'; set
 *                           later by a separate treatment layer (B6). NO accounting policy is
 *                           hard-coded into the factual ledger.
 *
 * Applied via drizzle/migrations/manual/0029_auto_sales_b0.sql (additive; references vehicles,
 * modifies no existing table). Registered in the drizzle aggregator for type integration.
 */
import { pgTable, uuid, text, varchar, integer, boolean, date, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { vehicles } from '@/apps/workflow/schema'

// One owned-inventory record per canonical vehicle (specific identification). 1:1 with vehicles.
export const inventoryVehicles = pgTable(
  'inventory_vehicles',
  {
    id:            uuid('id').primaryKey().defaultRandom(),
    vehicleId:     uuid('vehicle_id').notNull().references(() => vehicles.id),  // canonical identity (VIN/YMMC)
    stockNumber:   varchar('stock_number', { length: 40 }),                    // PS-{VIN suffix}; null until identity resolved
    segment:       varchar('segment', { length: 20 }).notNull().default('auto_sales'),

    // Lifecycle: sourcing → acquired → in_recon → listed → sale_pending → sold → delivered (+ wholesaled, unwound)
    status:        varchar('status', { length: 20 }).notNull().default('acquired'),

    // Acquisition facts
    acquisitionSource: varchar('acquisition_source', { length: 40 }),          // auction | trade_in | private | dealer | other
    seller:            varchar('seller', { length: 200 }),
    titleStatus:       varchar('title_status', { length: 40 }),
    acquiredAt:        date('acquired_at'),
    listedPriceCents:  integer('listed_price_cents'),

    // Disposition facts (B1)
    disposition:   varchar('disposition', { length: 20 }),                     // retail | wholesale | unwound
    soldAt:        date('sold_at'),
    deliveredAt:   date('delivered_at'),

    // Go-forward cutover + completeness (facts-first; historical uncertainty stays visible)
    origin:        varchar('origin', { length: 24 }).notNull().default('quick_entry'), // quick_entry | spreadsheet_backfill | trade_in
    preCutover:    boolean('pre_cutover').notNull().default(false),
    trackingStartDate: date('tracking_start_date'),
    // complete | partially_reconstructed | historical_incomplete | needs_review
    financialCompleteness: varchar('financial_completeness', { length: 30 }).notNull().default('needs_review'),

    notes:         text('notes'),
    createdBy:     varchar('created_by', { length: 200 }),
    createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inventory_vehicles_vehicle_uniq').on(t.vehicleId),           // 1:1 with canonical vehicle
    uniqueIndex('inventory_vehicles_stock_uniq').on(t.stockNumber),           // owned-inventory stock# uniqueness
    index('inventory_vehicles_status_idx').on(t.status),
    index('inventory_vehicles_completeness_idx').on(t.financialCompleteness),
  ]
)

// Append-only factual money ledger for a specific vehicle. Never updated/deleted; corrections are
// new events (economic_category='adjustment') or reversals (reverses_event_id set).
export const vehicleFinancialEvents = pgTable(
  'vehicle_financial_events',
  {
    id:                 uuid('id').primaryKey().defaultRandom(),
    inventoryVehicleId: uuid('inventory_vehicle_id').notNull().references(() => inventoryVehicles.id),

    // ── Three separate axes (never collapsed) ──
    economicCategory:   varchar('economic_category', { length: 30 }).notNull(),   // see apps/auto-sales/types.ts ECONOMIC
    cashflowCategory:   varchar('cashflow_category', { length: 24 }).notNull(),    // see CASHFLOW
    accountingTreatment:varchar('accounting_treatment', { length: 30 }).notNull().default('unknown_confirm'), // set later (B6)

    amountCents:        integer('amount_cents').notNull(),                          // always positive; direction implied by categories
    eventDate:          date('event_date').notNull(),
    vendor:             varchar('vendor', { length: 200 }),
    memo:               text('memo'),

    // Cash source (in-scope account) — SEPARATE from economic attribution (which is this vehicle).
    // Free-form ref for B0 (e.g. '*2649','*5600','amex','unknown'); B3 links fin_transactions + allocations.
    paymentAccountRef:  varchar('payment_account_ref', { length: 40 }),
    finTransactionId:   uuid('fin_transaction_id'),                                // nullable; wired in B3 (no FK yet to keep finance decoupled)

    // Append/reversal linkage (returns/refunds/trades/corrections)
    originalEventId:    uuid('original_event_id'),                                 // return/refund → the original expense
    reversesEventId:    uuid('reverses_event_id'),                                 // reversal → the voided event
    relatedEventId:     uuid('related_event_id'),                                  // trade pairing / general link

    status:             varchar('status', { length: 16 }).notNull().default('verified'), // proposed|unverified|verified|reconciled|void
    confidence:         varchar('confidence', { length: 16 }).notNull().default('manual'),
    source:             varchar('source', { length: 20 }).notNull().default('manual'),    // manual|receipt_ai|import|plaid_match
    documentId:         uuid('document_id'),                                       // nullable; vehicle_documents added in B2
    evidence:           jsonb('evidence'),
    createdBy:          varchar('created_by', { length: 200 }),
    createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vfe_vehicle_idx').on(t.inventoryVehicleId),
    index('vfe_date_idx').on(t.eventDate),
    index('vfe_econ_idx').on(t.economicCategory),
    index('vfe_original_idx').on(t.originalEventId),
  ]
)
