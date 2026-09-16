/**
 * ISOLATED MICR calibration write path — the ONLY sanctioned way to change the `micr_layout` setting.
 *
 * WHY THIS EXISTS: `micr_layout` holds the MICR band coordinates (baseline height, horizontal anchor,
 * pitch, size). It is deliberately SEPARATE from `check_layout` (the locked non-MICR geometry) so MICR
 * calibration can never move the payee/date/amount/memo/signature/boundary/voucher. This module enforces
 * that separation at the write boundary:
 *
 *   - ONLY the five MICR coordinate fields may be written (ALLOWED_MICR_FIELDS). Any other key — including
 *     non-MICR geometry (offsetX/offsetY/sectionHeightIn/position/fields/perField) or the micr_enabled
 *     kill-switch — is REJECTED before any write. Non-MICR geometry cannot be touched here.
 *   - Each value is range-validated (finite, within safe bounds) — garbage is rejected, not silently
 *     coerced.
 *   - An explicit human `reason` is REQUIRED and every change is recorded append-only (who / when /
 *     old / new) in micr_layout_audit.
 *   - This path NEVER enables MICR, creates a check or QuickBooks transaction, or consumes / advances a
 *     check number. It writes exactly one setting (`micr_layout`) + one audit row. Negotiable printing
 *     stays fail-closed (still gated by micr_enabled + secure routing/account + installed E-13B font).
 */
import { getDb } from '@/platform/db'
import { desc, eq } from 'drizzle-orm'
import { updateSetting } from '@/apps/settings/db'
import { appSettings } from '@/apps/settings/schema'
import { micrLayoutAudit } from './schema'
import { micrGeom, micrPlacement, DEFAULT_MICR_GEOM, PAGE_WIDTH_IN, CHECK_SECTION_HEIGHT_IN, type MicrGeom } from './layout'

/** The MICR-only coordinate fields (mirror of MicrGeom). NOTHING else may be written to micr_layout. */
export const ALLOWED_MICR_FIELDS = ['baselineFromBottomIn', 'rightMarginIn', 'amountFieldIn', 'pitchIn', 'sizePt'] as const
export type MicrField = (typeof ALLOWED_MICR_FIELDS)[number]

/** Safe bounds per field (inches / points). Rejects out-of-range values rather than coercing them. */
const BOUNDS: Record<MicrField, { min: number; max: number; label: string }> = {
  // baseline must sit within the bottom clear band and never above the perforation; standards put it at
  // 3/16" (0.1875"). Allow calibration latitude but keep it physically inside the band.
  baselineFromBottomIn: { min: 0.03125, max: 0.5, label: 'baseline distance above the bottom edge (in)' },
  rightMarginIn:        { min: 0,       max: 2,   label: 'right-edge inset (in)' },
  amountFieldIn:        { min: 0,       max: 3,   label: 'blank Amount field width (in)' },
  pitchIn:              { min: 0.05,    max: 0.2, label: 'character pitch (in; 8 CPI = 0.125)' },
  sizePt:               { min: 6,       max: 14,  label: 'E-13B point size' },
}

// Keys that are explicitly NON-MICR geometry — named so a caller who mistakenly sends them gets a clear,
// specific rejection (rather than a generic "unknown key").
const NON_MICR_GEOMETRY_KEYS = new Set(['offsetX', 'offsetY', 'sectionHeightIn', 'position', 'fields', 'perField'])

export class MicrConfigError extends Error {
  constructor(message: string, public code: string) { super(message); this.name = 'MicrConfigError' }
}

export interface ValidatedMicrLayout { [k: string]: number }

/**
 * Validate a proposed MICR-layout patch. Accepts ONLY the allowed MICR coordinate fields, each a finite
 * number within bounds. Throws MicrConfigError on any non-MICR key, the micr_enabled kill-switch, an
 * unknown key, or an out-of-range/garbage value. Returns the cleaned patch (only recognised fields).
 */
