/**
 * CFO Financial OS — Phase 1 foundation schema. Additive-only; no existing table is touched.
 * Every money value carries source + as-of + confidence so a QuickBooks BOOK balance is never
 * presented as live cash. Read-only toward QuickBooks; no money movement anywhere.
 * Aggregated by drizzle/schema.ts.
 */
import { pgTable, uuid, text, varchar, integer, boolean, date, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core'

// One row per real financial account (bank / credit card / loan / LOC / floor plan / clearing).
export const finAccounts = pgTable(
  'fin_accounts',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    name:           varchar('name', { length: 200 }).notNull(),
    kind:           varchar('kind', { length: 24 }).notNull(),          // bank|credit_card|loan|loc|floor_plan|clearing|reserve|other
    classification: varchar('classification', { length: 16 }).notNull(),// asset|liability|equity
    isCash:         boolean('is_cash').notNull().default(false),        // counts toward cash-on-hand (bank only)
    isLiability:    boolean('is_liability').notNull().default(false),
    clearingSuspect:boolean('clearing_suspect').notNull().default(false),// unreconciled clearing (Undeposited/Clover)
    externalSource: varchar('external_source', { length: 20 }).notNull().default('qbo'), // qbo|plaid|manual|document
    externalId:     varchar('external_id', { length: 64 }),             // QBO Account.Id
    accountType:    varchar('account_type', { length: 60 }),            // QBO AccountType (raw)
    accountSubType: varchar('account_sub_type', { length: 60 }),
    institution:    varchar('institution', { length: 120 }),            // Extraco | American Momentum | Amex … (owner maps)
    currency:       varchar('currency', { length: 8 }).notNull().default('USD'),
    active:         boolean('active').notNull().default(true),
    // Lifecycle: active participates in the CFO; ignored = kept for history but never counted
    // as Pitt Stop cash / Safe-to-Spend / obligations; closed = account no longer exists.
    status:         varchar('status', { length: 16 }).notNull().default('active'), // active|ignored|closed
    notes:          text('notes'),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('fin_accounts_source_ext_uniq').on(t.externalSource, t.externalId), index('fin_accounts_kind_idx').on(t.kind)],
)

// Append-only balance history. Freshness = the latest snapshot per account. Never overwritten.
export const finBalanceSnapshots = pgTable(
  'fin_balance_snapshots',
  {
    id:            uuid('id').primaryKey().defaultRandom(),
    accountId:     uuid('account_id').notNull().references(() => finAccounts.id, { onDelete: 'cascade' }),
    balanceCents:  integer('balance_cents').notNull(),
    availableCents:integer('available_cents'),                          // null unless a live source provides it
    asOf:          timestamp('as_of', { withTimezone: true }).notNull(),
    source:        varchar('source', { length: 20 }).notNull(),         // qbo|plaid|manual|document
    confidence:    varchar('confidence', { length: 20 }).notNull(),     // book|live|estimated|manual_verified
    capturedAt:    timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    raw:           jsonb('raw'),
  },
  (t) => [index('fin_bal_account_idx').on(t.accountId), index('fin_bal_asof_idx').on(t.asOf)],
)

// Debt register — seeded from QBO notes (book, unverified). Statements later set live terms.
export const finDebts = pgTable(
  'fin_debts',
  {
    id:                 uuid('id').primaryKey().defaultRandom(),
    name:               varchar('name', { length: 200 }).notNull(),
    lender:             varchar('lender', { length: 120 }),
    kind:               varchar('kind', { length: 24 }).notNull().default('term_loan'), // term_loan|loc|floor_plan|credit_card|equipment|private_note
    externalSource:     varchar('external_source', { length: 20 }).notNull().default('qbo'),
    externalId:         varchar('external_id', { length: 64 }),          // QBO Account.Id
    principalCents:     integer('principal_cents'),
    originalPrincipalCents: integer('original_principal_cents'),
    aprBps:             integer('apr_bps'),                              // null until a statement is provided
    paymentCents:       integer('payment_cents'),
    paymentFrequency:   varchar('payment_frequency', { length: 16 }),
    nextDue:            date('next_due'),
    maturity:           date('maturity'),
    availableCreditCents: integer('available_credit_cents'),
    collateral:         text('collateral'),
    source:             varchar('source', { length: 20 }).notNull().default('qbo'),
    asOf:               timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
    confidence:         varchar('confidence', { length: 20 }).notNull().default('book'),
    verified:           boolean('verified').notNull().default(false),
    notes:              text('notes'),
    createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('fin_debts_source_ext_uniq').on(t.externalSource, t.externalId)],
)

