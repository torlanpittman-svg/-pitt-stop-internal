'use server'
/**
 * Auto-Sales — EMPLOYEE-SAFE server actions (shared by the public /auto-sales route and the admin
 * /admin/auto-sales route). These are ordinary operational functions employees perform beside a
 * vehicle: acquire, VIN resolve, add expense, record sale/closeout, return/refund. They do NOT
 * include sensitive/admin operations (destructive reversals, opening-inventory backfill, CFO/
 * reconciliation) — those stay defined only in gated /admin route modules. No money movement.
 *
 * Each action revalidates BOTH route trees so a change shows on whichever surface the user is on.
 */
import { revalidatePath } from 'next/cache'
import { createAcquisition, addExpenseEvent, addReturnRefund, settleRefund, recordSale, editSale, reverseSale, editAcquisitionPrice, updateCloseout, resolveVin, saveReceipt, type VinResolveResult, type SaleInput } from './db'
import { ECONOMIC_CATEGORIES, REFUND_KINDS, IN_SCOPE_ACCOUNTS, econForLabel, type EconomicCategory } from './types'
import { dollarsToCents, isPaymentMethod } from './calc'
import { employeeAuthorized, authorizedManager, authorizedManagerStrict } from '@/apps/auth/employee-guard'

const revalidateVehicle = (id: string) => { revalidatePath(`/auto-sales/${id}`); revalidatePath(`/admin/auto-sales/${id}`) }
const revalidateList = () => { revalidatePath('/auto-sales'); revalidatePath('/admin/auto-sales') }

export async function acquireAction(fd: FormData) {
  if (!(await employeeAuthorized())) return
  const { validateVIN, normalizeVIN, decodeVINFromNHTSA } = await import('@/apps/vehicle-entry/vin')
  const rawVin = String(fd.get('vin') ?? '').trim()
  const cost = Math.round(parseFloat(String(fd.get('cost') ?? '')) * 100)
  const acquiredAt = String(fd.get('acquiredAt') ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquiredAt) || !Number.isFinite(cost) || cost < 0) { revalidateList(); return }
  let year = String(fd.get('year') ?? '') || null, make = String(fd.get('make') ?? '') || null, model = String(fd.get('model') ?? '') || null
  let vin: string | null = null, vinRaw: unknown = null
  if (rawVin) {
    const { valid } = validateVIN(rawVin)
    if (valid) {
      vin = normalizeVIN(rawVin)
      try { const d = await decodeVINFromNHTSA(vin); year = d.year || year; make = d.make || make; model = d.model || model; vinRaw = d } catch { /* NHTSA down — keep provided values */ }
    }
  }
  await createAcquisition({
    vin, year, make, model, color: String(fd.get('color') ?? '') || null, vinRaw,
    acquisitionCostCents: cost, acquiredAt, acquisitionSource: String(fd.get('source') ?? '') || undefined,
    seller: String(fd.get('seller') ?? '') || undefined, paymentAccountRef: String(fd.get('account') ?? 'unknown'),
    floorPlanned: fd.get('floorPlanned') === 'on', floorPlanLender: String(fd.get('floorPlanLender') ?? '') || undefined,
    origin: 'quick_entry', actor: 'auto-sales',
  })
  revalidateList()
}

export async function addExpenseAction(fd: FormData) {
  if (!(await employeeAuthorized())) return
  const id = String(fd.get('inventoryVehicleId') ?? ''); const amt = Math.round(parseFloat(String(fd.get('amount') ?? '')) * 100)
  const eventDate = String(fd.get('eventDate') ?? ''); const cat = String(fd.get('category') ?? '') as EconomicCategory
  if (id && ECONOMIC_CATEGORIES.includes(cat) && Number.isFinite(amt) && amt > 0 && /^\d{4}-\d{2}-\d{2}$/.test(eventDate))
    await addExpenseEvent({ inventoryVehicleId: id, economicCategory: cat, amountCents: amt, eventDate, vendor: String(fd.get('vendor') ?? '') || undefined, memo: String(fd.get('memo') ?? '') || undefined, paymentAccountRef: String(fd.get('account') ?? 'unknown'), actor: 'auto-sales' })
  revalidateVehicle(id)
}

