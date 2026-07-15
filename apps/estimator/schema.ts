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
} from 'drizzle-orm/pg-core'

export const retailCustomers = pgTable(
  'retail_customers',
  {
    id:        uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    name:      varchar('name',  { length: 200 }).notNull(),
    phone:     varchar('phone', { length: 30 }),
  },
  (t) => [
    index('customers_phone_idx').on(t.phone),
  ]
)

export const estimates = pgTable(
  'estimates',
  {
    id:        uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // Customer (denormalized for display without join)
    customerId:    uuid('customer_id').references(() => retailCustomers.id),
    customerName:  varchar('customer_name',  { length: 200 }),
    customerPhone: varchar('customer_phone', { length: 30  }),

    // Service scope — employee selects at intake
    serviceFocus: varchar('service_focus', { length: 50 }),

    // Vehicle — confirmed by employee
    vehicleYear:  varchar('vehicle_year',  { length: 4   }),
    vehicleMake:  varchar('vehicle_make',  { length: 100 }),
    vehicleModel: varchar('vehicle_model', { length: 100 }),
    vehicleColor: varchar('vehicle_color', { length: 100 }),
    vehicleSize:  varchar('vehicle_size',  { length: 50  }),

    // AI-original vehicle fields (written once at analysis time, never updated)
    aiVehicleYear:  varchar('ai_vehicle_year',  { length: 4   }),
    aiVehicleMake:  varchar('ai_vehicle_make',  { length: 100 }),
    aiVehicleModel: varchar('ai_vehicle_model', { length: 100 }),
    aiVehicleColor: varchar('ai_vehicle_color', { length: 100 }),
    aiVehicleSize:  varchar('ai_vehicle_size',  { length: 50  }),
    aiDifficultyRating:    varchar('ai_difficulty_rating',     { length: 20  }),
    aiTotalLaborMinutes:   integer('ai_total_labor_minutes'),
    aiNotes:               text('ai_notes'),

    // Pricing
    recommendedPriceCents: integer('recommended_price_cents'),
    approvedPriceCents:    integer('approved_price_cents'),

    // AI metadata
    promptVersion: varchar('prompt_version', { length: 50  }),
    modelName:     varchar('model_name',     { length: 100 }),
    rawAiResponse: jsonb('raw_ai_response'),

    // Workflow
    // draft | photos_complete | ai_pending | needs_review | approved
    status:         varchar('status', { length: 50 }).notNull().default('draft'),
    estimateNumber: varchar('estimate_number', { length: 20 }),
    employeeId:     varchar('employee_id', { length: 200 }),
    employeeApprovedAt: timestamp('employee_approved_at', { withTimezone: true }),
  },
  (t) => [
    index('estimates_status_idx').on(t.status),
    index('estimates_customer_idx').on(t.customerId),
    index('estimates_created_idx').on(t.createdAt),
  ]
)

export const estimatePhotos = pgTable(
  'estimate_photos',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    estimateId:   uuid('estimate_id').notNull().references(() => estimates.id, { onDelete: 'cascade' }),
    photoUrl:     text('photo_url').notNull(),
    role:         varchar('role',  { length: 30  }).notNull(),
    captureOrder: integer('capture_order').notNull(),
    uploadedAt:   timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('photos_estimate_idx').on(t.estimateId),
  ]
)

export const estimateLineItems = pgTable(
  'estimate_line_items',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    estimateId:   uuid('estimate_id').notNull().references(() => estimates.id, { onDelete: 'cascade' }),
    displayOrder: integer('display_order').notNull().default(0),

    // AI-extracted (written once, immutable after analysis)
    aiCategory:     varchar('ai_category',    { length: 50  }),
    aiLocation:     varchar('ai_location',    { length: 100 }),
    aiDamageType:   varchar('ai_damage_type', { length: 50  }),
    aiSeverity:     varchar('ai_severity',    { length: 20  }),
    aiDescription:  text('ai_description'),
    aiServiceCode:  varchar('ai_service_code', { length: 100 }),
    aiLaborMinutes: integer('ai_labor_minutes'),
    aiConfidence:   numeric('ai_confidence', { precision: 4, scale: 3 }),
    aiIsTimeTrap:   boolean('ai_is_time_trap').notNull().default(false),

    // Employee-confirmed (mutable)
    description:    text('description'),
    serviceCode:    varchar('service_code', { length: 100 }),
    severity:       varchar('severity', { length: 20 }),
    laborMinutes:   integer('labor_minutes'),
    unitPriceCents: integer('unit_price_cents'),
    lineTotalCents: integer('line_total_cents'),
    included:       boolean('included').notNull().default(true),

    // Correction flags
    wasAddedByEmployee: boolean('was_added_by_employee').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('line_items_estimate_idx').on(t.estimateId),
  ]
)
