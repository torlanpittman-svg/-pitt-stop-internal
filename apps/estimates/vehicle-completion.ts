/**
 * Completing a SAVED vehicle from a New Estimate intake.
 *
 * A returning customer's saved vehicle may have no year/make/model on file (or a year that is not 4 digits);
 * the Details step lets staff fill those in while keeping the same vehicle. This is the one rule for what
 * the intake records and what gets written back to that row:
 *   • every VALID saved field stays (year that is 4 digits, non-blank make/model) — the typed value never
 *     replaces details already on file (corrections go through the Job's Edit Vehicle, with its audit);
 *   • the VIN is never touched here;
 *   • only blank / invalid fields are filled. This module only decides WHETHER a write is needed (and what
 *     the intake records when nothing is): the write itself (see createIntake) re-derives the fill, the
 *     intake snapshot and the audit from the locked row at write time, so a concurrent correction is never
 *     overwritten and the audit never claims a fill the guard skipped.
 */
export type VehicleField = 'year' | 'make' | 'model'
export interface SavedVehicleLike { year?: string | null; make?: string | null; model?: string | null; vin?: string | null }
export interface TypedVehicle { year: string; make: string; model: string }
export interface VehicleCompletion {
  /** The vehicle as the estimate/intake should record it. */
  vehicle: { year: string | null; make: string | null; model: string | null; vin: string | null }
  /** Fields that were blank/invalid on file and are filled from the intake (empty = nothing to write). */
  filled: VehicleField[]
  old: Partial<Record<VehicleField, string | null>>
  new: Partial<Record<VehicleField, string>>
}

const FOUR_DIGITS = /^\d{4}$/
const validYear = (y: string | null | undefined) => FOUR_DIGITS.test((y ?? '').trim())
const present = (s: string | null | undefined) => !!(s ?? '').trim()

export function completeSavedVehicle(saved: SavedVehicleLike, typed: TypedVehicle): VehicleCompletion {
  const out: VehicleCompletion = { vehicle: { year: saved.year ?? null, make: saved.make ?? null, model: saved.model ?? null, vin: saved.vin ?? null }, filled: [], old: {}, new: {} }
  const fill = (f: VehicleField, ok: boolean) => {
    const typedValue = typed[f].trim()
    if (ok || !typedValue) return
    out.filled.push(f); out.old[f] = saved[f] ?? null; out.new[f] = typedValue; out.vehicle[f] = typedValue
  }
  fill('year', validYear(saved.year))
  fill('make', present(saved.make))
  fill('model', present(saved.model))
  return out
}
