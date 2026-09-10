/**
 * Check-writing domain types + business-language categories.
 *
 * Managers pick a plain-English category; the accounting treatment (which QBO expense account, which
 * bank account, which CFO entity) is mapped behind the scenes (see config.ts). No QuickBooks account
 * terminology is ever shown in the everyday Write-a-Check UI.
 */

export const CHECK_CATEGORIES = [
  { key: 'customer_job',  label: 'Customer Vehicle',entity: 'operating',  linksJob: true,     hint: 'A cost tied to a specific customer vehicle/job' },
  { key: 'shop_general',  label: 'Shop / General',  entity: 'operating',  linksJob: false,    hint: 'Everyday shop operating expense' },
  { key: 'equipment',     label: 'Equipment',       entity: 'operating',  linksJob: false,    hint: 'Tools / equipment purchase' },
  { key: 'auto_sales',    label: 'Auto Sales',      entity: 'auto_sales', linksVehicle: true, hint: 'Auto Sales expense — kept separate from operating' },
  { key: 'owner_personal',label: 'Owner / Personal',entity: 'operating',  linksJob: false,    hint: 'Owner draw / personal — recorded, never a shop expense' },
  { key: 'other',         label: 'Other',           entity: 'operating',  linksJob: false,    hint: 'Anything else' },
] as const

export type CheckCategoryKey = (typeof CHECK_CATEGORIES)[number]['key']
export const CHECK_CATEGORY_KEYS = CHECK_CATEGORIES.map((c) => c.key) as CheckCategoryKey[]

export function categoryDef(key: string) {
  return CHECK_CATEGORIES.find((c) => c.key === key) ?? null
}
/** The CFO entity boundary a category belongs to (operating vs isolated auto_sales). */
export function categoryEntity(key: string): 'operating' | 'auto_sales' {
  return categoryDef(key)?.entity ?? 'operating'
}

export type BankKey = 'operating' | 'auto_sales'
export type QbStatus = 'pending' | 'recorded' | 'failed' | 'voided'
export type PrintStatus = 'not_printed' | 'printed' | 'print_failed'

/** Everything the confirmation screen + print layout need for one check. */
export interface CheckView {
  id: string
  checkNumber: number
  bankKey: BankKey
  bankLabel: string
  payeeName: string
  amountCents: number
  memo: string | null
  category: CheckCategoryKey
  categoryLabel: string
  entity: 'operating' | 'auto_sales'
  linkedJobId: string | null
  linkedVehicleId: string | null
  checkDate: string
  qboTxnId: string | null
  qboDocNumber: string | null
  qbStatus: QbStatus
  qbError: string | null
  printStatus: PrintStatus
  printedAt: string | null
  reprintCount: number
  actorName: string | null
  createdAt: string
}