export function validateMicrLayoutPatch(input: unknown): ValidatedMicrLayout {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MicrConfigError('MICR layout must be an object of coordinate fields.', 'invalid_body')
  }
  const obj = input as Record<string, unknown>
  const allowed = new Set<string>(ALLOWED_MICR_FIELDS)
  const clean: ValidatedMicrLayout = {}
  for (const [key, raw] of Object.entries(obj)) {
    if (key === 'micr_enabled' || key === 'enabled' || key === 'micrEnabled') {
      throw new MicrConfigError('This endpoint never enables MICR. Remove the enable flag.', 'enable_not_allowed')
    }
    if (NON_MICR_GEOMETRY_KEYS.has(key)) {
      throw new MicrConfigError(`"${key}" is NON-MICR check geometry and cannot be changed here (it lives in check_layout, which is locked).`, 'non_micr_field')
    }
    if (!allowed.has(key)) {
      throw new MicrConfigError(`Unknown MICR field "${key}". Allowed: ${ALLOWED_MICR_FIELDS.join(', ')}.`, 'unknown_field')
    }
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) throw new MicrConfigError(`"${key}" must be a finite number.`, 'not_a_number')
    const b = BOUNDS[key as MicrField]
    if (n < b.min || n > b.max) throw new MicrConfigError(`"${key}" (${b.label}) must be between ${b.min} and ${b.max}. Got ${n}.`, 'out_of_range')
    clean[key] = n
  }
  if (Object.keys(clean).length === 0) throw new MicrConfigError('No MICR coordinate fields supplied.', 'empty_patch')
  return clean
}

async function readRawMicrLayout(): Promise<Record<string, unknown>> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, 'micr_layout')).limit(1)
  const v = rows[0]?.value
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {} } catch { return {} } }
  return {}
}

export interface MicrLayoutStatus {
  stored: Record<string, unknown>       // raw micr_layout override currently saved (defaults applied on read)
  resolved: MicrGeom                    // effective MICR geometry (defaults merged)
  defaults: MicrGeom
  allowedFields: readonly string[]
  placement: { baselineYInFromTop: number; abovePerforationIn: number; rightAnchorXIn: number; pitchIn: number; sizePt: number }
  // fail-closed disclosure — MASKS ONLY are handled elsewhere; here we just report the toggle is untouched.
  micrEnabledUntouched: true
}

/** Read the current MICR layout + the effective resolved geometry + standards-based placement preview. */
export async function getMicrLayoutStatus(): Promise<MicrLayoutStatus> {
  const stored = await readRawMicrLayout()
  const resolved = micrGeom(stored as Partial<MicrGeom>)
  const pl = micrPlacement(CHECK_SECTION_HEIGHT_IN, PAGE_WIDTH_IN, resolved)
  return {
    stored,
    resolved,
    defaults: DEFAULT_MICR_GEOM,
    allowedFields: ALLOWED_MICR_FIELDS,
    placement: {
      baselineYInFromTop: pl.baselineYIn,
      abovePerforationIn: CHECK_SECTION_HEIGHT_IN - pl.baselineYIn,
      rightAnchorXIn: pl.rightAnchorXIn,
      pitchIn: pl.pitchIn,
      sizePt: pl.sizePt,
    },
    micrEnabledUntouched: true,
  }
}

export interface MicrLayoutAuditRow { id: string; actor: string | null; reason: string; oldValue: unknown; newValue: unknown; createdAt: Date }

export async function recentMicrLayoutAudit(limit = 20): Promise<MicrLayoutAuditRow[]> {
  const rows = await getDb().select().from(micrLayoutAudit).orderBy(desc(micrLayoutAudit.createdAt)).limit(limit)
  return rows.map((r) => ({ id: r.id, actor: r.actor, reason: r.reason, oldValue: r.oldValue, newValue: r.newValue, createdAt: r.createdAt }))
}

export interface UpdateMicrLayoutResult { old: Record<string, unknown>; new: Record<string, unknown>; resolved: MicrGeom }

/**
 * The single sanctioned MICR-layout write. Validates the patch (MICR-only), MERGES it onto the current
 * stored override, records an append-only audit row (old/new/reason/actor), and writes ONLY the
 * `micr_layout` setting. Requires a non-empty reason. Touches nothing else — no check, no QBO, no number.
 */
export async function updateMicrLayout(params: { patch: unknown; reason: string; actor: string | null }): Promise<UpdateMicrLayoutResult> {
  const reason = (params.reason ?? '').trim()
  if (!reason) throw new MicrConfigError('An explicit reason is required to change MICR calibration.', 'reason_required')
  if (reason.length > 500) throw new MicrConfigError('Reason is too long (max 500 chars).', 'reason_too_long')

  const clean = validateMicrLayoutPatch(params.patch)   // throws on any non-MICR / invalid field
  const old = await readRawMicrLayout()
  // Merge: keep any previously-tuned MICR fields, apply the validated new ones on top.
  const next: Record<string, unknown> = { ...old, ...clean }

  // Persist ONLY micr_layout. updateSetting itself rejects any key not in the settings registry.
  await updateSetting('micr_layout', next, params.actor)
  // Append-only audit (never overwrites; safe to fail loudly if the table is missing → whole write aborts).
  await getDb().insert(micrLayoutAudit).values({ actor: params.actor, reason, oldValue: old, newValue: next })

  return { old, new: next, resolved: micrGeom(next as Partial<MicrGeom>) }
}
