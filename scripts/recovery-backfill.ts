/**
 * One-off: put the customer cancellations made BEFORE Lead Recovery existed into the manager review queue.
 *
 *   node_modules/.bin/tsx scripts/recovery-backfill.ts            ← DRY RUN (default): SELECTs only, lists what would be imported
 *   ALLOW_PROD_DB_WRITES=1 node_modules/.bin/tsx scripts/recovery-backfill.ts --apply
 *
 * What --apply does, per cancellation: one appointment_recoveries row with status 'review' (+ its append-only
 * 'enrolled' event marked historical). That is all. It NEVER queues or sends an email — an imported row cannot
 * start by itself whatever the settings, and these customers booked before the email-consent checkbox existed, so
 * the module refuses to email them until a manager records their permission.
 *
 * Scope: appointments whose latest `cancelled` event says the CUSTOMER cancelled, excluding controlled test
 * records (first name "ZZ…", example.com addresses). Pitt Stop cancellations are never imported.
 * Idempotent: an appointment already in the queue is skipped (unique appointment_id), so a re-run adds nothing.
 * Requires migration 0082 to be applied first (--apply stops with a clear message if it is not).
 */
import { readFileSync } from 'node:fs'

for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue
  let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1)
  if (!process.env[m[1]]) process.env[m[1]] = v
}

;(async () => {
  const apply = process.argv.includes('--apply')
  const { sql } = await import('drizzle-orm')
  const { getDb } = await import('@/platform/db')
  const { getAppointment } = await import('@/apps/appointments/db')
  const { enrollCancellation } = await import('@/apps/appointments/recovery')
  const rowsOf = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Record<string, unknown>[]
  const db = getDb()
  console.log(`database endpoint: ${new URL(process.env.APP_DATABASE_URL ?? '').hostname.split('.')[0]}   mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`)

  const hasTable = rowsOf(await db.execute(sql`SELECT to_regclass('public.appointment_recoveries') IS NOT NULL AS ok`))[0]?.ok === true
  const already = hasTable ? sql`EXISTS (SELECT 1 FROM appointment_recoveries r WHERE r.appointment_id = a.id)` : sql`false`
  const found = rowsOf(await db.execute(sql`
    SELECT a.id, a.reference, a.local_date, a.service_labels, a.cancelled_at, (a.email IS NOT NULL AND a.email <> '') AS has_email,
      a.customer_id IS NOT NULL AS has_customer, ${already} AS already_queued,
      extract(epoch FROM (a.cancelled_at - a.created_at)) <= 300 AS quick_cancel,
      EXISTS (SELECT 1 FROM appointments b WHERE b.id <> a.id AND b.status <> 'cancelled' AND b.created_at > a.cancelled_at
        AND ((a.email IS NOT NULL AND lower(b.email) = lower(a.email)) OR (coalesce(a.normalized_phone, '') <> '' AND b.normalized_phone = a.normalized_phone))) AS booked_again
    FROM appointments a
    JOIN LATERAL (SELECT meta FROM appointment_events e WHERE e.appointment_id = a.id AND e.event_type = 'cancelled' ORDER BY e.created_at DESC LIMIT 1) ev ON true
    WHERE a.status = 'cancelled' AND ev.meta->>'by' = 'customer'
      AND a.first_name NOT ILIKE 'ZZ%' AND coalesce(a.email, '') NOT ILIKE '%example.com'
    ORDER BY a.cancelled_at`))
  // References and service names only — never contact details.
  console.table(found.map((r) => ({ reference: r.reference, date: String(r.local_date).slice(0, 15), services: String(r.service_labels).slice(0, 44),
    email: r.has_email ? 'yes' : 'no', customerRecord: r.has_customer ? 'yes' : 'no', cancelledWithin5Min: r.quick_cancel ? 'yes' : 'no',
    bookedAgainSince: r.booked_again ? 'yes' : 'no', alreadyQueued: r.already_queued ? 'yes' : 'no' })))
  console.log(`${found.length} customer cancellation(s) found; ${found.filter((r) => !r.already_queued).length} to import.`)
  if (!apply) { console.log('Dry run only — nothing was written. Re-run with --apply after migration 0082 is applied.'); return }
  if (!hasTable) { console.error('appointment_recoveries does not exist — apply migration 0082 first. Nothing was written.'); process.exit(1) }

  let imported = 0
  for (const r of found.filter((x) => !x.already_queued)) {
    const appt = await getAppointment(String(r.id))
    if (!appt) continue
    const res = await enrollCancellation(appt, 'customer', { actor: 'backfill', historical: true })
    if (res.recoveryId && !res.started) imported++
    console.log(`${appt.reference}: ${res.recoveryId ? 'queued for review' : `skipped — ${res.verdict.reason}`}`)
  }
  const [chk] = rowsOf(await db.execute(sql`SELECT count(*)::int AS queued, (SELECT count(*)::int FROM appointment_notifications WHERE kind IN ('recovery_1', 'recovery_2', 'recovery_3')) AS recovery_emails
    FROM appointment_recoveries WHERE enrolled_by = 'backfill'`))
  console.log(`imported ${imported}. In the queue from this import: ${chk.queued}. Recovery emails queued in total: ${chk.recovery_emails} (must be 0 unless follow-ups were started separately).`)
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