export async function returnRefundAction(fd: FormData) {
  if (!(await employeeAuthorized())) return
  const id = String(fd.get('inventoryVehicleId') ?? ''); const originalEventId = String(fd.get('originalEventId') ?? '')
  const kindDef = REFUND_KINDS.find((k) => k.kind === String(fd.get('kind') ?? '')); const amt = Math.round(parseFloat(String(fd.get('amount') ?? '')) * 100)
  const eventDate = String(fd.get('eventDate') ?? ''); const refundStatus = String(fd.get('refundStatus') ?? 'pending') as 'expected' | 'pending' | 'settled'
  if (id && originalEventId && kindDef && Number.isFinite(amt) && amt > 0 && /^\d{4}-\d{2}-\d{2}$/.test(eventDate))
    await addReturnRefund({ inventoryVehicleId: id, originalEventId, econ: kindDef.econ, refundMethod: kindDef.method, cash: kindDef.cash, amountCents: amt, eventDate, refundStatus, destinationAccount: String(fd.get('destination') ?? '') || undefined, memo: String(fd.get('memo') ?? '') || undefined, allowExceed: fd.get('allowExceed') === 'on', actor: 'auto-sales' })
  revalidateVehicle(id)
}

export async function settleAction(fd: FormData) {
  if (!(await employeeAuthorized())) return
  const id = String(fd.get('inventoryVehicleId') ?? ''); const eventId = String(fd.get('eventId') ?? ''); const date = String(fd.get('date') ?? '')
  if (eventId && /^\d{4}-\d{2}-\d{2}$/.test(date)) await settleRefund(eventId, date, 'auto-sales'); revalidateVehicle(id)
}

// ── Sale workflow (MANAGER-gated; separate from ADMIN_PASSWORD) ──
export interface SaleForm {
  inventoryVehicleId: string; saleDate: string; salePrice: string; saleType?: string
  buyerRef?: string; buyerContact?: string; paymentMethod?: string; salePaymentRef?: string
  tax?: string; docFees?: string; otherCharges?: string; discount?: string; amountReceived?: string
  commission?: string; payoff?: string; payoffStatus?: string; proceedsAccount?: string
  proceedsReceived?: string; titleOutstanding?: boolean; tradeIn?: boolean; tradeInNotes?: string
  markDelivered?: boolean; notes?: string; mode?: 'record' | 'edit'
}
function saleInputFrom(f: SaleForm, actorName: string): SaleInput | null {
  const price = dollarsToCents(f.salePrice)
  if (price == null || price < 0) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.saleDate)) return null
  return {
    inventoryVehicleId: f.inventoryVehicleId, saleDate: f.saleDate, salePriceCents: price,
    saleType: f.saleType === 'wholesale' ? 'wholesale' : 'retail',
    proceedsAccount: f.proceedsAccount || undefined, buyerRef: f.buyerRef || undefined, buyerContact: f.buyerContact || undefined,
    commissionCents: dollarsToCents(f.commission) ?? 0, payoffKnownCents: dollarsToCents(f.payoff) ?? 0,
    payoffStatus: (['open', 'paid', 'none'].includes(f.payoffStatus ?? '') ? f.payoffStatus : 'unknown') as SaleInput['payoffStatus'],
    titleOutstanding: !!f.titleOutstanding, proceedsReceived: (['yes', 'no'].includes(f.proceedsReceived ?? '') ? f.proceedsReceived : 'unknown') as SaleInput['proceedsReceived'],
    taxCents: dollarsToCents(f.tax) ?? undefined, docFeesCents: dollarsToCents(f.docFees) ?? undefined,
    otherChargesCents: dollarsToCents(f.otherCharges) ?? undefined, discountCents: dollarsToCents(f.discount) ?? undefined,
    amountReceivedCents: dollarsToCents(f.amountReceived) ?? undefined,
    paymentMethod: isPaymentMethod(f.paymentMethod) ? f.paymentMethod : (f.paymentMethod || undefined),
    salePaymentRef: f.salePaymentRef || undefined, tradeIn: !!f.tradeIn, tradeInNotes: f.tradeInNotes || undefined,
    salesperson: actorName, markDelivered: !!f.markDelivered, notes: f.notes || undefined, actor: actorName,
  }
}
/** Record OR edit a sale (manager-gated). Idempotent record (single sale); edit = audited correction. */
export async function submitSaleAction(f: SaleForm): Promise<{ ok: boolean; error?: string; alreadySold?: boolean }> {
  const actor = await authorizedManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required to complete a sale.' }
  const input = saleInputFrom(f, actor.name)
  if (!input) return { ok: false, error: 'Enter a valid selling price and sale date.' }
  const r = f.mode === 'edit' ? await editSale(input) : await recordSale(input)
  if (r.ok) revalidateVehicle(f.inventoryVehicleId)
  return r
}
/** Reverse a completed sale (manager-gated). Append-only; restores the vehicle to active inventory. */
export async function reverseSaleAction(f: { inventoryVehicleId: string; reason?: string; restoreStatus?: string }): Promise<{ ok: boolean; error?: string }> {
  const actor = await authorizedManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required to reverse a sale.' }
  const r = await reverseSale({ inventoryVehicleId: f.inventoryVehicleId, reason: f.reason, restoreStatus: f.restoreStatus, actor: actor.name })
  if (r.ok) revalidateVehicle(f.inventoryVehicleId)
  return r
}
/**
 * Remove an expense attached to a vehicle BY MISTAKE (manager/admin-gated). A mistaken-attachment
 * correction — NOT a return/refund: append-only, keeps the receipt, nets the expense out of active cost
 * and profit, records who/when/former-vehicle, never touches money, the acquisition price or QuickBooks.
 * Idempotent: repeated clicks never create a second adjustment.
 */
