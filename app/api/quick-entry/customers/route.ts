/**
 * GET /api/quick-entry/customers?q=...  → returning retail customers matching the
 * query (name / phone / email), each with their known vehicles. Read-only; derived
 * from existing quick_entry_jobs + vehicles. No AutoLeap, no writes. Dealer records
 * are not included (Dealer Check-In is separate).
 */
import { NextResponse } from 'next/server'
import { sql as dsql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { aggregateCustomers, normalizePhone, type JobRow } from '@/apps/quick-entry/customers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
  if (q.length < 2) return NextResponse.json({ ok: true, customers: [] })
  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`
  const digits = normalizePhone(q)

  const db = getDb()
  // Match name/email by ILIKE; phone by digits-only contains. Newest first so the
  // aggregator keeps the latest contact info per person.
  const rows = await db.execute(dsql`
    SELECT qj.customer_name AS "customerName", qj.customer_phone AS "customerPhone", qj.customer_email AS "customerEmail",
           qj.vehicle_id AS "vehicleId", v.year, v.make, v.model, v.vin
    FROM quick_entry_jobs qj
    LEFT JOIN vehicles v ON v.id = qj.vehicle_id
    WHERE qj.customer_name ILIKE ${like}
       OR qj.customer_email ILIKE ${like}
       ${digits.length >= 3 ? dsql`OR regexp_replace(coalesce(qj.customer_phone,''), '\\D', '', 'g') LIKE ${'%' + digits + '%'}` : dsql``}
    ORDER BY qj.created_at DESC
    LIMIT 200
  `)
  const list = (rows.rows ?? rows) as unknown as JobRow[]
  return NextResponse.json({ ok: true, customers: aggregateCustomers(list, 8) })
}
