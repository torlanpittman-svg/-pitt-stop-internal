/**
 * GET /api/workflow/orders/[id]/contact — retail customer phone/email for the Work Board
 * contact popup. Read-only; staff-facing (same posture as the Job read route). NO pricing.
 *
 * Source rule: prefer the canonical customer directory when a match exists; otherwise fall
 * back to this Job's Quick Entry contact history. Never creates records, never queries
 * AutoLeap. Dealer Jobs return no retail contact.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/platform/db'
import { and, eq, desc, sql, or } from 'drizzle-orm'
import { getOrderWithContext } from '@/apps/workflow/db'
import { isDealerOrder } from '@/apps/workflow/fees'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { customers } from '@/apps/directory/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const digits = (p?: string | null) => (p ?? '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')
const lc = (e?: string | null) => (e ?? '').trim().toLowerCase()

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const order = await getOrderWithContext(id)
  if (!order) return NextResponse.json({ ok: false, error: 'Job not found' }, { status: 404 })

  const customer = order.customerName?.trim() || null
  if (isDealerOrder(order)) {
    return NextResponse.json({ ok: true, customer, phone: null, email: null, isDealer: true, source: 'dealer' })
  }

  const db = getDb()
  // Job's own Quick Entry contact history (most recent for this order).
  const [qe] = await db.select({ name: quickEntryJobs.customerName, phone: quickEntryJobs.customerPhone, email: quickEntryJobs.customerEmail })
    .from(quickEntryJobs).where(eq(quickEntryJobs.serviceOrderId, id)).orderBy(desc(quickEntryJobs.createdAt)).limit(1)

  let phone = qe?.phone?.trim() || null
  let email = qe?.email?.trim() || null
  let source: 'directory' | 'quick_entry' | 'none' = qe ? 'quick_entry' : 'none'

  // Enrich missing fields from the canonical directory (matched by normalized phone/email/name).
  if (!phone || !email) {
    const np = digits(phone), ne = lc(email), nm = (customer ?? qe?.name ?? '').trim().toLowerCase()
    const conds = [
      ne ? eq(customers.normalizedEmail, ne) : null,
      np ? eq(customers.normalizedPhone, np) : null,
      nm ? sql`lower(${customers.displayName}) = ${nm}` : null,
    ].filter(Boolean) as never[]
    if (conds.length) {
      const [dir] = await db.select({ phone: customers.phone, email: customers.email }).from(customers).where(and(eq(customers.active, true), or(...conds))).limit(1)
      if (dir) {
        if (!phone && dir.phone) { phone = dir.phone; source = 'directory' }
        if (!email && dir.email) { email = dir.email; source = 'directory' }
      }
    }
  }

  return NextResponse.json({ ok: true, customer: customer || qe?.name || null, phone, email, isDealer: false, source })
}
