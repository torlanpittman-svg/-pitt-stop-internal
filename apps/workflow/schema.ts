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

export const employees = pgTable('employees', {
  id:        uuid('id').primaryKey().defaultRandom(),
  name:      varchar('name', { length: 200 }).notNull(),
  active:    boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const locations = pgTable('locations', {
  id:       uuid('id').primaryKey().defaultRandom(),
  name:     varchar('name', { length: 200 }).notNull(),
  timezone: varchar('timezone', { length: 50 }).notNull().default('America/New_York'),
  active:   boolean('active').notNull().default(true),
})

export const vehicles = pgTable(
  'vehicles',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    vin:          varchar('vin', { length: 17 }),
    year:         varchar('year', { length: 4 }),
    make:         varchar('make', { length: 100 }),
    model:        varchar('model', { length: 100 }),
    color:        varchar('color', { length: 100 }),
    licensePlate: varchar('license_plate', { length: 20 }),
    bodyClass:    varchar('body_class', { length: 100 }),
    vinRaw:       jsonb('vin_raw'),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vehicles_vin_idx').on(t.vin)]
)

// Status values:
// arrived → in_progress ↔ paused → drying → qc_ready → ready → delivered | cancelled
export const serviceOrders = pgTable(
  'service_orders',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    orderNumber: varchar('order_number', { length: 20 }).notNull().unique(),
    locationId:  uuid('location_id').references(() => locations.id),
    vehicleId:   uuid('vehicle_id').notNull().references(() => vehicles.id),

    source:       varchar('source',       { length: 30 }).notNull().default('walk_in'),
    serviceType:  varchar('service_type', { length: 30 }),
    serviceFocus: varchar('service_focus', { length: 50 }),

    status: varchar('status', { length: 30 }).notNull().default('arrived'),

    estimateId:         uuid('estimate_id'),
    quotedPriceCents:   integer('quoted_price_cents'),
    approvedPriceCents: integer('approved_price_cents'),

    notes:       text('notes'),
    checkedInBy: varchar('checked_in_by', { length: 200 }),

    arrivedAt:   timestamp('arrived_at',   { withTimezone: true }),
    startedAt:   timestamp('started_at',   { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('service_orders_status_idx').on(t.status),
    index('service_orders_vehicle_idx').on(t.vehicleId),
    index('service_orders_created_idx').on(t.createdAt),
  ]
)

// One row per tech work session — null stoppedAt = currently active
export const serviceOrderAssignments = pgTable(
  'service_order_assignments',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    serviceOrderId: uuid('service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    employeeName:   varchar('employee_name', { length: 200 }).notNull(),
    startedAt:      timestamp('started_at', { withTimezone: true }).notNull(),
    stoppedAt:      timestamp('stopped_at', { withTimezone: true }),
  },
  (t) => [index('assignments_order_idx').on(t.serviceOrderId)]
)

// Append-only audit trail — never update or delete rows
export const serviceOrderEvents = pgTable(
  'service_order_events',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    serviceOrderId: uuid('service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
    eventType:      varchar('event_type', { length: 50 }).notNull(),
    employeeName:   varchar('employee_name', { length: 200 }),
    oldStatus:      varchar('old_status', { length: 30 }),
    newStatus:      varchar('new_status', { length: 30 }),
    note:           text('note'),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_order_idx').on(t.serviceOrderId)]
)
