/**
 * Oil-change reminder stickers — the durable record of every sticker issued (which also
 * gives each vehicle a mileage history for prefill). ADDITIVE ONLY; soft links to
 * service_orders / vehicles (no FK — orders are never blocked by sticker records).
 *
 * Printing goes through the SHARED cloud print queue (print_jobs, kind 'sticker') but a
 * sticker row never references checks, bank data, or QuickBooks — and vice versa.
 * Aggregated by drizzle/schema.ts. DDL: drizzle/migrations/manual/0066_oil_stickers.sql.
 */
import { pgTable, uuid, varchar, integer, date, timestamp, index } from 'drizzle-orm/pg-core'

export const oilChangeStickers = pgTable(
  'oil_change_stickers',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    orderId:        uuid('order_id').notNull(),      // service_orders.id (soft link)
    vehicleId:      uuid('vehicle_id'),              // vehicles.id (soft link) — mileage history per vehicle
    mileage:        integer('mileage').notNull(),    // odometer at service time (manual entry)
    intervalMiles:  integer('interval_miles'),       // chosen per sticker; null = date-only reminder
    intervalMonths: integer('interval_months'),      // chosen per sticker; null = mileage-only reminder
    nextMileage:    integer('next_mileage').notNull(),
    nextDate:       date('next_date').notNull(),
    nextDateText:   varchar('next_date_text', { length: 40 }).notNull(), // exactly as printed
    createdBy:      varchar('created_by', { length: 120 }),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('oil_stickers_order_idx').on(t.orderId),
    index('oil_stickers_vehicle_idx').on(t.vehicleId, t.createdAt),
  ],
)
