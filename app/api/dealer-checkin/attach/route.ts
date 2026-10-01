/**
 * POST /api/dealer-checkin/attach
 *   Attach (or recover) a QuickBooks dealer invoice line for an EXISTING Work
 *   Board job, without creating a second job or a duplicate line. Idempotent and
 *   partial-failure safe — see attach-invoice.ts.
 *   Body: { serviceOrderId: string, rate?: number }
 *
 * GET /api/dealer-checkin/attach?orderId=...
 *   Read-only invoice status for a job: none | pending | queued | linked | failed.
 *
 * Same gates as /api/dealer-checkin: employee/admin auth, and on production QB an
 * explicit X-QB-Write-Approved: true header before any write. Never emails/sends.
 */
import { NextResponse } from 'next/server'
import { attachInvoiceForOrder, dealerInvoiceStatusForOrder } from '@/apps/dealer-checkin/attach-invoice'
import { getEnvironment } from '@/apps/quickbooks/config'
import { employeeAuthorizedFromRequest, authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    if (!(await employeeAuthorizedFromRequest(req))) {
      return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
    }
    if (getEnvironment() === 'production' && req.headers.get('x-qb-write-approved') !== 'true') {
      return NextResponse.json(
        { ok: false, error: 'Production QuickBooks write requires explicit approval (X-QB-Write-Approved header).' },
        { status: 403 }
      )
    }
    const body = (await req.json()) as { serviceOrderId?: string; rate?: number | null }
    if (!body?.serviceOrderId) {
      return NextResponse.json({ ok: false, error: 'serviceOrderId is required' }, { status: 400 })
    }
    const actor = await authenticatedActorFromRequest(req)
    const result = await attachInvoiceForOrder({
      serviceOrderId: body.serviceOrderId,
      rate: body.rate ?? null,
      approvedBy: actor?.name ?? null,
    })
    const httpStatus = result.ok
      ? 200
      : result.outcome === 'order_not_found'
        ? 404
        : result.outcome === 'environment_blocked'
          ? 409
          : result.outcome === 'written_pending_link'
            ? 502
            : 422
    return NextResponse.json(result, { status: httpStatus })
  } catch (err) {
    const ref = Math.random().toString(36).slice(2, 8).toUpperCase()
    logger.error('dealer-checkin:attach', 'attach.unhandled', { ref, error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(
      { ok: false, outcome: 'error', error: `Could not complete the invoice attachment. Please retry. Reference: ${ref}` },
      { status: 500 }
    )
  }
}

export async function GET(req: Request) {
  if (!(await employeeAuthorizedFromRequest(req))) {
    return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
  }
  const orderId = new URL(req.url).searchParams.get('orderId')
  if (!orderId) return NextResponse.json({ ok: false, error: 'orderId is required' }, { status: 400 })
  const status = await dealerInvoiceStatusForOrder(orderId)
  return NextResponse.json({ ok: true, serviceOrderId: orderId, ...status })
}