// Payroll obligation. Manual in Phase 1 (highest-priority "can we make payroll?"); QBO Payroll API later.
export const finPayroll = pgTable('fin_payroll', {
  id:                uuid('id').primaryKey().defaultRandom(),
  nextPayDate:       date('next_pay_date').notNull(),
  expectedCashCents: integer('expected_cash_cents').notNull(),
  frequency:         varchar('frequency', { length: 16 }).notNull().default('weekly'),
  source:            varchar('source', { length: 20 }).notNull().default('manual'), // manual|qbo_payroll
  confidence:        varchar('confidence', { length: 20 }).notNull().default('manual'),
  enteredBy:         varchar('entered_by', { length: 200 }),
  asOf:              timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
  notes:             text('notes'),
})

// Recurring obligation register — Phase 1: MANUAL add only (no discovery, no seeding).
export const finObligations = pgTable('fin_obligations', {
  id:              uuid('id').primaryKey().defaultRandom(),
  vendor:          varchar('vendor', { length: 200 }).notNull(),
  category:        varchar('category', { length: 60 }),
  amountCents:     integer('amount_cents'),
  amountMinCents:  integer('amount_min_cents'),
  amountMaxCents:  integer('amount_max_cents'),
  frequency:       varchar('frequency', { length: 16 }),               // weekly|monthly|quarterly|annual|irregular
  nextDue:         date('next_due'),
  autopay:         boolean('autopay'),
  paymentAccountId:uuid('payment_account_id').references(() => finAccounts.id),
  essential:       boolean('essential'),
  source:          varchar('source', { length: 20 }).notNull().default('manual'),
  confidence:      varchar('confidence', { length: 20 }).notNull().default('manual'),
  status:          varchar('status', { length: 16 }).notNull().default('confirmed'), // proposed|confirmed|paused|ignored
  enteredBy:       varchar('entered_by', { length: 200 }),
  asOf:            timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
  notes:           text('notes'),
  // Discovery (evidence-backed proposals). discoveryKey dedupes a stream across re-runs.
  discoveryKey:    varchar('discovery_key', { length: 140 }),
  evidence:        jsonb('evidence'),
  occurrences:     integer('occurrences'),
  lastSeen:        date('last_seen'),
  avgAmountCents:  integer('avg_amount_cents'),
  dayOfWeek:       integer('day_of_week'),
  dayOfMonth:      integer('day_of_month'),                       // monthly due-day (rent/fed-tax = 15)
  critical:        boolean('critical').notNull().default(false),  // payroll / rent / debt service
  // Priority tier for Safe-to-Spend decision support.
  priority:        varchar('priority', { length: 16 }).notNull().default('contractual'), // critical|contractual|planned
  // True = reduces economically-available cash on the issue/due date even before the bank clears it
  // (e.g. paper payroll checks issued Friday).
  committedOnIssue: boolean('committed_on_issue').notNull().default(false),
})

