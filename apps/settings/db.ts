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
  card_fee_enabled:        { key: 'card_fee_enabled',        type: 'bool', def: false, env: 'CARD_FEE_ENABLED' },
  card_fee_bps:            { key: 'card_fee_bps',            type: 'int',  def: 300,   env: 'CARD_FEE_BPS' },
  default_tax_bps:         { key: 'default_tax_bps',         type: 'int',  def: 825,   env: 'ESTIMATE_DEFAULT_TAX_BPS' },
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
  cardFeeEnabled: boolean
  cardFeeBps: number
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
    cardFeeEnabled:       g('card_fee_enabled') as boolean,
    cardFeeBps:           g('card_fee_bps') as number,
    defaultTaxBps:        g('default_tax_bps') as number,
  }
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
