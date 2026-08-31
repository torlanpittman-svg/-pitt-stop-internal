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
import { createAcquisition, addExpenseEvent, addReturnRefund, settleRefund, sellVehicle, updateCloseout, resolveVin, saveReceipt, type VinResolveResult } from './db'
import { ECONOMIC_CATEGORIES, REFUND_KINDS, econForLabel, type EconomicCategory } from './types'
import { employeeAuthorized } from './guard'

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

export async function sellAction(fd: FormData) {
  if (!(await employeeAuthorized())) return
  const id = String(fd.get('inventoryVehicleId') ?? ''); const price = Math.round(parseFloat(String(fd.get('salePrice') ?? '')) * 100)
  const saleDate = String(fd.get('saleDate') ?? '')
  if (id && Number.isFinite(price) && price >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(saleDate)) {
    const comm = Math.round(parseFloat(String(fd.get('commission') ?? '0')) * 100) || 0
    const payoff = Math.round(parseFloat(String(fd.get('payoff') ?? '0')) * 100) || 0
    await sellVehicle({ inventoryVehicleId: id, saleDate, salePriceCents: price, saleType: (String(fd.get('saleType') ?? 'retail') as 'retail' | 'wholesale'),
      proceedsAccount: String(fd.get('proceedsAccount') ?? '') || undefined, buyerRef: String(fd.get('buyerRef') ?? '') || undefined,
      commissionCents: comm, payoffKnownCents: payoff, payoffStatus: (String(fd.get('payoffStatus') ?? 'unknown') as any),
      titleOutstanding: fd.get('titleOutstanding') === 'on', proceedsReceived: (String(fd.get('proceedsReceived') ?? 'unknown') as any),
      markDelivered: fd.get('markDelivered') === 'on', notes: String(fd.get('notes') ?? '') || undefined, actor: 'auto-sales' })
  }
  revalidateVehicle(id)
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
  isReturn?: boolean; originalEventId?: string
}
export async function saveReceiptAction(f: SaveReceiptForm): Promise<{ ok: boolean; error?: string }> {
  if (!(await employeeAuthorized())) return { ok: false, error: 'Sign in required' }
  const amountCents = Math.round(parseFloat(f.amountDollars || '') * 100)
  const totalCents = f.totalDollars ? Math.round(parseFloat(f.totalDollars) * 100) : undefined
  if (!f.documentId || !Number.isFinite(amountCents) || amountCents <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(f.eventDate))
    return { ok: false, error: 'Enter an amount and date.' }
  const econ = f.economicCategory ?? econForLabel(f.categoryLabel)
  if (!ECONOMIC_CATEGORIES.includes(econ)) return { ok: false, error: 'Invalid category.' }
  const r = await saveReceipt({ documentId: f.documentId, economicCategory: econ, amountCents, eventDate: f.eventDate,
    vendor: f.vendor || undefined, receiptTotalCents: totalCents, memo: f.memo || undefined,
    isReturn: f.isReturn ?? false, originalEventId: f.originalEventId || undefined, actor: 'auto-sales' })
  if (r.ok) { revalidatePath(`/auto-sales/${f.vehicleId}`); revalidatePath(`/admin/auto-sales/${f.vehicleId}`) }
  return { ok: r.ok, error: r.error }
}
