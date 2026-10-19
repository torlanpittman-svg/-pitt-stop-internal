/**
 * Drop-off appointments (migration drizzle/migrations/manual/0058_appointments.sql). An appointment is a
 * reserved DROP-OFF time — never a Job. Check-in hands it to the existing Quick Entry job creator.
 * appointment_events is append-only.
 */
import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, boolean, date } from 'drizzle-orm/pg-core'

export const appointments = pgTable('appointments', {
  id:                uuid('id').primaryKey().defaultRandom(),
  reference:         varchar('reference', { length: 16 }).notNull(),
  tokenHash:         varchar('token_hash', { length: 64 }).notNull(),
  idempotencyKey:    varchar('idempotency_key', { length: 80 }).notNull(),
  status:            varchar('status', { length: 16 }).notNull().default('confirmed'), // confirmed | arrived | cancelled | no_show
  localDate:         date('local_date').notNull(),               // shop-local YYYY-MM-DD
  localTime:         varchar('local_time', { length: 5 }).notNull(), // shop-local HH:MM drop-off time
  startsAt:          timestamp('starts_at', { withTimezone: true }).notNull(),
  serviceKeys:       jsonb('service_keys').$type<string[]>().notNull().default([]),
  serviceLabels:     text('service_labels').notNull().default(''),
  unitsDetail:       integer('units_detail').notNull().default(0),
  unitsMechanic:     integer('units_mechanic').notNull().default(0),
  firstName:         varchar('first_name', { length: 120 }).notNull(),
  lastName:          varchar('last_name', { length: 120 }).notNull().default(''),
  phone:             varchar('phone', { length: 40 }).notNull().default(''),
  normalizedPhone:   varchar('normalized_phone', { length: 20 }),
  email:             varchar('email', { length: 240 }),
  vehicleYear:       varchar('vehicle_year', { length: 4 }),
  vehicleMake:       varchar('vehicle_make', { length: 100 }),
  vehicleModel:      varchar('vehicle_model', { length: 100 }),
  vehicleColor:      varchar('vehicle_color', { length: 60 }),
  vehiclePlate:      varchar('vehicle_plate', { length: 20 }),
  vehicleVin:        varchar('vehicle_vin', { length: 17 }),
  customerNotes:     text('customer_notes'),
  internalNotes:     text('internal_notes'),
  source:            varchar('source', { length: 24 }).notNull().default('website_booking'),
  attribution:       jsonb('attribution').$type<Record<string, string>>().notNull().default({}),
  externalRef:       varchar('external_ref', { length: 120 }),
  customerId:        uuid('customer_id'),
  vehicleId:         uuid('vehicle_id'),
  serviceOrderId:    uuid('service_order_id'),
  marketingLeadId:   uuid('marketing_lead_id'),
  smsMarketingOptIn: boolean('sms_marketing_opt_in').notNull().default(false),
  capacityOverride:  boolean('capacity_override').notNull().default(false),
  ipHash:            varchar('ip_hash', { length: 64 }),
  createdBy:         varchar('created_by', { length: 200 }),
  acknowledgedAt:    timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy:    varchar('acknowledged_by', { length: 200 }),
  checkinStartedAt:  timestamp('checkin_started_at', { withTimezone: true }),
  arrivedAt:         timestamp('arrived_at', { withTimezone: true }),
  cancelledAt:       timestamp('cancelled_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const appointmentEvents = pgTable('appointment_events', {
  id:            uuid('id').primaryKey().defaultRandom(),
  appointmentId: uuid('appointment_id').notNull().references(() => appointments.id),
  eventType:     varchar('event_type', { length: 32 }).notNull(),
  actor:         varchar('actor', { length: 200 }),
  meta:          jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const appointmentBlocks = pgTable('appointment_blocks', {
  id:        uuid('id').primaryKey().defaultRandom(),
  kind:      varchar('kind', { length: 8 }).notNull().default('close'), // close | open (re-open a holiday)
  localDate: date('local_date').notNull(),
  localTime: varchar('local_time', { length: 5 }),                     // null = whole day
  reason:    varchar('reason', { length: 200 }),
  createdBy: varchar('created_by', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
  removedBy: varchar('removed_by', { length: 200 }),
})

export const appointmentNotifications = pgTable('appointment_notifications', {
  id:                uuid('id').primaryKey().defaultRandom(),
  appointmentId:     uuid('appointment_id').notNull().references(() => appointments.id),
  kind:              varchar('kind', { length: 16 }).notNull(), // confirmation | reminder | cancellation | reschedule
  channel:           varchar('channel', { length: 8 }).notNull().default('email'),
  toAddress:         varchar('to_address', { length: 240 }),
  dedupeKey:         varchar('dedupe_key', { length: 160 }).notNull(),
  status:            varchar('status', { length: 16 }).notNull().default('pending'), // pending | sending | sent | not_configured | failed | skipped
  sendAfter:         timestamp('send_after', { withTimezone: true }).notNull().defaultNow(),
  attempts:          integer('attempts').notNull().default(0),
  provider:          varchar('provider', { length: 40 }),
  providerMessageId: varchar('provider_message_id', { length: 200 }),
  error:             text('error'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt:            timestamp('sent_at', { withTimezone: true }),
})
