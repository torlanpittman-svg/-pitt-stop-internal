/**
 * POST /api/workflow/orders/[id]/customer  { name?, phone?, email? }
 *
 * Manager/admin correction of a Job's customer contact info. Updates the AUTHORITATIVE
 * existing records in place — service_orders.customer_name (Work Board title) + the Job's
 * quick_entry_jobs contact row — so the Customer↔Vehicle↔Job relationship is preserved and
 * NO duplicate customer is created. Never touches completed_at / production attribution.
 * Audited (customer_corrected, before→after). Retail QB-linked Jobs are flagged
 * "QuickBooks sync needed" (no retail QB write here). Dealer name is not editable here.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/platform/db'
import { eq, desc } from 'drizzle-orm'
import { getOrderWithContext, logEvent } from '@/apps/workflow/db'
import { flagQbSyncNeededIfInvoiced } from '@/apps/workflow/estimate-db'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { isDealerOrder } from '@/apps/workflow/fees'
import { serviceOrders } from '@/apps/workflow/schema'
import { quickEntryJobs } from '@/apps/quick-entry/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const clean = (v: unknown): string | null => { const s = (v == null ? '' : String(v)).trim(); return s || null }

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await authenticatedActorFromRequest(req)
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ ok: false, error: 'Only a manager or admin can edit customer info.' }, { status: 403 })
  }
  const order = await getOrderWithContext(id)
  if (!order) return NextResponse.json({ ok: false, error: 'Job not found' }, { status: 404 })
  if (isDealerOrder(order)) return NextResponse.json({ ok: false, error: 'Dealer customer is managed by Dealer Check-In.' }, { status: 400 })

  const body = await req.json().catch(() => ({})) as { name?: string; phone?: string; email?: string }
  const db = getDb()
  const [qe] = await db.select({ id: quickEntryJobs.id, name: quickEntryJobs.customerName, phone: quickEntryJobs.customerPhone, email: quickEntryJobs.customerEmail })
    .from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, id)).orderBy(desc(quickEntryJobs.createdAt)).limit(1)

  const before = { name: order.customerName ?? qe?.name ?? null, phone: qe?.phone ?? null, email: qe?.email ?? null }
  const after = {
    name:  body.name  !== undefined ? clean(body.name)  : before.name,
    phone: body.phone !== undefined ? clean(body.phone) : before.phone,
    email: body.email !== undefined ? clean(body.email) : before.email,
  }
  const changed = (['name', 'phone', 'email'] as const).filter((k) => (before[k] ?? '') !== (after[k] ?? ''))
  if (changed.length === 0) return NextResponse.json({ ok: true, order, changed: [] })

  // Update the authoritative records in place (no new customer, relationship preserved).
  if (changed.includes('name') && after.name) await db.update(serviceOrders).set({ customerName: after.name, updatedAt: new Date() }).where(eq(serviceOrders.id, id))
  if (qe) {
    await db.update(quickEntryJobs).set({
      customerName: after.name ?? qe.name, customerPhone: after.phone, customerEmail: after.email,
    }).where(eq(quickEntryJobs.id, qe.id))
  }

  const qbSyncNeeded = await flagQbSyncNeededIfInvoiced(id, 'customer info changed')
  await logEvent({ serviceOrderId: id, eventType: 'customer_corrected', employeeName: actor.name, note: JSON.stringify({ changed, before, after, qbSyncNeeded }) })

  const updated = await getOrderWithContext(id)
  return NextResponse.json({ ok: true, order: updated, changed, qbSyncNeeded })
}