export async function removeVehicleExpenseAction(f: { inventoryVehicleId: string; eventId: string }): Promise<{ ok: boolean; error?: string; alreadyRemoved?: boolean }> {
  // Strict, genuinely fail-closed gate: anonymous/employee/unconfigured auth all denied; never a synthetic
  // dev manager (removal is destructive). Admin Basic-Auth or a real signed manager identity only.
  const actor = await authorizedManagerStrict()
  if (!actor) return { ok: false, error: 'Manager sign-in required to remove an expense.' }
  if (!f.eventId) return { ok: false, error: 'Missing expense.' }
  const { removeVehicleExpense } = await import('./db')
  const r = await removeVehicleExpense({ eventId: f.eventId, actor: actor.name })
  if (r.ok) revalidateVehicle(f.inventoryVehicleId)
  return r
}
/** Finalize the monthly Auto-Sales report (manager-gated). Captures a snapshot; supersedes any prior. */
export async function finalizeReportAction(f: { month: string; note?: string }): Promise<{ ok: boolean; error?: string; superseded?: boolean }> {
  const actor = await authorizedManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required to finalize a report.' }
  const { finalizeMonthlyReport, isValidMonth } = await import('./report-db')
  if (!isValidMonth(f.month)) return { ok: false, error: 'Invalid month.' }
  const r = await finalizeMonthlyReport(f.month, actor.name, f.note)
  if (r.ok) { revalidatePath('/auto-sales/report'); revalidatePath('/auto-sales'); revalidatePath('/admin/auto-sales') }
  return { ok: r.ok, error: r.error, superseded: r.superseded }
}

/** Edit the acquisition/purchase price (manager-gated, append-only + audited). */
export async function editAcquisitionPriceAction(f: { inventoryVehicleId: string; amount: string; reason?: string }): Promise<{ ok: boolean; error?: string; previousCents?: number; newCents?: number }> {
  const actor = await authorizedManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required to edit the acquisition price.' }
  const cents = dollarsToCents(f.amount)
  if (cents == null) return { ok: false, error: 'Enter a valid amount.' }
  const r = await editAcquisitionPrice({ inventoryVehicleId: f.inventoryVehicleId, newCents: cents, reason: f.reason, actor: actor.name })
  if (r.ok) revalidateVehicle(f.inventoryVehicleId)
  return r
}

