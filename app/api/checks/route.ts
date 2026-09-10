/**
 * /api/checks
 *   GET  — recent checks (manager-only). No sensitive bank data (only a QBO account reference is stored).
 *   POST — create + record a check in QuickBooks (the money mutation). Idempotent via idempotencyKey.
 *          Returns { recorded } so the client only proceeds to print after a real QB recording.
 *
 * Manager-gated (Darryl/Tony/Torlan) — never ordinary employees. Node runtime (QB client uses node:crypto).
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { createAndRecordCheck, CheckValidationError, type WriteCheckInput } from '@/apps/checks/service'
import { listRecentChecks } from '@/apps/checks/db'
import { AmbiguousVendorError, VendorNotFoundError } from '@/apps/checks/vendor'
import { SequenceNotInitializedError } from '@/apps/checks/numbering'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ checks: await listRecentChecks(50) })
}

export async function POST(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: Partial<WriteCheckInput>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

  const input: WriteCheckInput = {
    payeeName: String(body.payeeName ?? ''),
    vendorId: body.vendorId ?? null,
    allowCreateVendor: !!body.allowCreateVendor,
    amountCents: Number(body.amountCents),
    memo: body.memo ?? null,
    category: body.category as WriteCheckInput['category'],
    linkedJobId: body.linkedJobId ?? null,
    linkedVehicleId: body.linkedVehicleId ?? null,
    checkDate: body.checkDate ?? null,
    idempotencyKey: String(body.idempotencyKey ?? ''),
  }

  try {
    const result = await createAndRecordCheck(input, { key: actor.key, name: actor.name })
    return NextResponse.json({ ok: result.recorded, ...result })
  } catch (e) {
    if (e instanceof AmbiguousVendorError) return NextResponse.json({ error: 'ambiguous_vendor', message: e.message, matches: e.matches }, { status: 409 })
    if (e instanceof VendorNotFoundError) return NextResponse.json({ error: 'vendor_not_found', message: e.message }, { status: 409 })
    if (e instanceof SequenceNotInitializedError) return NextResponse.json({ error: 'sequence_not_initialized', message: e.message }, { status: 409 })
    if (e instanceof CheckValidationError) return NextResponse.json({ error: e.code, message: e.message }, { status: 400 })
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}
