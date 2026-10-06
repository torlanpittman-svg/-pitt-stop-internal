/**
 * Settings accessor. Resolution order per key: DB row → env fallback → hard default,
 * so nothing is hard-coded into calculation logic and env still works if a row is
 * missing. getBusinessConfig() returns the resolved fee/tax rules the estimate layer
 * uses. Values are stored typed (jsonb) so the DB already returns JS number/boolean.
 */
import { getDb } from '@/platform/db'
import { eq } from 'drizzle-orm'
import { appSettings } from './schema'

export type SettingType = 'int' | 'bool' | 'string' | 'json'
export interface SettingDef { key: string; type: SettingType; def: number | boolean | string; env?: string }

// The registry of known settings. Add a line here (no new table) to introduce one.
export const SETTINGS: Record<string, SettingDef> = {
  shop_supplies_enabled:   { key: 'shop_supplies_enabled',   type: 'bool', def: true,  env: 'SHOP_SUPPLIES_ENABLED' },
  shop_supplies_bps:       { key: 'shop_supplies_bps',       type: 'int',  def: 300,   env: 'SHOP_SUPPLIES_BPS' },
  shop_supplies_cap_cents: { key: 'shop_supplies_cap_cents', type: 'int',  def: 2000,  env: 'SHOP_SUPPLIES_CAP_CENTS' },
  // card_fee_* superseded by payment_charge_* below (P-D1). Old rows, if any, are inert.
  default_tax_bps:         { key: 'default_tax_bps',         type: 'int',  def: 825,   env: 'ESTIMATE_DEFAULT_TAX_BPS' },
  qe_nl_enabled:           { key: 'qe_nl_enabled',           type: 'bool', def: false, env: 'QE_NL_ENABLED' },
  qe_voice_enabled:        { key: 'qe_voice_enabled',        type: 'bool', def: false, env: 'QE_VOICE_ENABLED' },
  // Configurable payment charge (card). Label + basis + applicability are NOT hard-coded.
  // Default ON for RETAIL (most customers pay by card); the engine forces it OFF for dealer
  // Jobs. Final customer-facing label + surcharge/"cash discount" compliance need CPA/processor
  // sign-off before automated QuickBooks invoicing.
  payment_charge_enabled:  { key: 'payment_charge_enabled',  type: 'bool',   def: true,               env: 'PAYMENT_CHARGE_ENABLED' },
  payment_charge_bps:      { key: 'payment_charge_bps',      type: 'int',    def: 300,                env: 'PAYMENT_CHARGE_BPS' },
  payment_charge_label:    { key: 'payment_charge_label',    type: 'string', def: 'Card Payment',     env: 'PAYMENT_CHARGE_LABEL' },
  payment_charge_basis:    { key: 'payment_charge_basis',    type: 'string', def: 'work_plus_supplies', env: 'PAYMENT_CHARGE_BASIS' }, // work_only | work_plus_supplies | grand_pretax
  // Shop-supplies line label on the QuickBooks invoice (configurable, matches historical).
  shop_supplies_label:     { key: 'shop_supplies_label',     type: 'string', def: 'Shop supplies',    env: 'SHOP_SUPPLIES_LABEL' },
  // P-D3.1 kill-switch for retail QuickBooks invoice CREATE. Default OFF — no retail QB
  // write happens (and the Create button is hidden) until explicitly enabled.
  retail_qb_enabled:       { key: 'retail_qb_enabled',       type: 'bool',   def: false,              env: 'RETAIL_QB_ENABLED' },
  // P-D3.2 kill-switch for retail QuickBooks invoice SEND (email to customer). Separate from
  // create; default OFF — the Send button is hidden and no email is sent until enabled.
  retail_qb_send_enabled:  { key: 'retail_qb_send_enabled',  type: 'bool',   def: false,              env: 'RETAIL_QB_SEND_ENABLED' },
  // Phase A: post-Finish Completion Summary / billing handoff screen (manager/admin, retail).
  // Default OFF — Finish Job keeps its current redirect until enabled. This flag only controls
  // whether the summary appears; it performs NO QuickBooks write and does NOT gate completion.
  completion_invoice_enabled: { key: 'completion_invoice_enabled', type: 'bool', def: false,          env: 'COMPLETION_INVOICE_ENABLED' },
  // Phase C: retail QuickBooks invoice UPDATE/SYNC (push Pitt Stop changes onto the SAME linked
  // invoice). Default OFF. Requires retail_qb_enabled=true as a prerequisite. Independent
  // kill-switch from Create and Send — Sync never sends.
  retail_qb_sync_enabled:  { key: 'retail_qb_sync_enabled',  type: 'bool',   def: false,              env: 'RETAIL_QB_SYNC_ENABLED' },
  // CFO Financial Command Center (Phase 1). Default OFF — /admin/finance ships dark. Read-only
  // toward QuickBooks; admin-only; no money movement.
  finance_enabled:         { key: 'finance_enabled',         type: 'bool',   def: false,              env: 'FINANCE_ENABLED' },
  // CFO reserve policy — intentionally UNCONFIGURED at $0 until the owner sets a real policy.
  // reserves_configured stays false so Safe-to-Spend discloses that the buffer is not yet trustworthy.
  reserves_configured:        { key: 'reserves_configured',        type: 'bool', def: false, env: 'RESERVES_CONFIGURED' },
  payroll_reserve_cents:      { key: 'payroll_reserve_cents',      type: 'int',  def: 0,     env: 'PAYROLL_RESERVE_CENTS' },
  tax_reserve_cents:          { key: 'tax_reserve_cents',          type: 'int',  def: 0,     env: 'TAX_RESERVE_CENTS' },
  min_operating_buffer_cents: { key: 'min_operating_buffer_cents', type: 'int',  def: 0,     env: 'MIN_OPERATING_BUFFER_CENTS' },
  // Auto-Sales Vehicle Financial System (B0). Default OFF — /admin/auto-sales ships dark; admin-only;
  // no money movement. Cutover: from this date, go-forward vehicle-level capture is expected complete;
  // anything earlier may be historically incomplete (kept clearly separated).
  auto_sales_enabled:         { key: 'auto_sales_enabled',         type: 'bool',   def: false,        env: 'AUTO_SALES_ENABLED' },
  auto_sales_cutover_date:    { key: 'auto_sales_cutover_date',    type: 'string', def: '2026-08-27', env: 'AUTO_SALES_CUTOVER_DATE' },
  // Write-a-Check (physical business checks → QuickBooks Purchase/Check + Brother printer).
  // Ships DARK. checks_enabled must be turned on AND the bank/expense accounts configured (owner picks
  // the real QBO accounts via the setup screen — never guessed) before any real check can be recorded.
  checks_enabled:             { key: 'checks_enabled',             type: 'bool',   def: false,        env: 'CHECKS_ENABLED' },
  // QBO Bank Account.Id money is drawn from, per bank. Empty until the owner confirms via setup.
  // (Operating is American Momentum *2649; lead: QBO Account.Id 31 — CONFIRM, do not assume.)
  check_operating_bank_qbo_id:  { key: 'check_operating_bank_qbo_id',  type: 'string', def: '', env: 'CHECK_OPERATING_BANK_QBO_ID' },
  check_operating_bank_label:   { key: 'check_operating_bank_label',   type: 'string', def: 'Pitt Stop Operating *2649', env: 'CHECK_OPERATING_BANK_LABEL' },
  check_autosales_bank_qbo_id:  { key: 'check_autosales_bank_qbo_id',  type: 'string', def: '', env: 'CHECK_AUTOSALES_BANK_QBO_ID' },
  check_autosales_bank_label:   { key: 'check_autosales_bank_label',   type: 'string', def: 'Auto Sales *5600', env: 'CHECK_AUTOSALES_BANK_LABEL' },
  // business-category -> QBO expense Account.Id map, e.g. {"shop_general":"7","equipment":"12"}. JSON string.
  check_category_accounts:      { key: 'check_category_accounts',      type: 'json',   def: '{}', env: 'CHECK_CATEGORY_ACCOUNTS' },
  // Saved print calibration (position + global offset + optional per-field overrides). JSON string.
  check_layout:                 { key: 'check_layout',                 type: 'json',   def: '{}', env: 'CHECK_LAYOUT' },
  // Stock template. 'blank_full' = genuinely blank stock (Blue Summit BSS): we draw the whole check
  // face (labels/lines/company/bank blocks + MICR). 'preprinted' = only fill values onto pre-printed
  // stock. Blue Summit blank stock ⇒ blank_full.
  check_template:               { key: 'check_template',               type: 'string', def: 'blank_full', env: 'CHECK_TEMPLATE' },
  // NON-SENSITIVE check-face text (safe to store): appears printed on the check. NOT routing/account.
  check_company_name:           { key: 'check_company_name',           type: 'string', def: 'Pitt Stop Detail & Auto Sales', env: 'CHECK_COMPANY_NAME' },
  check_company_addr:           { key: 'check_company_addr',           type: 'string', def: '', env: 'CHECK_COMPANY_ADDR' },
  check_bank_name:              { key: 'check_bank_name',              type: 'string', def: 'American Momentum Bank', env: 'CHECK_BANK_NAME' },
  check_bank_addr:              { key: 'check_bank_addr',              type: 'string', def: '', env: 'CHECK_BANK_ADDR' },
  // MICR kill-switch. Default OFF. A negotiable MICR line prints ONLY when this is on AND the SECRET
  // routing/account are present in SERVER-ONLY env (MICR_ROUTING / MICR_ACCOUNT — never stored here,
  // never returned to a client, never logged) AND a licensed E-13B font is installed. TEST/VOID never
  // print MICR. See apps/checks/micr.ts.
  micr_enabled:                 { key: 'micr_enabled',                 type: 'bool',   def: false, env: 'MICR_ENABLED' },
  // NON-SENSITIVE MICR geometry (safe): y position of the MICR band + left start, inches. Field ORDER
  // and the actual numbers come from micr.ts (secure). Tuned during calibration against the bank spec.
  micr_layout:                  { key: 'micr_layout',                  type: 'json',   def: '{}', env: 'MICR_LAYOUT' },
  // Marketing Agent V1. Ships DARK: the home tile + /marketing render only when enabled, and even then
  // every external send stays dry-run until a provider is configured (apps/marketing/providers). These
  // are operational toggles only — durable brand knowledge lives in apps/marketing/profile.ts.
  marketing_enabled:            { key: 'marketing_enabled',            type: 'bool',   def: false, env: 'MARKETING_ENABLED' },
  // Require a manager-approved (Ready) campaign before any send. Default ON — do not relax lightly.
  marketing_require_approval:   { key: 'marketing_require_approval',   type: 'bool',   def: true,  env: 'MARKETING_REQUIRE_APPROVAL' },
  // Safety cap on recipients processed per send (belt-and-suspenders against an accidental mass blast).
  marketing_send_daily_cap:     { key: 'marketing_send_daily_cap',     type: 'int',    def: 500,   env: 'MARKETING_SEND_DAILY_CAP' },
  // Attribution lookback window (days) for crediting a marketing touch to a completed job.
  marketing_attribution_window_days: { key: 'marketing_attribution_window_days', type: 'int', def: 30, env: 'MARKETING_ATTRIBUTION_WINDOW_DAYS' },
  // Lifetime-revenue threshold (cents) for the "high value" segment.
  marketing_high_value_cents:   { key: 'marketing_high_value_cents',   type: 'int',    def: 100000, env: 'MARKETING_HIGH_VALUE_CENTS' },
  // Default approved offer text (blank = no standing offer; AI never invents one).
  marketing_default_offer:      { key: 'marketing_default_offer',      type: 'string', def: '',    env: 'MARKETING_DEFAULT_OFFER' },
  // A2P 10DLC SMS identity + disclosures (shown in opt-in UI and appended to outbound SMS). URLs must
  // be REAL public pages — never invented. Blank privacy/terms URLs are a blocking A2P requirement.
  marketing_sms_brand_name:     { key: 'marketing_sms_brand_name',     type: 'string', def: 'Pitt Stop Detail', env: 'MARKETING_SMS_BRAND_NAME' },
  marketing_sms_help_text:      { key: 'marketing_sms_help_text',      type: 'string', def: 'Reply HELP for help. Msg & data rates may apply.', env: 'MARKETING_SMS_HELP_TEXT' },
  marketing_sms_frequency:      { key: 'marketing_sms_frequency',      type: 'string', def: 'Msg frequency varies (about 1–2/month).', env: 'MARKETING_SMS_FREQUENCY' },
  marketing_privacy_url:        { key: 'marketing_privacy_url',        type: 'string', def: '',    env: 'MARKETING_PRIVACY_URL' },
  marketing_terms_url:          { key: 'marketing_terms_url',          type: 'string', def: '',    env: 'MARKETING_TERMS_URL' },
  // Twilio SMS send (Phase 4). Default OFF — campaigns stay dry-run until this is on AND Twilio
  // Messaging Service credentials are present in server env.
  marketing_sms_live:           { key: 'marketing_sms_live',           type: 'bool',   def: false, env: 'MARKETING_SMS_LIVE' },
  // Quiet hours (local) — promotional SMS is blocked outside [start,end). TCPA-friendly default 9–20.
  marketing_sms_quiet_start_hour: { key: 'marketing_sms_quiet_start_hour', type: 'int', def: 9,  env: 'MARKETING_SMS_QUIET_START_HOUR' },
  marketing_sms_quiet_end_hour:   { key: 'marketing_sms_quiet_end_hour',   type: 'int', def: 20, env: 'MARKETING_SMS_QUIET_END_HOUR' },
  // Global per-run SMS safety cap (hard ceiling on messages a single send will process).
  marketing_sms_global_cap:     { key: 'marketing_sms_global_cap',     type: 'int',    def: 250,   env: 'MARKETING_SMS_GLOBAL_CAP' },
  // PUBLIC customer-facing base URL where opt-in/privacy/terms are published (e.g. the business
  // website/domain). Drives every customer-facing + A2P URL. Blank ⇒ readiness flags it; NEVER guessed.
  marketing_public_base_url:    { key: 'marketing_public_base_url',    type: 'string', def: '',    env: 'MARKETING_PUBLIC_BASE_URL' },
  // A2P brand identity (used only in the manager A2P packet; EIN is NOT stored here — keep it in Twilio).
  marketing_legal_name:         { key: 'marketing_legal_name',         type: 'string', def: 'Pitt Stop Detail & Auto Sales', env: 'MARKETING_LEGAL_NAME' },
  marketing_business_website:   { key: 'marketing_business_website',   type: 'string', def: '',    env: 'MARKETING_BUSINESS_WEBSITE' },
  marketing_support_contact:    { key: 'marketing_support_contact',    type: 'string', def: '',    env: 'MARKETING_SUPPORT_CONTACT' },
  // External/manual A2P readiness confirmations — env credentials ALONE never mean "ready to send".
  // A manager flips these only after the real external steps are verified. All default false.
  marketing_a2p_brand_approved:    { key: 'marketing_a2p_brand_approved',    type: 'bool', def: false, env: 'MARKETING_A2P_BRAND_APPROVED' },
  marketing_a2p_campaign_approved: { key: 'marketing_a2p_campaign_approved', type: 'bool', def: false, env: 'MARKETING_A2P_CAMPAIGN_APPROVED' },
  marketing_advanced_optout_configured: { key: 'marketing_advanced_optout_configured', type: 'bool', def: false, env: 'MARKETING_ADVANCED_OPTOUT_CONFIGURED' },
  marketing_privacy_published:     { key: 'marketing_privacy_published',     type: 'bool', def: false, env: 'MARKETING_PRIVACY_PUBLISHED' },
  marketing_terms_published:       { key: 'marketing_terms_published',       type: 'bool', def: false, env: 'MARKETING_TERMS_PUBLISHED' },
}

