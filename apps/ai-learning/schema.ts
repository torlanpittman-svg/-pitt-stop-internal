/**
 * AI Learning — shared schema.
 * Estimator learning events (one row per approved estimate).
 */

import {
  pgTable, uuid, timestamp, varchar, integer, boolean, jsonb, index,
} from 'drizzle-orm/pg-core'

export const estimatorLearningEvents = pgTable(
  'estimator_learning_events',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    estimateId:  uuid('estimate_id').notNull(),
    createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // Service context
    serviceFocus: varchar('service_focus', { length: 50 }),

    // Vehicle at time of approval
    vehicleYear:  varchar('vehicle_year',  { length: 4   }),
    vehicleMake:  varchar('vehicle_make',  { length: 100 }),
    vehicleModel: varchar('vehicle_model', { length: 100 }),
    vehicleColor: varchar('vehicle_color', { length: 100 }),
    vehicleVin:   varchar('vehicle_vin',   { length: 17  }),
    vehicleWasCorrected: boolean('vehicle_was_corrected').notNull().default(false),

    // Photos
    photoCount: integer('photo_count').notNull().default(0),

    // Pricing — this is the core learning signal
    aiRecommendedPriceCents: integer('ai_recommended_price_cents'),
    approvedPriceCents:      integer('approved_price_cents'),
    pricingWasCorrected:     boolean('pricing_was_corrected').notNull().default(false),
    priceAdjustmentCents:    integer('price_adjustment_cents'),  // approved - ai (signed)

    // Line items snapshot at approval time
    // [{description, serviceCode, aiCents, finalCents, included, wasAddedByEmployee}]
    lineItemCount:     integer('line_item_count').notNull().default(0),
    lineItemsSnapshot: jsonb('line_items_snapshot'),

    // AI model metadata
    promptVersion: varchar('prompt_version', { length: 50  }),
    modelName:     varchar('model_name',     { length: 100 }),
  },
  (t) => [
    index('estimator_learning_estimate_idx').on(t.estimateId),
    index('estimator_learning_created_idx').on(t.createdAt),
    index('estimator_learning_service_idx').on(t.serviceFocus),
  ]
)
