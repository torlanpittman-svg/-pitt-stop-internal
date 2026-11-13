'use server'
/**
 * Job expenses — server actions for the job screen's Expenses section, the "link an existing receipt" picker,
 * and the job search on general Receipts.
 *
 * Authorization (FAIL-CLOSED, server-side, independent of any hidden control):
 *   - searching jobs → any verified session (an employee filing a receipt needs to pick the job);
 *   - seeing a job's expense list, linking an existing receipt, splitting, reassigning, removing → manager/admin
 *     (amounts and receipt images are manager-only everywhere else in the app too).
 * None of these create an expense, change a customer invoice, or call QuickBooks.
 */
import { revalidatePath } from 'next/cache'
import { receiptManager, receiptUploader } from './authz'
import {
  allocateReceipt, changeAllocation, removeAllocation, listJobExpenses, listLinkableReceipts, searchJobs, getJobRef,
  isUuid, type JobExpenses, type LinkableReceipt, type JobRef,
} from './job-expenses'
import { parseCents } from './types'
import { isAllocationTarget } from './allocations'

const NEED_MANAGER = 'Manager sign-in required.'
function touch(orderIds: (string | null | undefined)[]) {
  for (const id of orderIds) if (id) revalidatePath(`/orders/${id}`)
  revalidatePath('/expenses/review'); revalidatePath('/expenses/reconcile')
}
/** '' → the whole purchase (null); otherwise a positive dollar amount → cents. 'bad' when unparseable. */
function amountFrom(v: string | null | undefined): number | null | 'bad' {
  if (v == null || v.trim() === '') return null
  const c = parseCents(v)
  return c == null || c <= 0 ? 'bad' : c
}

export async function searchJobsAction(q: string): Promise<{ ok: boolean; jobs: JobRef[] }> {
  if (!(await receiptUploader())) return { ok: false, jobs: [] }
  return { ok: true, jobs: await searchJobs(String(q ?? '').slice(0, 80)) }
}

export async function loadJobExpensesAction(orderId: string): Promise<{ ok: boolean; error?: string; data?: JobExpenses }> {
  if (!(await receiptManager())) return { ok: false, error: NEED_MANAGER }
  if (!isUuid(orderId)) return { ok: false, error: 'Job not found.' }
  return { ok: true, data: await listJobExpenses(orderId) }
}

export async function listLinkableReceiptsAction(q: string): Promise<{ ok: boolean; error?: string; receipts: LinkableReceipt[] }> {
  if (!(await receiptManager())) return { ok: false, error: NEED_MANAGER, receipts: [] }
  return { ok: true, receipts: await listLinkableReceipts(String(q ?? '').slice(0, 80)) }
}

export interface LinkForm {
  receiptId: string
  target?: string                // 'job' (default) | 'overhead'
  serviceOrderId?: string
  amount?: string                // '' = the whole purchase
  jobPartId?: string
  note?: string
}
/** Attach an EXISTING receipt (or part of it) to a job or to overhead. No upload, no second expense. */
export async function linkReceiptAction(f: LinkForm): Promise<{ ok: boolean; error?: string; already?: boolean }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: NEED_MANAGER }
  const target = isAllocationTarget(f.target) ? f.target : 'job'
  const amount = amountFrom(f.amount)
  if (amount === 'bad') return { ok: false, error: 'Check the amount — use a number like 80.21, or leave it blank for the whole purchase.' }
  const r = await allocateReceipt({
    receiptId: f.receiptId, target, serviceOrderId: target === 'job' ? f.serviceOrderId : null,
    amountCents: amount, jobPartId: f.jobPartId || null, note: f.note,
  }, { name: actor.name, key: actor.key })
  if (r.ok) touch([f.serviceOrderId])
  return { ok: r.ok, error: r.error, already: r.already }
}

export interface ChangeForm {
  allocationId: string
  fromOrderId?: string           // the job screen it was changed from (cache refresh only)
  target?: string
  serviceOrderId?: string        // move to this job
  amount?: string                // undefined = keep; '' = whole purchase
  jobPartId?: string             // undefined = keep; '' = untie from the part
  reason?: string
}
/** Correct or reassign an assignment (audited; the old row is kept as removed, never deleted). */
export async function changeAllocationAction(f: ChangeForm): Promise<{ ok: boolean; error?: string }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: NEED_MANAGER }
  const change: Parameters<typeof changeAllocation>[1] = {}
  if (f.target !== undefined) { if (!isAllocationTarget(f.target)) return { ok: false, error: 'Choose a job or overhead.' }; change.target = f.target }
  if (f.serviceOrderId !== undefined) {
    if (!(await getJobRef(f.serviceOrderId))) return { ok: false, error: 'That job could not be found.' }
    change.serviceOrderId = f.serviceOrderId; change.target = 'job'
  }
  if (f.amount !== undefined) {
    const amount = amountFrom(f.amount)
    if (amount === 'bad') return { ok: false, error: 'Check the amount — use a number like 40.00, or leave it blank for the whole purchase.' }
    change.amountCents = amount
  }
  if (f.jobPartId !== undefined) change.jobPartId = f.jobPartId || null
  const r = await changeAllocation(f.allocationId, change, f.reason ?? null, { name: actor.name, key: actor.key })
  if (r.ok) touch([f.fromOrderId, f.serviceOrderId])
  return { ok: r.ok, error: r.error }
}

/** Take a purchase off a job (soft; the receipt and its history are untouched). */
export async function removeAllocationAction(f: { allocationId: string; fromOrderId?: string; reason?: string }): Promise<{ ok: boolean; error?: string }> {
  const actor = await receiptManager()
  if (!actor) return { ok: false, error: NEED_MANAGER }
  const r = await removeAllocation(f.allocationId, f.reason ?? null, { name: actor.name, key: actor.key })
  if (r.ok) touch([f.fromOrderId])
  return r
}
