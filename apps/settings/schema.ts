/**
 * Shop-wide business settings — a single key/value table so new rules (fees, tax,
 * later toggles) never need a new table. Values are typed via the `type` column and
 * resolved with an env/default fallback in apps/settings/db.ts. Applied via the
 * manual migration drizzle/migrations/manual/0016_fees_and_settings.sql.
 */
import { pgTable, varchar, jsonb, text, timestamp } from 'drizzle-orm/pg-core'

export const appSettings = pgTable('app_settings', {
  key:        varchar('key', { length: 80 }).primaryKey(),
  value:      jsonb('value').notNull(),
  type:       varchar('type', { length: 12 }).notNull(),   // int | bool | string | json
  category:   varchar('category', { length: 40 }),
  label:      varchar('label', { length: 160 }),
  description: text('description'),
  updatedBy:  varchar('updated_by', { length: 200 }),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