function coerce(type: SettingType, raw: unknown): number | boolean | string {
  if (type === 'bool') return raw === true || raw === 'true' || raw === 1 || raw === '1'
  if (type === 'int')  { const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10); return Number.isFinite(n) ? n : 0 }
  if (type === 'json') return raw as string
  return String(raw)
}

function resolve(def: SettingDef, dbValue: unknown | undefined): number | boolean | string {
  if (dbValue !== undefined && dbValue !== null) return coerce(def.type, dbValue)
  if (def.env && process.env[def.env] != null) return coerce(def.type, process.env[def.env])
  return def.def
}

export interface BusinessConfig {
  shopSuppliesEnabled: boolean
  shopSuppliesBps: number
  shopSuppliesCapCents: number
  paymentEnabled: boolean
  paymentBps: number
  paymentLabel: string
  paymentBasis: string   // work_only | work_plus_supplies | grand_pretax
  defaultTaxBps: number
}

/** Resolve all business rules the estimate/fee engine needs (one DB read). */
export async function getBusinessConfig(): Promise<BusinessConfig> {
  const rows = await getDb().select().from(appSettings)
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const g = (k: keyof typeof SETTINGS) => resolve(SETTINGS[k], map.get(k))
  return {
    shopSuppliesEnabled:  g('shop_supplies_enabled') as boolean,
    shopSuppliesBps:      g('shop_supplies_bps') as number,
    shopSuppliesCapCents: g('shop_supplies_cap_cents') as number,
    paymentEnabled:       g('payment_charge_enabled') as boolean,
    paymentBps:           g('payment_charge_bps') as number,
    paymentLabel:         g('payment_charge_label') as string,
    paymentBasis:         g('payment_charge_basis') as string,
    defaultTaxBps:        g('default_tax_bps') as number,
  }
}