// Financial documents — Phase 1: store + metadata only (NO OCR/extraction).
export const finDocuments = pgTable('fin_documents', {
  id:           uuid('id').primaryKey().defaultRandom(),
  type:         varchar('type', { length: 40 }).notNull(),             // loan_statement|bank_statement|lease|insurance|tax|vendor_statement|other
  blobUrl:      text('blob_url').notNull(),
  filename:     varchar('filename', { length: 300 }),
  accountId:    uuid('account_id').references(() => finAccounts.id),
  debtId:       uuid('debt_id').references(() => finDebts.id),
  periodStart:  date('period_start'),
  periodEnd:    date('period_end'),
  asOf:         date('as_of'),
  source:       varchar('source', { length: 20 }).notNull().default('manual'),
  uploadedBy:   varchar('uploaded_by', { length: 200 }),
  notes:        text('notes'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// One row per ingestion run (QBO read-sync). Holds report summaries + freshness/audit.
export const finSyncRuns = pgTable('fin_sync_runs', {
  id:         uuid('id').primaryKey().defaultRandom(),
  source:     varchar('source', { length: 20 }).notNull().default('qbo'),
  status:     varchar('status', { length: 16 }).notNull(),             // ok|partial|error
  startedAt:  timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  summary:    jsonb('summary'),                                        // counts + report figures (book)
  error:      text('error'),
  actor:      varchar('actor', { length: 200 }),
})

// One row per Plaid connection (Item). Access token stored ENCRYPTED (AES-256-GCM) — never
// plaintext, never client-side. Read-only scope; no money-movement capability.
export const finPlaidItems = pgTable('fin_plaid_items', {
  id:              uuid('id').primaryKey().defaultRandom(),
  itemId:          varchar('item_id', { length: 100 }).notNull().unique(),
  institutionId:   varchar('institution_id', { length: 64 }),
  institutionName: varchar('institution_name', { length: 200 }),
  environment:     varchar('environment', { length: 20 }).notNull(),        // sandbox | production
  accessTokenEnc:  text('access_token_enc').notNull(),                       // v1:<iv>:<tag>:<ct>
  status:          varchar('status', { length: 20 }).notNull().default('active'), // active | error | disconnected
  lastError:       text('last_error'),
  connectedBy:     varchar('connected_by', { length: 200 }),
  transactionsCursor:   text('transactions_cursor'),                                  // Plaid /transactions/sync cursor
  transactionsSyncedAt: timestamp('transactions_synced_at', { withTimezone: true }),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Plaid-discovered accounts under an Item. Unmapped + untrusted until the admin verifies which
// fin_account (e.g. QBO *2649) each corresponds to. Balances are read-only from the institution.
export const finPlaidAccounts = pgTable('fin_plaid_accounts', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  itemId:               uuid('item_id').notNull().references(() => finPlaidItems.id, { onDelete: 'cascade' }),
  plaidAccountId:       varchar('plaid_account_id', { length: 100 }).notNull().unique(),
  name:                 varchar('name', { length: 200 }),
  officialName:         varchar('official_name', { length: 200 }),
  mask:                 varchar('mask', { length: 20 }),
  type:                 varchar('type', { length: 40 }),
  subtype:              varchar('subtype', { length: 40 }),
  currentBalanceCents:  integer('current_balance_cents'),
  availableBalanceCents:integer('available_balance_cents'),
  currency:             varchar('currency', { length: 8 }),
  balanceAsOf:          timestamp('balance_as_of', { withTimezone: true }),
  mappedAccountId:      uuid('mapped_account_id').references(() => finAccounts.id), // verified link to a fin_account
  mappingVerified:      boolean('mapping_verified').notNull().default(false),
  // Connector-layer lifecycle. Plaid may force sibling accounts to stay on the Item; 'ignored'
  // keeps them connected upstream but excluded from every CFO calc/view. 'closed' = gone.
  status:               varchar('status', { length: 16 }).notNull().default('active'), // active|ignored|closed
  entityNote:           varchar('entity_note', { length: 120 }), // e.g. "holding company", "personal" — preserves entity boundary
  raw:                  jsonb('raw'),
  createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:            timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Normalized Plaid transactions for connected Pitt Stop accounts. Plaid `amount` sign convention:
// POSITIVE = money OUT of the account, NEGATIVE = money IN. Classification is advisory (evidence +
// confidence) — it never silently rewrites cash; Safe-to-Spend uses the bank's own available balance.
export const finTransactions = pgTable('fin_transactions', {
  id:                       uuid('id').primaryKey().defaultRandom(),
  plaidItemId:              uuid('plaid_item_id').notNull().references(() => finPlaidItems.id, { onDelete: 'cascade' }),
  plaidAccountRef:          uuid('plaid_account_ref').references(() => finPlaidAccounts.id, { onDelete: 'set null' }),
  finAccountId:             uuid('fin_account_id').references(() => finAccounts.id, { onDelete: 'set null' }),
  plaidTransactionId:       varchar('plaid_transaction_id', { length: 100 }).notNull().unique(),
  plaidAccountId:           varchar('plaid_account_id', { length: 100 }).notNull(),
  pendingPlaidTransactionId:varchar('pending_plaid_transaction_id', { length: 100 }),
  amountCents:              integer('amount_cents').notNull(),   // + = out of account, - = in
  direction:                varchar('direction', { length: 8 }).notNull(), // out | in
  isoCurrency:              varchar('iso_currency', { length: 8 }),
  txnDate:                  date('txn_date').notNull(),
  authorizedDate:           date('authorized_date'),
  pending:                  boolean('pending').notNull().default(false),
  name:                     text('name'),
  merchantName:             text('merchant_name'),
  paymentChannel:           varchar('payment_channel', { length: 24 }),
  pfcPrimary:               varchar('pfc_primary', { length: 48 }),
  pfcDetailed:              varchar('pfc_detailed', { length: 96 }),
  pfcConfidence:            varchar('pfc_confidence', { length: 24 }),
  categoryLegacy:           jsonb('category_legacy'),
  txnClass:                 varchar('txn_class', { length: 24 }).notNull().default('unclassified'),
  isExpense:                boolean('is_expense').notNull().default(false),
  isCashMovement:           boolean('is_cash_movement').notNull().default(false),
  classConfidence:          varchar('class_confidence', { length: 12 }).notNull().default('rule'),
  classEvidence:            text('class_evidence'),
  removed:                  boolean('removed').notNull().default(false),
  raw:                      jsonb('raw'),
  asOf:                     timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
  createdAt:                timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:                timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('fin_tx_finacct_idx').on(t.finAccountId), index('fin_tx_date_idx').on(t.txnDate), index('fin_tx_class_idx').on(t.txnClass)])

// Money EXPECTED to arrive before it lands in Plaid, with a confidence level. NEVER added to strict
// Safe-to-Spend — only to the forecast/scenario layer. Derived rows are regenerated; manual rows persist.
export const finExpectedInflows = pgTable('fin_expected_inflows', {
  id:              uuid('id').primaryKey().defaultRandom(),
  source:          varchar('source', { length: 24 }).notNull(),        // dealer_weekly|card_baseline|retail_job|manual
  label:           varchar('label', { length: 200 }).notNull(),
  amountCents:     integer('amount_cents').notNull(),
  expectedDate:    date('expected_date').notNull(),
  confidence:      varchar('confidence', { length: 16 }).notNull(),     // high|probable|pipeline
  reliabilityBps:  integer('reliability_bps'),
  refType:         varchar('ref_type', { length: 24 }),                 // service_order|qb_invoice|dealer|pattern
  refId:           varchar('ref_id', { length: 100 }),
  evidence:        jsonb('evidence'),
  status:          varchar('status', { length: 16 }).notNull().default('projected'), // projected|confirmed|received|dismissed
  derived:         boolean('derived').notNull().default(true),
  dedupeKey:       varchar('dedupe_key', { length: 160 }),
  enteredBy:       varchar('entered_by', { length: 200 }),
  notes:           text('notes'),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('fin_expected_inflows_date_idx').on(t.expectedDate)])

// Append-only audit for manual finance edits.
export const finEvents = pgTable('fin_events', {
  id:        uuid('id').primaryKey().defaultRandom(),
  actor:     varchar('actor', { length: 200 }),
  action:    varchar('action', { length: 60 }).notNull(),
  entity:    varchar('entity', { length: 40 }),
  entityId:  varchar('entity_id', { length: 64 }),
  before:    jsonb('before'),
  after:     jsonb('after'),
  source:    varchar('source', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
