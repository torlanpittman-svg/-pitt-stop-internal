/**
 * Check-writing configuration, resolved from app_settings (DB → env → default, same convention as
 * apps/settings/db.ts). This is where the accounting mapping the everyday UI hides lives:
 *   - which QBO Bank Account each bank draws from (operating *2649 / auto_sales *5600)
 *   - which QBO expense Account each business-language category books to
 *   - the saved print calibration (position + offsets)
 *
 * Nothing here is guessed: bank + expense account ids are EMPTY until the owner selects the real QBO
 * accounts on the setup screen. `checkConfigReadiness()` reports exactly what is still missing so a real
 * check can never be recorded against an unconfigured/guessed account.
 */
import { getDb } from '@/platform/db'
import { appSettings } from '@/apps/settings/schema'
import { inArray } from 'drizzle-orm'
import { SETTINGS } from '@/apps/settings/db'
import { CHECK_CATEGORIES, categoryEntity, type BankKey, type CheckCategoryKey } from './types'
import { buildLayout, type CheckLayout, type MicrGeom } from './layout'

const KEYS = [
  'checks_enabled',
  'checks_live_enabled',
  'check_operating_bank_qbo_id', 'check_operating_bank_label',
  'check_autosales_bank_qbo_id', 'check_autosales_bank_label',
  'check_category_accounts', 'check_layout',
  'check_template', 'check_company_name', 'check_company_addr', 'check_bank_name', 'check_bank_addr',
  'micr_enabled', 'micr_layout',
] as const

function resolveRaw(key: string, dbVal: unknown): unknown {
  if (dbVal !== undefined && dbVal !== null) return dbVal
  const env = SETTINGS[key]?.env
  if (env && process.env[env] != null) return process.env[env]
  return SETTINGS[key]?.def
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {} } catch { return {} } }
  return {}
}

export interface BankConfig { key: BankKey; qboAccountId: string; label: string }
export interface CheckFaceDisplay { companyName: string; companyAddr: string | null; bankName: string; bankAddr: string | null }
export interface CheckConfig {
  enabled: boolean          // feature visible/usable (form + workflow render)
  liveEnabled: boolean      // OWNER authorization to record REAL checks (QB Purchase + consume a number).
                            // Default OFF: the workflow is fully walkable/testable, but the final
                            // "Record & Print" action is disabled until the owner flips this on (going live).
  banks: Record<BankKey, BankConfig>
  categoryAccounts: Record<string, string>   // categoryKey -> QBO expense Account.Id
  layout: CheckLayout
  templateMode: 'blank_full' | 'preprinted'   // Blue Summit blank stock ⇒ blank_full (we draw the face)
  display: CheckFaceDisplay                    // NON-SENSITIVE check-face text (never routing/account)
  micrEnabled: boolean                         // kill-switch; real MICR still requires secure env + font
}

export async function getCheckConfig(): Promise<CheckConfig> {
  const rows = await getDb().select().from(appSettings).where(inArray(appSettings.key, [...KEYS]))
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const g = (k: string) => resolveRaw(k, map.get(k))
  const str = (k: string, d = '') => { const v = g(k); return v == null ? d : String(v) }
  return {
    enabled: g('checks_enabled') === true || g('checks_enabled') === 'true',
    liveEnabled: g('checks_live_enabled') === true || g('checks_live_enabled') === 'true',
    banks: {
      operating:  { key: 'operating',  qboAccountId: String(g('check_operating_bank_qbo_id') ?? '').trim(),  label: String(g('check_operating_bank_label') ?? 'Operating') },
      auto_sales: { key: 'auto_sales', qboAccountId: String(g('check_autosales_bank_qbo_id') ?? '').trim(), label: String(g('check_autosales_bank_label') ?? 'Auto Sales') },
    },
    categoryAccounts: Object.fromEntries(Object.entries(asObject(g('check_category_accounts'))).map(([k, v]) => [k, String(v)])),
    // MICR geometry lives in its OWN setting (`micr_layout`) so MICR-only calibration never risks the
    // locked non-MICR fields in `check_layout`. Merge it in as the layout's `micr` override.
    layout: buildLayout({ ...(asObject(g('check_layout')) as Omit<Partial<CheckLayout>, 'micr'>), micr: asObject(g('micr_layout')) as Partial<MicrGeom> }),
    templateMode: str('check_template', 'blank_full') === 'preprinted' ? 'preprinted' : 'blank_full',
    display: {
      companyName: str('check_company_name', 'Pitt Stop Detail & Auto Sales'),
      companyAddr: str('check_company_addr') || null,
      bankName: str('check_bank_name', 'American Momentum Bank'),
      bankAddr: str('check_bank_addr') || null,
    },
    micrEnabled: g('micr_enabled') === true || g('micr_enabled') === 'true',
  }
}

/** The bank a category draws from (its CFO entity boundary). */
export function bankForCategory(cfg: CheckConfig, category: string): BankConfig {
  return cfg.banks[categoryEntity(category)]
}

export interface Readiness {
  ready: boolean            // enabled AND at least operating bank configured
  enabled: boolean
  operatingBankConfigured: boolean
  autoSalesBankConfigured: boolean
  missingCategoryAccounts: CheckCategoryKey[]  // categories with NO expense account mapped yet
}

/** What is still missing before a real check can be written. Used by the UI + guarded server-side. */
export function checkConfigReadiness(cfg: CheckConfig): Readiness {
  const missing = CHECK_CATEGORIES
    .map((c) => c.key)
    .filter((k) => !cfg.categoryAccounts[k]) as CheckCategoryKey[]
  return {
    ready: cfg.enabled && !!cfg.banks.operating.qboAccountId,
    enabled: cfg.enabled,
    operatingBankConfigured: !!cfg.banks.operating.qboAccountId,
    autoSalesBankConfigured: !!cfg.banks.auto_sales.qboAccountId,
    missingCategoryAccounts: missing,
  }
}