/** Public reads for the Quick Entry intake flags. Voice only shows when NL is also on. */
export async function nlEnabled(): Promise<boolean> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'qe_nl_enabled'))
  return resolve(SETTINGS.qe_nl_enabled, rows[0]?.value) as boolean
}
export async function voiceEnabled(): Promise<boolean> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'qe_voice_enabled'))
  return resolve(SETTINGS.qe_voice_enabled, rows[0]?.value) as boolean
}
/** Retail QuickBooks invoicing kill-switch (P-D3.1). Default OFF. */
export async function retailQbEnabled(): Promise<boolean> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'retail_qb_enabled'))
  return resolve(SETTINGS.retail_qb_enabled, rows[0]?.value) as boolean
}
/** Retail QuickBooks SEND kill-switch (P-D3.2). Default OFF. */
export async function retailQbSendEnabled(): Promise<boolean> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'retail_qb_send_enabled'))
  return resolve(SETTINGS.retail_qb_send_enabled, rows[0]?.value) as boolean
}
/** Completion Summary / billing-handoff screen kill-switch (Phase A). Default OFF. */
export async function completionInvoiceEnabled(): Promise<boolean> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'completion_invoice_enabled'))
  return resolve(SETTINGS.completion_invoice_enabled, rows[0]?.value) as boolean
}
/** Retail QuickBooks UPDATE/SYNC kill-switch (Phase C). Default OFF. Requires retail_qb_enabled. */
export async function retailQbSyncEnabled(): Promise<boolean> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'retail_qb_sync_enabled'))
  return resolve(SETTINGS.retail_qb_sync_enabled, rows[0]?.value) as boolean
}
/** CFO Financial Command Center kill-switch (Phase 1). Default OFF. */
export async function financeEnabled(): Promise<boolean> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'finance_enabled'))
  return resolve(SETTINGS.finance_enabled, rows[0]?.value) as boolean
}
export async function autoSalesEnabled(): Promise<boolean> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'auto_sales_enabled'))
  return resolve(SETTINGS.auto_sales_enabled, rows[0]?.value) as boolean
}
export async function autoSalesCutoverDate(): Promise<string> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'auto_sales_cutover_date'))
  return resolve(SETTINGS.auto_sales_cutover_date, rows[0]?.value) as string
}
/** CFO reserve policy. `configured` is false until the owner sets a real policy — Safe-to-Spend
 *  discloses that until then. All amounts default to $0 (not an assertion that $0 is correct). */
