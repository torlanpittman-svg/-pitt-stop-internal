/**
 * Vehicle correction for a Job (manager/admin only). Fixes a wrong OCR read from the
 * Work Board without recreating the Job:
 *   - updates the canonical vehicle (drives Work Board + Job detail),
 *   - updates the linked dealer scan (keeps the snapshot + QB source consistent),
 *   - for a dealer Job with a synced invoice, updates ONLY that line's description on
 *     the existing QuickBooks invoice (exact DocNumber + line Id), never a new invoice,
 *   - records old→new + actor + timestamp + QB outcome in the audit trail.
 * If QB can't be confidently updated, Pitt Stop is corrected locally and the scan is
 * flagged "needs_review" — it never writes to the wrong invoice.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/platform/db'
import { eq } from 'drizzle-orm'
import { getOrderWithContext, updateVehicleFields, logEvent } from '@/apps/workflow/db'
import { getEstimateRow } from '@/apps/workflow/estimate-db'
import { jobEstimates } from '@/apps/workflow/schema'
import { getActor } from '@/apps/workflow/identity'
import { getScanByServiceOrderId, updateScan, logScanEvent } from '@/apps/dealer-checkin/db'
import { correctedLineDescription, diffVehicle, qbSyncDecision, type VehicleFields } from '@/apps/dealer-checkin/correction'
import { updateDealerLineByDescription } from '@/apps/quickbooks/invoice-write'
import { getEnvironment } from '@/apps/quickbooks/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const clean = (v: unknown): string | null => { const s = (v == null ? '' : String(v)).trim(); return s || null }

// Prefill: current editable values + whether this Job is a dealer/QB-linked Job.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const order = await getOrderWithContext(id)
  if (!order) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  const scan = await getScanByServiceOrderId(id)
  return NextResponse.json({
    year: order.vehicle.year, make: order.vehicle.make, model: order.vehicle.model, vin: order.vehicle.vin,
    color: order.vehicle.color,
    stockNumber: scan?.stockNumber ?? null,
    isDealer: !!scan,
    qbLinked: !!(scan?.qbLineId && scan?.qbInvoiceNumber && scan?.qbSyncStatus === 'synced'),
  })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = getActor(req.headers.get('cookie'))
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ error: 'Only a manager or admin can correct vehicle info.' }, { status: 403 })
  }

  const order = await getOrderWithContext(id)
  if (!order) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  const scan = await getScanByServiceOrderId(id)

  const body = await req.json().catch(() => ({})) as VehicleFields
  const oldF: VehicleFields = { year: order.vehicle.year, make: order.vehicle.make, model: order.vehicle.model, vin: order.vehicle.vin, stockNumber: scan?.stockNumber ?? null }
  const newF: VehicleFields = {
    year: clean(body.year), make: clean(body.make), model: clean(body.model), vin: clean(body.vin),
    stockNumber: scan ? clean(body.stockNumber) : null,   // stock only applies to dealer Jobs
  }

  // Color is a RETAIL-only editable field (dealer color comes from the tag/scan and is left
  // untouched here). It is NOT part of VehicleFields/diffVehicle because it is not in the QB
  // CustomerMemo/line payload — so a color change must never flag QuickBooks sync-needed.
  const colorChanged = !scan && (body as { color?: string }).color !== undefined && clean((body as { color?: string }).color) !== (order.vehicle.color ?? null)
  const diff = diffVehicle(oldF, newF)
  if (diff.changed.length === 0 && !colorChanged) {
    return NextResponse.json({ ok: true, order, qb: { action: 'no_change' }, changed: [] })
  }

  // 1) Canonical vehicle — instantly updates the Work Board card + Job detail. Retail color is
  // applied in the same in-place update; dealer Jobs never get a color write from this modal.
  await updateVehicleFields(order.vehicle.id, {
    year: newF.year, make: newF.make, model: newF.model, vin: newF.vin,
    ...(colorChanged ? { color: clean((body as { color?: string }).color) } : {}),
  })

  // 2) Dealer scan (if any) + 3) QuickBooks line, using exact identifiers only.
  let qb: { action: string; ok: boolean; reason?: string; invoiceNumber?: string | null } = { action: 'not_linked', ok: true }
  if (scan) {
    await updateScan(scan.id, { year: newF.year, make: newF.make, model: newF.model, vin: newF.vin, stockNumber: newF.stockNumber })
    const color = scan.color ?? order.vehicle.color ?? null
    const decision = qbSyncDecision({
      qbLineId: scan.qbLineId, qbInvoiceNumber: scan.qbInvoiceNumber, qbSyncStatus: scan.qbSyncStatus,
      oldDescription: correctedLineDescription(oldF, color), newDescription: correctedLineDescription(newF, color),
    })
    if (decision === 'update') {
      const needsApproval = getEnvironment() === 'production' && req.headers.get('x-qb-write-approved') !== 'true'
      if (needsApproval) {
        await updateScan(scan.id, { qbSyncStatus: 'needs_review', qbSyncError: 'vehicle correction: QuickBooks write not approved' })
        qb = { action: 'needs_review', ok: false, reason: 'not_approved' }
      } else {
        const res = await updateDealerLineByDescription({ invoiceNumber: scan.qbInvoiceNumber!, lineId: scan.qbLineId!, description: correctedLineDescription(newF, color) })
        if (res.ok) {
          await updateScan(scan.id, { qbSyncStatus: 'synced', qbSyncError: null, qbSyncedAt: new Date() })
          qb = { action: 'updated', ok: true, invoiceNumber: res.invoiceNumber ?? scan.qbInvoiceNumber }
        } else {
          await updateScan(scan.id, { qbSyncStatus: 'needs_review', qbSyncError: `vehicle correction: ${res.reason ?? 'qb_error'} ${res.error ?? ''}`.trim().slice(0, 500) })
          qb = { action: 'needs_review', ok: false, reason: res.reason }
        }
      }
    } else {
      qb = { action: decision, ok: true }   // 'not_linked' or 'no_change'
    }
    // Dealer-scan audit (old/new/actor + QB outcome).
    await logScanEvent({ scanId: scan.id, eventType: 'corrected', actor: actor.name, oldValue: diff.old, newValue: diff.new, note: `vehicle correction · qb=${qb.action}` })
  } else {
    // Retail Job: if a retail QuickBooks invoice already exists, the vehicle (which lives in
    // the invoice CustomerMemo) is now stale. Retail QB update isn't built yet — flag
    // "QuickBooks sync needed" (surfaced in the Invoice Draft) rather than silently diverge.
    // Only a QB-payload field (Y/M/M/VIN) makes the invoice stale — a color-only change does
    // NOT (color is not in the CustomerMemo), so it must not flag retail sync-needed.
    const est = await getEstimateRow(id)
    if (est?.qbInvoiceId && diff.changed.length > 0) {
      await getDb().update(jobEstimates).set({ qbSyncError: 'QuickBooks sync needed — vehicle changed after invoice was created.', updatedAt: new Date() }).where(eq(jobEstimates.id, est.id))
      qb = { action: 'retail_sync_needed', ok: true, invoiceNumber: est.qbInvoiceNumber }
    }
  }

  // 4) Job audit event — never hard-deletes history. Color is tracked separately from the
  // dealer diff (it is retail-only + not in the QB payload).
  const changedAll = [...diff.changed, ...(colorChanged ? ['color'] : [])]
  const colorNote = colorChanged ? { color: { old: order.vehicle.color ?? null, new: clean((body as { color?: string }).color) } } : {}
  await logEvent({ serviceOrderId: id, eventType: 'vehicle_corrected', employeeName: actor.name, note: JSON.stringify({ changed: changedAll, old: diff.old, new: diff.new, ...colorNote, qb: qb.action }) })

  const updated = await getOrderWithContext(id)
  return NextResponse.json({ ok: true, order: updated, qb, changed: changedAll })
}
