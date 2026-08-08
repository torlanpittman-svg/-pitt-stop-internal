/** Type declarations for the plain-ESM normalize.mjs (shared by the CLI + vitest). */

export function normalizePhone(p?: string | null): string
export function normalizeEmail(e?: string | null): string
export function normalizeName(n?: string | null): string
export function splitName(full?: string | null): { first: string; last: string }
export function parseMoney(v?: string | null): number

export function parseCsv(text?: string | null): string[][]

export type CanonicalField =
  | 'name' | 'company' | 'email' | 'phone' | 'createdDate' | 'vehicleCount' | 'invoiced' | 'type'
export interface HeaderMap { map: Partial<Record<CanonicalField, number>>; headers: string[]; unmapped: string[] }
export function mapHeaders(headerRow: string[]): HeaderMap

export interface AutoLeapRecord {
  displayName: string
  firstName: string
  lastName: string
  company: string | null
  phone: string | null
  normalizedPhone: string
  email: string | null
  normalizedEmail: string
  normalizedName: string
  createdDate: string | null
  autoleapVehicleCount: number | null
  invoicedAmount: number
  customerType: 'retail' | 'business' | 'dealer' | 'prospect'
  typeRaw: string | null
  /** Full raw source row keyed by header (set by the importer; preserves unmapped columns). */
  raw?: Record<string, string>
}
export function parseAutoLeapRow(cells: string[], map: Partial<Record<CanonicalField, number>>): AutoLeapRecord
export function customerTypeFor(typeRaw: string | null | undefined, invoicedAmount: number): AutoLeapRecord['customerType']
export function sourceKeyFor(rec: { normalizedPhone?: string; normalizedEmail?: string; normalizedName?: string; createdDate?: string | null }): string

export interface ExistingCustomer {
  id: string; source: string; sourceKey: string | null
  normalizedPhone: string; normalizedEmail: string; normalizedName: string
}
export interface MatchIndex {
  bySourceKey: Map<string, string>
  byPhone: Map<string, string[]>
  byEmail: Map<string, string[]>
  byName: Map<string, string[]>
}
export function buildIndex(existing: ExistingCustomer[]): MatchIndex

export type MatchAction = 'update' | 'merge' | 'new' | 'review' | 'skip'
export interface MatchDecision {
  action: MatchAction
  targetId?: string
  candidateIds?: string[]
  reason: string
  score: number
}
export function classify(
  incoming: Pick<AutoLeapRecord, 'normalizedName' | 'normalizedPhone' | 'normalizedEmail' | 'createdDate'>,
  index: MatchIndex,
  source?: string
): MatchDecision
