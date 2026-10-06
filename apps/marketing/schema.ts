/**
 * Marketing Agent V1 schema. Tables sit ON TOP OF the canonical model — customers
 * (apps/directory), service_orders (apps/workflow), order_photos (apps/order-photos) —
 * and never duplicate customer identity. Cross-module foreign keys are declared in SQL
 * only (drizzle/migrations/manual/0046_marketing.sql), mirroring 0043_customer_links, to
 * avoid circular schema imports. Intra-module relations use Drizzle `.references()`.
 *
 * Append-only by policy: marketing_events and marketing_attribution are never updated or
 * deleted — add a correcting row. Everything else is additive and prod-safe.
 */
import { pgTable, uuid, text, varchar, integer, boolean, jsonb, timestamp, date, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const marketingPreferences = pgTable('marketing_preferences', {
  id:                uuid('id').primaryKey().defaultRandom(),
  customerId:        uuid('customer_id').notNull(),
  // `smsEligible` is a manager HARD-BLOCK override (false = never SMS even with consent). Real SMS
  // eligibility is driven by `smsConsentStatus` below — a present phone is NOT consent (0047).
  smsEligible:       boolean('sms_eligible').notNull().default(true),
  emailEligible:     boolean('email_eligible').notNull().default(true),
  // Proven promotional-SMS consent. Default 'unknown' ⇒ NOT eligible. Only 'granted' can receive SMS.
  smsConsentStatus:  varchar('sms_consent_status', { length: 10 }).notNull().default('unknown'), // unknown | granted | revoked
  smsConsentSource:  varchar('sms_consent_source', { length: 40 }),
  smsConsentAt:      timestamp('sms_consent_at', { withTimezone: true }),
  smsConsentVersion: varchar('sms_consent_version', { length: 40 }),
  unsubscribedAt:    timestamp('unsubscribed_at', { withTimezone: true }),
  unsubscribeReason: text('unsubscribe_reason'),
  unsubscribeScope:  varchar('unsubscribe_scope', { length: 10 }).notNull().default('all'),
  unsubscribeToken:  uuid('unsubscribe_token').notNull().defaultRandom(),
  marketingSource:   varchar('marketing_source', { length: 40 }),
  lastContactedAt:   timestamp('last_contacted_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('marketing_preferences_customer_uniq').on(t.customerId),
  uniqueIndex('marketing_preferences_token_uniq').on(t.unsubscribeToken),
])

// Append-only consent audit trail (how a customer's SMS/email consent state got where it is).
export const marketingConsentEvents = pgTable('marketing_consent_events', {
  id:             uuid('id').primaryKey().defaultRandom(),
  customerId:     uuid('customer_id'),
  channel:        varchar('channel', { length: 10 }).notNull(),   // sms | email
  event:          varchar('event', { length: 16 }).notNull(),     // opt_in | opt_out | import_verified | help
  source:         varchar('source', { length: 40 }).notNull(),
  wordingVersion: varchar('wording_version', { length: 40 }),
  consentText:    text('consent_text'),
  phone:          varchar('phone', { length: 40 }),
  actor:          varchar('actor', { length: 200 }),
  ip:             varchar('ip', { length: 64 }),
  userAgent:      text('user_agent'),
  meta:           jsonb('meta'),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('marketing_consent_customer_idx').on(t.customerId),
  index('marketing_consent_channel_idx').on(t.channel, t.event),
  index('marketing_consent_created_idx').on(t.createdAt),
])

export const marketingCampaigns = pgTable('marketing_campaigns', {
  id:              uuid('id').primaryKey().defaultRandom(),
  name:            varchar('name', { length: 160 }).notNull(),
  campaignType:    varchar('campaign_type', { length: 40 }).notNull().default('reactivation'),
  targetService:   varchar('target_service', { length: 40 }),
  segmentKey:      varchar('segment_key', { length: 60 }),
  segmentCriteria: jsonb('segment_criteria'),
  channel:         varchar('channel', { length: 10 }).notNull().default('both'),
  status:          varchar('status', { length: 16 }).notNull().default('draft'),
  scheduledAt:     timestamp('scheduled_at', { withTimezone: true }),
  offer:           text('offer'),
  smsCopy:         text('sms_copy'),
  emailSubject:    text('email_subject'),
  emailBody:       text('email_body'),
  createdBy:       varchar('created_by', { length: 200 }),
  approvedBy:      varchar('approved_by', { length: 200 }),
  approvedAt:      timestamp('approved_at', { withTimezone: true }),
  sentAt:          timestamp('sent_at', { withTimezone: true }),
  recipientCount:  integer('recipient_count').notNull().default(0),
  sentCount:       integer('sent_count').notNull().default(0),
  excludedCount:   integer('excluded_count').notNull().default(0),
  responseCount:   integer('response_count').notNull().default(0),
  dryRun:          boolean('dry_run').notNull().default(true),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('marketing_campaigns_status_idx').on(t.status),
  index('marketing_campaigns_scheduled_idx').on(t.scheduledAt),
])

export const marketingCampaignRecipients = pgTable('marketing_campaign_recipients', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  campaignId:            uuid('campaign_id').notNull().references(() => marketingCampaigns.id, { onDelete: 'cascade' }),
  customerId:            uuid('customer_id'),
  channel:               varchar('channel', { length: 10 }).notNull(),
  addressSnapshot:       varchar('address_snapshot', { length: 240 }),
  vehicleLabel:          varchar('vehicle_label', { length: 160 }),
  status:                varchar('status', { length: 16 }).notNull().default('pending'),
  exclusionReason:       varchar('exclusion_reason', { length: 60 }),
  renderedBody:          text('rendered_body'),
  providerMessageId:     varchar('provider_message_id', { length: 64 }),
  deliveryStatus:        varchar('delivery_status', { length: 20 }),
  errorCode:             varchar('error_code', { length: 20 }),
  sentAt:                timestamp('sent_at', { withTimezone: true }),
  respondedAt:           timestamp('responded_at', { withTimezone: true }),
  bookedOrderId:         uuid('booked_order_id'),
  completedRevenueCents: integer('completed_revenue_cents'),
  createdAt:             timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('marketing_recipients_dedup_uniq').on(t.campaignId, t.customerId, t.channel),
  index('marketing_recipients_campaign_idx').on(t.campaignId),
  index('marketing_recipients_status_idx').on(t.status),
])

export const marketingSocialPosts = pgTable('marketing_social_posts', {
  id:              uuid('id').primaryKey().defaultRandom(),
  platform:        varchar('platform', { length: 20 }).notNull().default('facebook'),
  pillar:          varchar('pillar', { length: 12 }).notNull(),
  targetService:   varchar('target_service', { length: 40 }),
  copy:            text('copy').notNull().default(''),
  serviceOrderId:  uuid('service_order_id'),
  beforePhotoId:   uuid('before_photo_id'),
  afterPhotoId:    uuid('after_photo_id'),
  scheduledAt:     timestamp('scheduled_at', { withTimezone: true }),
  status:          varchar('status', { length: 12 }).notNull().default('idea'),
  aiGenerated:     boolean('ai_generated').notNull().default(false),
  approvedBy:      varchar('approved_by', { length: 200 }),
  externalPostRef: varchar('external_post_ref', { length: 120 }),
  createdBy:       varchar('created_by', { length: 200 }),
  createdSource:   varchar('created_source', { length: 24 }).notNull().default('manual'),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('marketing_posts_status_idx').on(t.status),
  index('marketing_posts_scheduled_idx').on(t.scheduledAt),
])

export const marketingLeads = pgTable('marketing_leads', {
  id:                     uuid('id').primaryKey().defaultRandom(),
  name:                   varchar('name', { length: 200 }),
  phone:                  varchar('phone', { length: 40 }),
  email:                  varchar('email', { length: 240 }),
  vehicle:                varchar('vehicle', { length: 160 }),
  requestedService:       varchar('requested_service', { length: 40 }),
  source:                 varchar('source', { length: 24 }).notNull().default('unknown'),
  campaignId:             uuid('campaign_id').references(() => marketingCampaigns.id, { onDelete: 'set null' }),
  status:                 varchar('status', { length: 16 }).notNull().default('new'),
  estimatedValueCents:    integer('estimated_value_cents'),
  customerId:             uuid('customer_id'),
  serviceOrderId:         uuid('service_order_id'),
  attributedRevenueCents: integer('attributed_revenue_cents'),
  notes:                  text('notes'),
  createdAt:              timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:              timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('marketing_leads_status_idx').on(t.status),
  index('marketing_leads_source_idx').on(t.source),
  index('marketing_leads_created_idx').on(t.createdAt),
])

export const marketingAttribution = pgTable('marketing_attribution', {
  id:             uuid('id').primaryKey().defaultRandom(),
  source:         varchar('source', { length: 24 }).notNull(),
  medium:         varchar('medium', { length: 40 }),
  campaign:       varchar('campaign', { length: 120 }),
  utmSource:      varchar('utm_source', { length: 120 }),
  utmMedium:      varchar('utm_medium', { length: 120 }),
  utmCampaign:    varchar('utm_campaign', { length: 120 }),
  clickId:        varchar('click_id', { length: 120 }),
  touchType:      varchar('touch_type', { length: 8 }).notNull().default('last'),
  confidence:     varchar('confidence', { length: 10 }).notNull().default('unknown'),
  customerId:     uuid('customer_id'),
  serviceOrderId: uuid('service_order_id'),
  leadId:         uuid('lead_id').references(() => marketingLeads.id, { onDelete: 'set null' }),
  campaignId:     uuid('campaign_id').references(() => marketingCampaigns.id, { onDelete: 'set null' }),
  revenueCents:   integer('revenue_cents'),
  occurredAt:     timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('marketing_attr_source_idx').on(t.source),
  index('marketing_attr_order_idx').on(t.serviceOrderId),
  index('marketing_attr_occurred_idx').on(t.occurredAt),
])

export const marketingEvents = pgTable('marketing_events', {
  id:         uuid('id').primaryKey().defaultRandom(),
  eventType:  varchar('event_type', { length: 40 }).notNull(),
  entityType: varchar('entity_type', { length: 24 }),
  entityId:   uuid('entity_id'),
  actor:      varchar('actor', { length: 200 }),
  meta:       jsonb('meta'),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('marketing_events_type_idx').on(t.eventType),
  index('marketing_events_entity_idx').on(t.entityType, t.entityId),
  index('marketing_events_created_idx').on(t.createdAt),
])

export const marketingAdMetrics = pgTable('marketing_ad_metrics', {
  id:              uuid('id').primaryKey().defaultRandom(),
  provider:        varchar('provider', { length: 16 }).notNull().default('manual'),
  serviceCategory: varchar('service_category', { length: 40 }).notNull(),
  statDate:        date('stat_date').notNull(),
  spendCents:      integer('spend_cents').notNull().default(0),
  impressions:     integer('impressions').notNull().default(0),
  clicks:          integer('clicks').notNull().default(0),
  conversions:     integer('conversions').notNull().default(0),
  revenueCents:    integer('revenue_cents').notNull().default(0),
  createdBy:       varchar('created_by', { length: 200 }),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('marketing_ad_metrics_uniq').on(t.provider, t.serviceCategory, t.statDate),
  index('marketing_ad_metrics_date_idx').on(t.statDate),
])

export const marketingSearchTerms = pgTable('marketing_search_terms', {
  id:              uuid('id').primaryKey().defaultRandom(),
  term:            varchar('term', { length: 200 }).notNull(),
  serviceCategory: varchar('service_category', { length: 40 }),
  spendCents:      integer('spend_cents').notNull().default(0),
  clicks:          integer('clicks').notNull().default(0),
  conversions:     integer('conversions').notNull().default(0),
  revenueCents:    integer('revenue_cents').notNull().default(0),
  statPeriod:      varchar('stat_period', { length: 20 }),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('marketing_search_terms_period_idx').on(t.statPeriod),
])

export const marketingConversations = pgTable('marketing_conversations', {
  id:               uuid('id').primaryKey().defaultRandom(),
  platform:         varchar('platform', { length: 20 }).notNull().default('facebook'),
  externalRef:      varchar('external_ref', { length: 160 }),
  authorName:       varchar('author_name', { length: 200 }),
  message:          text('message').notNull(),
  topic:            varchar('topic', { length: 40 }),
  suggestedReply:   text('suggested_reply'),
  state:            varchar('state', { length: 16 }).notNull().default('new'),
  escalationReason: varchar('escalation_reason', { length: 60 }),
  handledBy:        varchar('handled_by', { length: 200 }),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('marketing_conversations_state_idx').on(t.state),
])
