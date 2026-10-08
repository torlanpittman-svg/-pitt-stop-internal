/**
 * Occasional third-party billing for a work order (migration 0049). Manager/admin only.
 *
 *   GET  → current billing override (billing customer + recipient email + job contact), or nulls.
 *   POST → set/replace the override. Body: { billingCustomerId|null, invoiceRecipientEmail|null,
 *          jobContactName|null }. All-null clears it (back to billing the service customer).
 *
 * This NEVER changes the vehicle owner or the service customer's history — only who the QB invoice
 * is billed to and sent to. Setting it does not itself touch QuickBooks.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { getOrderBilling, setOrderBilling } from '@/apps/workflow/order-billing'
import { logEvent } from '@/apps/workflow/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireManager(req: Request) {
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) return null
  return actor
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!(await requireManager(req))) return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })
  const billing = await getOrderBilling(id)
  if (!billing) return NextResponse.json({ ok: false, error: 'Order not found.' }, { status: 404 })
  return NextResponse.json({ ok: true, billing })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await requireManager(req)
  if (!actor) return NextResponse.json({ ok: false, error: 'Managers and admins only.' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as { billingCustomerId?: string | null; invoiceRecipientEmail?: string | null; jobContactName?: string | null }
  const result = await setOrderBilling(id, body)
  if (!result.ok) return NextResponse.json(result, { status: 400 })

  const b = result.billing
  const note = b.billingCustomerId
    ? `third-party billing set → ${b.billingCustomerName ?? b.billingCustomerId}${b.invoiceRecipientEmail ? ` · invoice to ${b.invoiceRecipientEmail}` : ''}${b.jobContactName ? ` · contact ${b.jobContactName}` : ''}`
    : 'third-party billing cleared (bill the service customer)'
  await logEvent({ serviceOrderId: id, eventType: 'billing_updated', employeeName: actor.name, note }).catch(() => {})
  return NextResponse.json(result)
}