export async function closeoutAction(fd: FormData) {
  if (!(await employeeAuthorized())) return
  const id = String(fd.get('inventoryVehicleId') ?? '')
  await updateCloseout({ inventoryVehicleId: id, proceedsReceived: (String(fd.get('proceedsReceived') ?? '') || undefined) as any, payoffStatus: (String(fd.get('payoffStatus') ?? '') || undefined) as any, titleOutstanding: fd.get('titleField') ? fd.get('titleOutstanding') === 'on' : undefined, markDelivered: fd.get('markDelivered') === 'on', actor: 'auto-sales' })
  revalidateVehicle(id)
}

/** VIN scan/decode/attach — employee-safe (identity resolution, dedup + conflict handled in db). */
export async function resolveVinAction(inventoryVehicleId: string, rawVin: string, confirmConflict: boolean): Promise<VinResolveResult> {
  if (!(await employeeAuthorized())) return { status: 'invalid', error: 'Sign in required' }
  return resolveVin({ inventoryVehicleId, rawVin, confirmConflict, actor: 'auto-sales' })
}

/** Save a verified receipt (employee-safe): create the financial event (a PORTION of the receipt total
 *  is allowed) and link it to the document. Accepts either a friendly category label OR an economic
 *  category. Returns the folder id for redirect. */
export interface SaveReceiptForm {
  documentId: string; vehicleId: string; categoryLabel?: string; economicCategory?: EconomicCategory
  amountDollars: string; totalDollars?: string; eventDate: string; vendor?: string; memo?: string
  paymentAccountRef?: string  // approved bank the shared matcher identified (or a manual pick); validated server-side
  paymentCardLast4?: string   // the matched CARD ending — stored SEPARATELY from the bank account ending
  // Return handling: refundKind (cash vs non-cash), a matched originalEventId or unmatched, + match evidence.
  isReturn?: boolean; refundKind?: string; originalEventId?: string; unmatched?: boolean
  matchConfidence?: string; matchReasons?: string[]; returnedLineRef?: string; referencedReceipt?: string
}
export async function saveReceiptAction(f: SaveReceiptForm): Promise<{ ok: boolean; error?: string }> {
  if (!(await employeeAuthorized())) return { ok: false, error: 'Sign in required' }
  const amountCents = Math.round(parseFloat(f.amountDollars || '') * 100)
  const totalCents = f.totalDollars ? Math.round(parseFloat(f.totalDollars) * 100) : undefined
  if (!f.documentId || !Number.isFinite(amountCents) || amountCents <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(f.eventDate))
    return { ok: false, error: 'Enter an amount and date.' }
  const econ = f.economicCategory ?? econForLabel(f.categoryLabel)
  if (!ECONOMIC_CATEGORIES.includes(econ)) return { ok: false, error: 'Invalid category.' }
  // Only an approved account ref is accepted; anything else (incl. an unresolved match) stays 'unknown'.
  const paymentAccountRef = IN_SCOPE_ACCOUNTS.some((a) => a.ref === f.paymentAccountRef) ? f.paymentAccountRef : 'unknown'
  // The card ending is kept ONLY alongside a real bank (a card draws on an account); a check/unknown has none.
  const paymentCardLast4 = paymentAccountRef !== 'unknown' && /^\d{4}$/.test(f.paymentCardLast4 ?? '') ? f.paymentCardLast4 : undefined
  const r = await saveReceipt({ documentId: f.documentId, economicCategory: econ, amountCents, eventDate: f.eventDate,
    vendor: f.vendor || undefined, receiptTotalCents: totalCents, memo: f.memo || undefined, paymentAccountRef, paymentCardLast4,
    isReturn: f.isReturn ?? false, refundKind: f.refundKind, originalEventId: f.isReturn ? (f.originalEventId || null) : undefined,
    unmatched: f.unmatched, matchConfidence: f.matchConfidence, matchReasons: f.matchReasons,
    returnedLineRef: f.returnedLineRef, referencedReceipt: f.referencedReceipt, actor: 'auto-sales' })
  if (r.ok) { revalidatePath(`/auto-sales/${f.vehicleId}`); revalidatePath(`/admin/auto-sales/${f.vehicleId}`) }
  return { ok: r.ok, error: r.error }
}