export interface ReservePolicy { configured: boolean; payrollReserveCents: number; taxReserveCents: number; minBufferCents: number; totalCents: number }
export async function getReservePolicy(): Promise<ReservePolicy> {
  const rows = await getDb().select().from(appSettings)
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const g = (k: keyof typeof SETTINGS) => resolve(SETTINGS[k], map.get(k))
  const payroll = g('payroll_reserve_cents') as number, tax = g('tax_reserve_cents') as number, buf = g('min_operating_buffer_cents') as number
  return { configured: g('reserves_configured') as boolean, payrollReserveCents: payroll, taxReserveCents: tax, minBufferCents: buf, totalCents: payroll + tax + buf }
}

/** Configurable shop-supplies invoice label. */
export async function shopSuppliesLabel(): Promise<string> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'shop_supplies_label'))
  return resolve(SETTINGS.shop_supplies_label, rows[0]?.value) as string
}

export type SettingView = { key: string; value: unknown; type: string; category: string | null; label: string | null; description: string | null }

/** All settings for the admin page (registry order, DB/env/default resolved). */
export async function getAllSettings(): Promise<SettingView[]> {
  const rows = await getDb().select().from(appSettings)
  const byKey = new Map(rows.map((r) => [r.key, r]))
  return Object.values(SETTINGS).map((def) => {
    const row = byKey.get(def.key)
    return {
      key: def.key,
      value: resolve(def, row?.value),
      type: def.type,
      category: row?.category ?? null,
      label: row?.label ?? def.key,
      description: row?.description ?? null,
    }
  })
}

