/**
 * Work Board "Remove from Work Board" — coordinated Job + QuickBooks removal for an accidental
 * check-in. MANAGER + ADMIN only (server-enforced from the signed session; employees denied).
 * This is a SCOPED authority: managers may correct the ONE invoice caused by this specific Job's
 * removal — it is not a general QuickBooks invoice-edit surface.
 *
 *   GET  → read-only PREVIEW of what removal will do (no QB link / remove one line / void
 *          standalone / blocked by payment / ambiguous). Never mutates.
 *   POST → execute: prove linkage, correct QB (remove line or void), THEN soft-cancel the Job.
 *          Fails closed (HTTP 409) on payment activity / ambiguous linkage / QB failure without
 *          soft-cancelling, so Pitt Stop and QuickBooks can never silently disagree. Idempotent.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { isRemovalAuthorizedRole } from '@/apps/workflow/removal'
import { planOrderRemoval, executeOrderRemoval } from '@/apps/workflow/order-removal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || !isRemovalAuthorizedRole(actor.role)) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  const result = await planOrderRemoval(id)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || !isRemovalAuthorizedRole(actor.role)) {
    return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  }
  const result = await executeOrderRemoval({ orderId: id, actor: actor.name })
  // Distinguish "not found" (404), a fail-closed block that left everything intact (409), and success (200).
  const status = result.ok ? 200
    : result.error === 'Job not found' ? 404
    : result.block ? 409
    : 400
  return NextResponse.json(result, { status })
}
