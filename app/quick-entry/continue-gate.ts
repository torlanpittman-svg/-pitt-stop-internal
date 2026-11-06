/**
 * Quick Entry / New Estimate — Details step: what (if anything) stops "Continue →".
 *
 * ONE rule, shared by the screen (to name the field) and the button (to decide). Nothing here loosens
 * the existing requirements; it only makes them visible. Before this, the button was simply disabled
 * with no reason on screen — an employee with every field visibly filled could still be stuck, e.g. on
 * a year typed as "2019 " (phone keyboards add a space after a suggestion) or on a saved vehicle whose
 * year/make/model were never recorded (those inputs are hidden for a saved vehicle).
 *
 * Requirements (unchanged): first name; no VIN read in flight; a saved vehicle chosen (or "new") when
 * the returning customer has several; and for an ESTIMATE a 4-digit year, a make and a model — the
 * standalone-estimate API rejects anything else (apps/estimates/db.ts intakeInput).
 */
export type VehicleMode = 'new' | 'existing' | 'pick'
export type BlockerField = 'first' | 'vin' | 'vehicle' | 'year' | 'make' | 'model'
export interface Blocker { field: BlockerField; message: string }

export interface DetailsState {
  isEstimate: boolean
  first: string
  vinBusy: boolean
  vehicleMode: VehicleMode
  /** Saved vehicles offered in "pick" mode (a restored draft can be in "pick" mode with none loaded). */
  pickCount: number
  year: string
  make: string
  model: string
}

export const isFourDigitYear = (year: string): boolean => /^\d{4}$/.test(year.trim())

/** The vehicle fields exactly as they should be submitted (surrounding whitespace never counts). */
export const normalizeVehicleText = <T extends { year: string; make: string; model: string }>(v: T): T =>
  ({ ...v, year: v.year.trim(), make: v.make.trim(), model: v.model.trim() })

export function continueBlockers(s: DetailsState): Blocker[] {
  const out: Blocker[] = []
  if (!s.first.trim()) out.push({ field: 'first', message: "Enter the customer's first name." })
  if (s.vinBusy) out.push({ field: 'vin', message: 'Still reading the VIN — give it a moment, or edit the VIN to stop the lookup.' })
  if (s.vehicleMode === 'pick') {
    out.push({ field: 'vehicle', message: s.pickCount > 0
      ? 'Choose which saved vehicle this is, or add a new vehicle.'
      : 'The saved-vehicle list is no longer available — tap "Add a new vehicle", or pick the customer again.' })
  }
  if (s.isEstimate && s.vehicleMode !== 'pick') {
    const saved = s.vehicleMode === 'existing'
    const year = s.year.trim()
    if (!year) out.push({ field: 'year', message: saved ? 'The saved vehicle has no year on file — enter its 4-digit year below.' : 'Enter the vehicle year (4 digits).' })
    else if (!isFourDigitYear(year)) out.push({ field: 'year', message: `The year must be 4 digits — "${s.year}" is not.` })
    if (!s.make.trim()) out.push({ field: 'make', message: saved ? 'The saved vehicle has no make on file — enter it below.' : 'Enter the vehicle make.' })
    if (!s.model.trim()) out.push({ field: 'model', message: saved ? 'The saved vehicle has no model on file — enter it below.' : 'Enter the vehicle model.' })
  }
  return out
}

/** DOM id of the input that a blocker points at (the screen scrolls to / highlights it). */
export const blockerInputId = (field: BlockerField): string => `qe-details-${field}`
