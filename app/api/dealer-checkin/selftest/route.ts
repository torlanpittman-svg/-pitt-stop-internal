/**
 * POST /api/dealer-checkin/selftest — SANDBOX ONLY.
 *
 * Exercises the full check-in service across its four paths and asserts the
 * business rules, then cleans up every Work Board order / vehicle / scan it
 * created so nothing test-related is left behind. Refuses on non-sandbox.
 */
import { NextResponse } from 'next/server'
import { getConnectionStatus } from '@/apps/quickbooks/connection'
import { checkInDealerVehicle } from '@/apps/dealer-checkin/service'
import { deleteScanCascade } from '@/apps/dealer-checkin/db'
import { deleteOrderCascade } from '@/apps/workflow/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const status = await getConnectionStatus()
  if (status.environment !== 'sandbox') {
    return NextResponse.json({ ok: false, error: 'Refused: self-test only runs on sandbox.' }, { status: 403 })
  }
  if (!status.connected) {
    return NextResponse.json({ ok: false, error: 'QuickBooks not connected.' }, { status: 409 })
  }

  const rid = Date.now().toString().slice(-6)
  const created: Array<{ scanId?: string; orderId?: string; vehicleId?: string }> = []
  const results: Record<string, unknown> = {}
  const checks: Record<string, boolean> = {}

  const track = (r: { scanId?: string; serviceOrderId?: string; vehicleId?: string }) =>
    created.push({ scanId: r.scanId, orderId: r.serviceOrderId, vehicleId: r.vehicleId })

  try {
    // A. Append to Sterling Kia's open invoice (K prefix, yellow tag)
    const a = await checkInDealerVehicle({
      stockNumber: `K${rid}1`, vin: `1HGES${rid}A10000`, year: '2021', make: 'Honda', model: 'Civic',
      color: 'Gray', tagColor: 'yellow', approvedBy: 'selftest', dataType: 'test',
    })
    track(a); results.A_kia = { outcome: a.outcome, action: a.invoice?.action, rate: a.invoice?.rate, invoice: a.invoice?.number }
    checks.A_appended_or_created = a.ok && (a.outcome === 'appended' || a.outcome === 'created_invoice')
    checks.A_rate_200 = a.invoice?.rate === 200
    checks.A_has_order = Boolean(a.serviceOrderId)

    // B. Sterling Subaru — new dealer, likely creates a fresh invoice (U prefix)
    const b = await checkInDealerVehicle({
      stockNumber: `U${rid}1`, vin: `4S4WX${rid}B10000`, year: '2026', make: 'Subaru', model: 'Forester',
      color: 'River Rock', tagColor: 'yellow', approvedBy: 'selftest', dataType: 'test',
    })
    track(b); results.B_subaru = { outcome: b.outcome, action: b.invoice?.action, invoice: b.invoice?.number }
    checks.B_ok = b.ok && (b.outcome === 'created_invoice' || b.outcome === 'appended')

    // C. Sterling Auto new vehicle (T prefix) → pricing prompt, NO writes
    const c = await checkInDealerVehicle({
      stockNumber: `T${rid}1`, vin: `1GKS1${rid}C10000`, year: '2026', make: 'GMC', model: 'Yukon',
      color: 'White', tagColor: 'white', approvedBy: 'selftest', dataType: 'test',
    })
    track(c); results.C_prompt = { outcome: c.outcome, promptRequired: c.pricing?.promptRequired, signals: c.pricing?.signals }
    checks.C_prompt_required = c.outcome === 'pricing_prompt_required'
    checks.C_no_writes = !c.serviceOrderId && !c.invoice

    // C2. Resubmit with $125 chosen
    const c2 = await checkInDealerVehicle({
      stockNumber: `T${rid}1`, vin: `1GKS1${rid}C10000`, year: '2026', make: 'GMC', model: 'Yukon',
      color: 'White', tagColor: 'white', approvedBy: 'selftest', dataType: 'test', rate: 125,
    })
    track(c2); results.C2_125 = { outcome: c2.outcome, rate: c2.invoice?.rate, invoice: c2.invoice?.number }
    checks.C2_rate_125 = c2.invoice?.rate === 125
    checks.C2_ok = c2.ok

    // D. Duplicate — reuse A's stock + VIN → blocked
    const d = await checkInDealerVehicle({
      stockNumber: `K${rid}1`, vin: `1HGES${rid}A10000`, year: '2021', make: 'Honda', model: 'Civic',
      color: 'Gray', tagColor: 'yellow', approvedBy: 'selftest', dataType: 'test',
    })
    track(d); results.D_duplicate = { outcome: d.outcome, reason: d.duplicate?.reason }
    checks.D_blocked = d.outcome === 'duplicate' && !d.ok

    const pass = Object.values(checks).every(Boolean)
    return NextResponse.json({ ok: pass, checks, results, cleanup: await cleanup(created) })
  } catch (err) {
    await cleanup(created)
    return NextResponse.json({ ok: false, error: String(err), results }, { status: 500 })
  }
}

async function cleanup(created: Array<{ scanId?: string; orderId?: string; vehicleId?: string }>) {
  let orders = 0, scans = 0
  for (const c of created) {
    if (c.orderId) { await deleteOrderCascade(c.orderId, c.vehicleId); orders++ }
    if (c.scanId)  { await deleteScanCascade(c.scanId); scans++ }
  }
  return { ordersDeleted: orders, scansDeleted: scans }
}
