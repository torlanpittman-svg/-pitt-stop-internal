'use server'
/**
 * Receipt → Auto Sales vehicle — server actions for the "Assign to Auto Sales Vehicle" control on Receipts and
 * the Remove control on a receipt-backed line in the vehicle folder.
 *
 * Authorization (FAIL-CLOSED, server-side):
 *   - looking up what is already entered on a vehicle → any verified session (the person filing a receipt has
 *     to be able to say "this is that same expense"; the vehicle folder already shows these lines to them);
 *   - assigning, changing or removing the vehicle on an EXISTING receipt → manager/admin.
 *     (A person capturing a new receipt picks the vehicle as part of filing it — see fileReceiptAction.)
 * Nothing here creates an expense, moves money or calls QuickBooks.
 */
import { revalidatePath } from 'next/cache'
import { receiptManager, receiptUploader } from './authz'
import { parseCents } from './types'
import { setReceiptVehicle, vehicleExpenseCandidates, type VehicleExpenseCandidate } from './vehicle-link'

function touch(vehicleIds: (string | null | undefined)[]) {
  for (const id of vehicleIds) if (id) { revalidatePath(`/auto-sales/${id}`); revalidatePath(`/admin/auto-sales/${id}`) }
  revalidatePath('/auto-sales'); revalidatePath('/admin/auto-sales')
  revalidatePath('/expenses/review'); revalidatePath('/expenses/reconcile'); revalidatePath('/expenses')
}

export async function vehicleExpenseCandidatesAction(f: { inventoryVehicleId: string; total?: string; date?: string; receiptId?: string }): Promise<{ ok: boolean; candidates: VehicleExpenseCandidate[] }> {
  if (!(await receiptUploader())) return { ok: false, candidates: [] }
  const amountCents = f.total && f.total.trim() !== '' ? parseCents(f.total) : null
  return { ok: true, candidates: await vehicleExpenseCandidates(String(f.inventoryVehicleId ?? ''), { amountCents, date: f.date ?? null, receiptId: f.receiptId ?? null }) }
}

/** Assign an existing receipt to a vehicle, move it to another vehicle, or match it to an expense already there. */
export async function assignReceiptVehicleAction(f: { receiptId: string; inventoryVehicleId: string; matchEventId?: string | null }): Promise<{ ok: boolean; error?: string; already?: boolean }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  if (!f.inventoryVehicleId) return { ok: false, error: 'Choose a vehicle.' }
  const r = await setReceiptVehicle({ receiptId: f.receiptId, inventoryVehicleId: f.inventoryVehicleId, matchEventId: f.matchEventId || null }, { name: actor.name, key: actor.key })
  if (r.ok) touch([r.inventoryVehicleId, r.previousVehicleId])
  return { ok: r.ok, error: r.error, already: r.already }
}

/** Take a receipt off its vehicle. The receipt itself is untouched and stays in Receipts. */
export async function unassignReceiptVehicleAction(f: { receiptId: string }): Promise<{ ok: boolean; error?: string; already?: boolean }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: 'Manager sign-in required.' }
  const r = await setReceiptVehicle({ receiptId: f.receiptId, inventoryVehicleId: null }, { name: actor.name, key: actor.key })
  if (r.ok) touch([r.previousVehicleId])
  return { ok: r.ok, error: r.error, already: r.already }
}
