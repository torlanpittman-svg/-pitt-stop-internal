/**
 * GET /api/quick-entry/customers?q=...  → returning retail customers matching the
 * query (name / phone / email), each with their known vehicles. Read-only, no writes.
 *
 * Primary source is the customer directory (customers + customer_vehicles), built by
 * importing AutoLeap/QuickBooks/Quick Entry. Quick Entry job history is unioned in as
 * a fallback so customers captured only via Quick Entry still appear and so their saved
 * vehicles attach to the matching directory person. Dealer records are not included.
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
  const phoneClause = digits.length >= 3

  const db = getDb()

  // 1) Directory (primary): clean contact info + any linked saved vehicles.
  const dir = await db.execute(dsql`
    SELECT c.display_name AS "customerName", c.phone AS "customerPhone", c.email AS "customerEmail",
           v.id AS "vehicleId", v.year, v.make, v.model, v.vin
    FROM customers c
    LEFT JOIN customer_vehicles cv ON cv.customer_id = c.id
    LEFT JOIN vehicles v ON v.id = cv.vehicle_id
    WHERE c.display_name ILIKE ${like}
       OR c.email ILIKE ${like}
       ${phoneClause ? dsql`OR c.normalized_phone LIKE ${'%' + digits + '%'}` : dsql``}
    ORDER BY c.display_name ASC
    LIMIT 200
  `)

  // 2) Quick Entry history (fallback): captures QE-only customers + their vehicles.
  const qe = await db.execute(dsql`
    SELECT qj.customer_name AS "customerName", qj.customer_phone AS "customerPhone", qj.customer_email AS "customerEmail",
           qj.vehicle_id AS "vehicleId", v.year, v.make, v.model, v.vin
    FROM quick_entry_jobs qj
    LEFT JOIN vehicles v ON v.id = qj.vehicle_id
    WHERE qj.customer_name ILIKE ${like}
       OR qj.customer_email ILIKE ${like}
       ${phoneClause ? dsql`OR regexp_replace(coalesce(qj.customer_phone,''), '\\D', '', 'g') LIKE ${'%' + digits + '%'}` : dsql``}
    ORDER BY qj.created_at DESC
    LIMIT 200
  `)

  // Directory rows first so their contact info is authoritative when a person appears
  // in both; the aggregator merges by phone→email→name and unions distinct vehicles.
  const list = [
    ...((dir.rows ?? dir) as unknown as JobRow[]),
    ...((qe.rows ?? qe) as unknown as JobRow[]),
  ]
  return NextResponse.json({ ok: true, customers: aggregateCustomers(list, 8) })
}
