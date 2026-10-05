/**
 * "Move to Estimates": take a retail vehicle that was checked onto the Work Board but belongs in
 * Estimates and move it there — a PURE Pitt Stop workflow/status move. The SAME service_orders row
 * is kept with ALL its detail (customer, vehicle, VIN, services, pricing, notes, photos, history),
 * and any linked QuickBooks invoice is left completely untouched and linked exactly as-is.
 *
 * It never reads or mutates QuickBooks, and an existing invoice never blocks the move — a manager can
 * freely reorganize a job between the Work Board and Estimates. The move is reversible via the existing
 * approval path (apps/estimates/db.ts → moveIntakeToBoard).
 *
 * The only protections kept are the operational ones: dealer vehicles, work already started/finished,
 * and a technician assignment — each surfaced with a specific plain-language reason.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { isDealerOrder, orderSourceKind } from '@/apps/workflow/fees'
import { moveBoardOrderToEstimates } from './move-from-board'
import { logger } from '@/platform/logger'

const APP = 'estimates:move-to-estimates'

export type MoveBlockCode =
  | 'not_found' | 'already_moved' | 'dealer' | 'not_retail' | 'cancelled' | 'delivered'
  | 'started' | 'completed' | 'not_waiting' | 'assigned'

/** The job row this flow reasons over. Raw-SQL shaped so tests can use a minimal schema. */
interface MoveOrderRow {
  id:              string
  status:          string
  source:          string | null
  serviceType:     string | null
  customerName:    string | null
  startedAt:       unknown
  completedAt:     unknown
  cancelledAt:     unknown
  deliveredAt:     unknown
  vehicle:         string
  assignmentCount: number
}

async function readMoveOrder(orderId: string): Promise<MoveOrderRow | null> {
  const db = getDb()
  const { rows } = await db.execute(sql`
    SELECT so.id, so.status, so.source, so.service_type AS "serviceType", so.customer_name AS "customerName",
      so.started_at AS "startedAt", so.completed_at AS "completedAt",
      so.cancelled_at AS "cancelledAt", so.delivered_at AS "deliveredAt",
      trim(concat_ws(' ', v.year, v.make, v.model)) AS vehicle,
      (SELECT count(*) FROM service_order_assignments a WHERE a.service_order_id = so.id)::int AS "assignmentCount"
    FROM service_orders so
    JOIN vehicles v ON v.id = so.vehicle_id
    WHERE so.id = ${orderId}::uuid
    LIMIT 1
  `)
  return (rows[0] as unknown as MoveOrderRow) ?? null
}

/**
 * Pure eligibility with a specific plain-language reason. Operational protections only — an existing
 * QuickBooks invoice is deliberately NOT a gate. The atomic move SQL remains the final authority.
 */
export function moveBaseEligibility(order: MoveOrderRow): { ok: true } | { ok: false; code: MoveBlockCode; error: string } {
  const kind = orderSourceKind({ source: order.source, serviceType: order.serviceType })
  if (isDealerOrder({ source: order.source, serviceType: order.serviceType }) || kind === 'dealer')
    return { ok: false, code: 'dealer', error: 'Dealer vehicles stay on the Work Board — they can’t move to Estimates.' }
  if (kind !== 'retail')
    return { ok: false, code: 'not_retail', error: 'Only retail jobs can move to Estimates.' }
  if (order.status === 'cancelled' || order.cancelledAt)
    return { ok: false, code: 'cancelled', error: 'This job was removed from the Work Board, so there’s nothing to move.' }
  if (order.status === 'delivered' || order.deliveredAt)
    return { ok: false, code: 'delivered', error: 'This job was already delivered, so it can’t move to Estimates.' }
  if (order.startedAt)
    return { ok: false, code: 'started', error: 'Work has already started on this vehicle, so it can’t move to Estimates. Reopen or remove it instead.' }
  if (order.completedAt)
    return { ok: false, code: 'completed', error: 'This job is already finished, so it can’t move to Estimates.' }
  if (order.status !== 'arrived')
    return { ok: false, code: 'not_waiting', error: `Only vehicles waiting on the Work Board can move to Estimates (this one is ${order.status}).` }
  if (order.assignmentCount > 0)
    return { ok: false, code: 'assigned', error: 'A technician is assigned to this vehicle. Unassign it before moving to Estimates.' }
  return { ok: true }
}

// ── Read-only preview (UI: show customer + vehicle, or the specific reason the move is blocked) ──
export interface MovePreview {
  eligible: boolean
  code?:    MoveBlockCode
  reason?:  string          // plain-language, specific — shown when !eligible
  customer: string
  vehicle:  string
}

export async function planMoveToEstimates(orderId: string): Promise<{ ok: boolean; error?: string; preview?: MovePreview }> {
  const order = await readMoveOrder(orderId)
  if (!order) return { ok: false, error: 'Job not found.' }
  const base = { customer: order.customerName?.trim() || 'Customer', vehicle: order.vehicle || 'Vehicle' }
  if (order.status === 'estimate')
    return { ok: true, preview: { ...base, eligible: false, code: 'already_moved', reason: 'This job is already in Estimates.' } }
  const gate = moveBaseEligibility(order)
  if (!gate.ok) return { ok: true, preview: { ...base, eligible: false, code: gate.code, reason: gate.error } }
  return { ok: true, preview: { ...base, eligible: true } }
}

// ── Execute ─────────────────────────────────────────────────────────────────────────────────────
export interface MoveResult {
  ok:            boolean
  alreadyMoved?: boolean
  block?:        MoveBlockCode | 'not_eligible'
  code?:         MoveBlockCode
  error?:        string
}

/**
 * Perform the move. Manager/admin authorization is enforced by the API route. QuickBooks is never
 * touched; a linked invoice stays exactly as it was.
 */
export async function executeMoveToEstimates(params: { orderId: string; actor: string | null }): Promise<MoveResult> {
  const { orderId, actor } = params
  const order = await readMoveOrder(orderId)
  if (!order) return { ok: false, block: 'not_found', code: 'not_found', error: 'Job not found.' }

  // Idempotency — already in Estimates (e.g. a repeated click). Return the successful terminal state.
  if (order.status === 'estimate') return { ok: true, alreadyMoved: true }

  const gate = moveBaseEligibility(order)
  if (!gate.ok) return { ok: false, block: gate.code, code: gate.code, error: gate.error }

  try {
    await moveBoardOrderToEstimates(orderId, actor ?? 'Manager')
    logger.info(APP, 'moved', { orderId })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error && err.message.startsWith('Only retail jobs')
      ? err.message : 'Unable to move this job. Please refresh and try again.'
    return { ok: false, block: 'not_eligible', error: message }
  }
}
