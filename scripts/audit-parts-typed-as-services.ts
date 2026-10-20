/**
 * READ-ONLY audit: open Jobs whose estimate still has PARTS stored as SERVICE lines (the Schnabel shape —
 * a pre-parts-workflow estimate where carpets/filters were typed as services with labor prices). These
 * show under Services on the Job/Work Board and bill as Labor until corrected.
 *
 * Run: node_modules/.bin/tsx scripts/audit-parts-typed-as-services.ts [serviceOrderId]
 *
 * It only SELECTs and prints candidates; it changes nothing. The correction is a staff decision made in
 * the app (Estimate & Invoice → tap the line → "This line is a part…" / "Convert to part"), which runs the
 * audited convertServiceToPart: same row and price line (price/qty/tax unchanged), a tracked part, an
 * installation-labor check, and a QuickBooks "sync needed" flag if an invoice is linked.
 *
 * A candidate = unmatched (no catalog identity) service line whose wording reads as a part, OR whose title
 * carries a part-number-like token (letters+digits, 8+ chars). Heuristic on purpose — it only proposes;
 * a person confirms each line.
 */
import { readFileSync } from 'node:fs'
import { classifyPartWording } from '@/apps/quick-entry/service-interpret'

for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue
  let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1)
  if (!process.env[m[1]]) process.env[m[1]] = v
}

const PART_NO = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{8,}\b/

;(async () => {
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(process.env.DATABASE_URL!)
  const only = process.argv[2] ?? null
  const rows = await sql`
    SELECT so.id AS order_id, so.order_number, so.customer_name, so.status, je.qb_invoice_id,
           js.id AS service_id, js.title,
           (SELECT count(*)::int FROM job_line_items l WHERE l.job_service_id = js.id AND l.generated = false) AS lines,
           (SELECT sum(l.price_cents * l.qty)::int FROM job_line_items l WHERE l.job_service_id = js.id AND l.generated = false) AS cents
      FROM service_orders so
      JOIN job_estimates je ON je.service_order_id = so.id
      JOIN job_services js ON js.job_estimate_id = je.id
     WHERE so.status NOT IN ('delivered', 'cancelled')
       AND js.kind = 'service' AND js.source <> 'system' AND js.catalog_id IS NULL
       AND (${only}::uuid IS NULL OR so.id = ${only}::uuid)
     ORDER BY so.created_at, js.sort_order, js.created_at`
  const hits = rows.filter((r) => classifyPartWording(String(r.title)) || PART_NO.test(String(r.title)))
  const byOrder = new Map<string, typeof hits>()
  for (const h of hits) byOrder.set(String(h.order_id), [...(byOrder.get(String(h.order_id)) ?? []), h])
  console.log(`Read-only. ${byOrder.size} open Job(s), ${hits.length} candidate line(s). Nothing was changed.\n`)
  for (const [id, list] of byOrder) {
    const h = list[0]
    console.log(`${h.order_number} · ${h.customer_name ?? '—'} · ${h.status}${h.qb_invoice_id ? ' · QB invoice linked (will be flagged sync-needed)' : ''}  [${id}]`)
    for (const l of list) {
      const why = classifyPartWording(String(l.title)) ? 'part wording' : 'part number'
      const note = Number(l.lines) > 1 ? ' — several price lines: use "Clarify" instead of converting' : ''
      console.log(`   • ${l.title}  ($${((Number(l.cents) || 0) / 100).toFixed(2)}, ${why})${note}  service ${l.service_id}`)
    }
    console.log()
  }
})()
