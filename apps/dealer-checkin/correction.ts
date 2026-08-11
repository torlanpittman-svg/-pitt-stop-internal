/**
 * Vehicle-correction rules — pure, no I/O. Decides how a Job's vehicle edit maps to
 * the QuickBooks dealer invoice line, so a wrong OCR read (e.g. GMC 1300 → GMC 1500)
 * can be fixed on the Work Board without recreating the Job. Orchestration + writes
 * live in the API route; these functions are trivially unit-testable.
 */
import { formatLineDescription } from './rules'

export interface VehicleFields {
  year?: string | null
  make?: string | null
  model?: string | null
  vin?: string | null
  stockNumber?: string | null
}

/** The corrected QB line description ("YEAR MAKE MODEL COLOR #STOCK"); color is kept
 *  from the existing scan since it is not part of the edit form. */
export function correctedLineDescription(f: VehicleFields, color: string | null | undefined): string {
  return formatLineDescription({ year: f.year, make: f.make, model: f.model, color: color ?? null, stockNumber: f.stockNumber })
}

/** Human-readable field diff for the audit trail (only fields that actually changed). */
export function diffVehicle(oldF: VehicleFields, newF: VehicleFields): { changed: string[]; old: VehicleFields; new: VehicleFields } {
  const keys: (keyof VehicleFields)[] = ['year', 'make', 'model', 'vin', 'stockNumber']
  const norm = (v: unknown) => (v == null ? '' : String(v).trim())
  const changed = keys.filter((k) => norm(oldF[k]) !== norm(newF[k]))
  const pick = (src: VehicleFields): VehicleFields => Object.fromEntries(changed.map((k) => [k, src[k] ?? null])) as VehicleFields
  return { changed, old: pick(oldF), new: pick(newF) }
}

export type QbSyncAction = 'update' | 'not_linked' | 'no_change'

/**
 * Decide whether a correction should touch QuickBooks.
 *  - not_linked : no synced dealer invoice line to update (retail Job, queued/unwritten,
 *                 or missing qb_line_id / invoice number) → update Pitt Stop only.
 *  - no_change  : the QB line description is unchanged (e.g. only VIN edited) → skip QB.
 *  - update     : a synced line exists and its description changed → update that line.
 */
export function qbSyncDecision(params: {
  qbLineId: string | null | undefined
  qbInvoiceNumber: string | null | undefined
  qbSyncStatus: string | null | undefined
  oldDescription: string
  newDescription: string
}): QbSyncAction {
  const linked = !!params.qbLineId && !!params.qbInvoiceNumber && params.qbSyncStatus === 'synced'
  if (!linked) return 'not_linked'
  if (params.oldDescription.trim() === params.newDescription.trim()) return 'no_change'
  return 'update'
}
