// READ-ONLY production baseline for the insurance-restoration project. No writes. Prints aggregates only (no PII).
import { readFileSync } from 'node:fs'
for (const l of readFileSync('.env.local', 'utf8').split('\n')) { const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '') }
import { sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
const db = getDb()
const rows = async <T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> => {
  const r: unknown = await db.execute(q)
  return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? [])
}
const pat = `(overspray|over spray|vandal|key(ed)? scratch|break[- ]?in|broken glass|glass|window|windshield|water damage|flood|wet carpet|extraction|mold|mildew|hail|dent|pdr|insurance|claim)`
async function main() {
  console.log('== service_catalog matches ==')
  console.table(await rows(sql`SELECT name, qb_description, active FROM service_catalog WHERE name ~* ${pat} OR coalesce(qb_description,'') ~* ${pat} ORDER BY name LIMIT 60`))
  console.log('== completed retail orders (last 24 months) whose services text matches a restoration pattern: by pattern ==')
  for (const p of ['overspray|over spray', 'vandal|key(ed)? ', 'glass|window|windshield', 'water|flood|wet|extraction|mold|mildew', 'hail|dent|pdr', 'insurance|claim']) {
    const r = await rows(sql`
      SELECT count(*)::int AS jobs,
             coalesce(sum(je.total_cents),0)::int AS est_total_cents,
             count(*) filter (where je.qb_invoice_id is not null)::int AS invoiced_jobs,
             coalesce(sum(je.total_cents) filter (where je.qb_invoice_id is not null),0)::int AS invoiced_cents
      FROM service_orders so LEFT JOIN job_estimates je ON je.service_order_id = so.id
      WHERE so.cancelled_at IS NULL AND so.completed_at >= now() - interval '24 months'
        AND (so.services::text ~* ${p} OR coalesce(so.notes,'') ~* ${p})`)
    console.log(p.padEnd(45), JSON.stringify(r[0]))
  }
  console.log('== all completed orders last 12 months (denominator) ==')
  console.log(JSON.stringify((await rows(sql`SELECT count(*)::int AS jobs, coalesce(sum(je.total_cents),0)::int AS est_total_cents, count(*) filter (where je.qb_invoice_id is not null)::int AS invoiced_jobs FROM service_orders so LEFT JOIN job_estimates je ON je.service_order_id = so.id WHERE so.cancelled_at IS NULL AND so.completed_at >= now() - interval '12 months'`))[0]))
  console.log('== job_line_items: do cost_cents get filled? (last 12 months) ==')
  console.log(JSON.stringify((await rows(sql`SELECT type, count(*)::int AS lines, count(*) filter (where cost_cents > 0)::int AS with_cost, coalesce(sum(price_cents),0)::int AS price_cents, coalesce(sum(cost_cents),0)::int AS cost_cents FROM job_line_items jli JOIN job_services js ON js.id = jli.job_service_id JOIN job_estimates je ON je.id = js.job_estimate_id JOIN service_orders so ON so.id = je.service_order_id WHERE so.completed_at >= now() - interval '12 months' GROUP BY type ORDER BY type`))))
  console.log('== marketing module state ==')
  console.log(JSON.stringify((await rows<{ key: string; value: unknown }>(sql`SELECT key, value FROM app_settings WHERE key IN ('marketing_enabled','marketing_config','booking_config','retail_qb_payment_enabled')`)).map((r) => ({ key: r.key, value: typeof r.value === 'string' ? r.value.slice(0, 160) : JSON.stringify(r.value).slice(0, 160) }))))
  console.log('== leads / quote_requests / attribution counts ==')
  console.log(JSON.stringify((await rows(sql`SELECT (SELECT count(*)::int FROM marketing_leads) leads, (SELECT count(*)::int FROM marketing_leads WHERE created_at >= now() - interval '90 days') leads_90d, (SELECT count(*)::int FROM quote_requests) quote_requests, (SELECT count(*)::int FROM marketing_attribution) attribution_rows, (SELECT count(*)::int FROM marketing_attribution WHERE service_order_id IS NOT NULL) attribution_with_order, (SELECT count(*)::int FROM appointments) appointments, (SELECT count(*)::int FROM appointments WHERE attribution <> '{}'::jsonb) appointments_with_attribution, (SELECT count(*)::int FROM service_orders WHERE referral_source IS NOT NULL) orders_with_referral`))[0]))
  console.log('== leads by source/status ==')
  console.table(await rows(sql`SELECT source, status, requested_service, count(*)::int FROM marketing_leads GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 20`))
  console.log('== quote_requests email status ==')
  console.table(await rows(sql`SELECT email_status, count(*)::int FROM quote_requests GROUP BY 1`))
  console.log('== quote_requests columns (prod schema check) ==')
  console.log((await rows<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns WHERE table_name='quote_requests' ORDER BY ordinal_position`)).map((r) => r.column_name).join(','))
  console.log('== migrations 0071-0075 applied? (tables/cols exist) ==')
  console.log(JSON.stringify((await rows(sql`SELECT to_regclass('quote_requests') qr, to_regclass('gift_card_events') gc, (SELECT count(*) FROM information_schema.columns WHERE table_name='marketing_leads' AND column_name='referral_source') ml_ref, (SELECT count(*) FROM information_schema.columns WHERE table_name='service_orders' AND column_name='referral_source') so_ref`))[0]))
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
