/**
 * Staff alerts + Web Push device subscriptions (migration drizzle/migrations/manual/0068_staff_push_alerts.sql).
 *
 * staff_alerts is the DURABLE record that something staff must see happened; staff_alert_deliveries is
 * the per-device retry outbox. Neither ever holds customer contact details — an alert points at an
 * appointment id and the appointment row stays the single source of truth.
 */
import { pgTable, uuid, varchar, text, timestamp, integer } from 'drizzle-orm/pg-core'
import { appointments } from '@/apps/appointments/schema'

export const staffPushSubscriptions = pgTable('staff_push_subscriptions', {
  id:             uuid('id').primaryKey().defaultRandom(),
  /** The push service URL the device issued (Apple/Google/Mozilla). */
  endpoint:       text('endpoint').notNull(),
  /** sha256(endpoint) — the unique key, and the only form safe to log. */
  endpointHash:   varchar('endpoint_hash', { length: 64 }).notNull(),
  p256dh:         varchar('p256dh', { length: 120 }).notNull(),
  auth:           varchar('auth', { length: 60 }).notNull(),
  employeeKey:    varchar('employee_key', { length: 40 }).notNull(),
  employeeName:   varchar('employee_name', { length: 120 }).notNull(),
  /** Role at enrolment — display/audit only; authority is re-checked live at send time. */
  employeeRole:   varchar('employee_role', { length: 16 }).notNull(),
  deviceLabel:    varchar('device_label', { length: 120 }),
  /** Audit: when this device's row first appeared. Never rewritten. */
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * When this device's CURRENT enrolment began — the cut-off for "which bookings is this device
   * entitled to be told about". A routine refresh by the same person PRESERVES it; a fresh
   * enrolment after the device was disabled, or a hand-over to a different person on a shared shop
   * phone, moves it forward so the new enrolment cannot be alerted about older bookings.
   */
  enrolledAt:     timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt:     timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt:  timestamp('last_success_at', { withTimezone: true }),
  /** Soft disable — a device row is never deleted, so the enrolment history stays auditable. */
  disabledAt:     timestamp('disabled_at', { withTimezone: true }),
  disabledReason: varchar('disabled_reason', { length: 40 }), // signed_out | expired | revoked | replaced | disabled_by_staff
})

export const staffAlerts = pgTable('staff_alerts', {
  id:            uuid('id').primaryKey().defaultRandom(),
  kind:          varchar('kind', { length: 32 }).notNull(), // new_booking
  appointmentId: uuid('appointment_id').references(() => appointments.id),
  /** One alert per real-world event; a replayed submission collides here and is ignored. */
  dedupeKey:     varchar('dedupe_key', { length: 160 }).notNull(),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Claimed once, when the alert is expanded into per-device deliveries. */
  fannedOutAt:   timestamp('fanned_out_at', { withTimezone: true }),
  resolvedAt:    timestamp('resolved_at', { withTimezone: true }),
  resolution:    varchar('resolution', { length: 40 }), // delivered | no_devices | not_configured | expired_unsent | all_failed
})

export const staffAlertDeliveries = pgTable('staff_alert_deliveries', {
  id:             uuid('id').primaryKey().defaultRandom(),
  alertId:        uuid('alert_id').notNull().references(() => staffAlerts.id),
  subscriptionId: uuid('subscription_id').notNull().references(() => staffPushSubscriptions.id),
  status:         varchar('status', { length: 16 }).notNull().default('pending'), // pending | sending | sent | failed | expired | skipped
  attempts:       integer('attempts').notNull().default(0),
  sendAfter:      timestamp('send_after', { withTimezone: true }).notNull().defaultNow(),
  /** When a worker claimed this row; a stale claim means that worker never came back. */
  claimedAt:      timestamp('claimed_at', { withTimezone: true }),
  httpStatus:     integer('http_status'),
  error:          text('error'),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt:         timestamp('sent_at', { withTimezone: true }),
})