/** Marketing Agent V1 feature flag (default OFF). */
export async function marketingEnabled(): Promise<boolean> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'marketing_enabled'))
  return resolve(SETTINGS.marketing_enabled, rows[0]?.value) as boolean
}

export interface MarketingConfig {
  enabled: boolean
  requireApproval: boolean
  sendDailyCap: number
  attributionWindowDays: number
  highValueCents: number
  defaultOffer: string
  // A2P / SMS
  smsLive: boolean
  smsBrandName: string
  smsHelpText: string
  smsFrequency: string
  privacyUrl: string
  termsUrl: string
  smsQuietStartHour: number
  smsQuietEndHour: number
  smsGlobalCap: number
  publicBaseUrl: string
  legalName: string
  businessWebsite: string
  supportContact: string
  a2pBrandApproved: boolean
  a2pCampaignApproved: boolean
  advancedOptOutConfigured: boolean
  privacyPublished: boolean
  termsPublished: boolean
}

/** Resolve the marketing operational config in one DB read. */
export async function getMarketingConfig(): Promise<MarketingConfig> {
  const rows = await getDb().select().from(appSettings)
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const g = (k: keyof typeof SETTINGS) => resolve(SETTINGS[k], map.get(k))
  return {
    enabled:               g('marketing_enabled') as boolean,
    requireApproval:       g('marketing_require_approval') as boolean,
    sendDailyCap:          g('marketing_send_daily_cap') as number,
    attributionWindowDays: g('marketing_attribution_window_days') as number,
    highValueCents:        g('marketing_high_value_cents') as number,
    defaultOffer:          g('marketing_default_offer') as string,
    smsLive:               g('marketing_sms_live') as boolean,
    smsBrandName:          g('marketing_sms_brand_name') as string,
    smsHelpText:           g('marketing_sms_help_text') as string,
    smsFrequency:          g('marketing_sms_frequency') as string,
    privacyUrl:            g('marketing_privacy_url') as string,
    termsUrl:              g('marketing_terms_url') as string,
    smsQuietStartHour:     g('marketing_sms_quiet_start_hour') as number,
    smsQuietEndHour:       g('marketing_sms_quiet_end_hour') as number,
    smsGlobalCap:          g('marketing_sms_global_cap') as number,
    publicBaseUrl:         g('marketing_public_base_url') as string,
    legalName:             g('marketing_legal_name') as string,
    businessWebsite:       g('marketing_business_website') as string,
    supportContact:        g('marketing_support_contact') as string,
    a2pBrandApproved:      g('marketing_a2p_brand_approved') as boolean,
    a2pCampaignApproved:   g('marketing_a2p_campaign_approved') as boolean,
    advancedOptOutConfigured: g('marketing_advanced_optout_configured') as boolean,
    privacyPublished:      g('marketing_privacy_published') as boolean,
    termsPublished:        g('marketing_terms_published') as boolean,
  }
}

/** Upsert one setting (admin edit). Coerces to the registry type. Rejects unknown keys. */
export async function updateSetting(key: string, rawValue: unknown, actor: string | null): Promise<void> {
  const def = SETTINGS[key]
  if (!def) throw new Error(`Unknown setting: ${key}`)
  const value = coerce(def.type, rawValue)
  const db = getDb()
  const existing = await db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, key)).limit(1)
  if (existing[0]) {
    await db.update(appSettings).set({ value, type: def.type, updatedBy: actor, updatedAt: new Date() }).where(eq(appSettings.key, key))
  } else {
    await db.insert(appSettings).values({ key, value, type: def.type, category: 'fees', updatedBy: actor })
  }
}
