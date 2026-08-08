/**
 * AutoLeap Customer-CSV importer for the Pitt Stop customer directory.
 *
 *   node scripts/import-autoleap-customers.mjs [file.csv]              # DRY-RUN (default) — writes nothing
 *   node scripts/import-autoleap-customers.mjs [file.csv] --commit     # apply: upsert customers + queue reviews
 *   node scripts/import-autoleap-customers.mjs --rollback <batchId>    # undo a committed batch (deletes rows it created)
 *   node scripts/import-autoleap-customers.mjs --list-batches          # show recent import batches
 *
 * Flags: --file <path>  --limit <N>  (limit is for testing a subset)
 *
 * Safety: DRY-RUN is the default and touches nothing (not even metadata). It reads
 * the existing directory + the CSV and prints exactly what a commit WOULD do.
 * Commits are idempotent (keyed by source + natural source_key) and restartable —
 * re-running the same file updates in place instead of duplicating. Every created
 * row is stamped with the batch id so --rollback fully reverts a fresh import.
 *
 * This importer creates/updates rows ONLY in the new directory tables (customers,
 * customer_vehicles, possible_matches, customer_import_batches). It never touches
 * quick_entry_jobs, service_orders, AutoLeap, or QuickBooks.
 */
import { neon } from '@neondatabase/serverless'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import {
  parseCsv, mapHeaders, parseAutoLeapRow, sourceKeyFor, buildIndex, classify,
} from '../apps/directory/normalize.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SOURCE = 'autoleap'
const BATCH_SOURCE = 'autoleap_customer_csv'
const INBOX = join(ROOT, 'data', 'imports')

function loadEnvLocal() {
  try {
    for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (!process.env[m[1]]) process.env[m[1]] = v
    }
  } catch { /* optional */ }
}

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : null }

async function main() {
  loadEnvLocal()
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set (.env.local).'); process.exit(1) }
  const sql = neon(process.env.DATABASE_URL)

  if (has('--list-batches')) return listBatches(sql)
  if (has('--rollback')) return rollback(sql, valOf('--rollback'))

  const commit = has('--commit')
  const limit = valOf('--limit') ? parseInt(valOf('--limit'), 10) : null
  const file = valOf('--file') || argv.find((a) => a.endsWith('.csv')) || defaultCsv()
  if (!file || !existsSync(file)) {
    console.error(`CSV not found. Drop the AutoLeap Customer export in:\n  ${INBOX}/\nor pass a path:  node scripts/import-autoleap-customers.mjs <file.csv>`)
    process.exit(1)
  }

  const raw = readFileSync(file, 'utf8')
  const fileHash = createHash('sha256').update(raw).digest('hex')
  const rows = parseCsv(raw)
  if (rows.length < 2) { console.error('CSV has no data rows.'); process.exit(1) }

  const { map, headers, unmapped } = mapHeaders(rows[0])
  const missing = ['name', 'phone', 'email'].filter((k) => map[k] == null)

  console.log(`\n${'='.repeat(64)}`)
  console.log(`AutoLeap Customer import — ${commit ? 'COMMIT' : 'DRY-RUN'}`)
  console.log(`${'='.repeat(64)}`)
  console.log(`File:        ${basename(file)}`)
  console.log(`SHA-256:     ${fileHash.slice(0, 16)}…`)
  console.log(`Headers:     ${headers.join(' | ')}`)
  console.log(`Mapped:      ${Object.entries(map).map(([k, i]) => `${k}=[${i}]`).join('  ')}`)
  if (unmapped.length) console.log(`Unmapped:    ${unmapped.join(', ')}  (no dedicated column — preserved verbatim in source_values)`)
  if (missing.length) console.log(`⚠️  Missing expected columns: ${missing.join(', ')} — check the export/report`)

  // Existing directory (for cross-run idempotency + cross-source dedup)
  const existing = await sql`
    SELECT id, source, source_key AS "sourceKey", normalized_phone AS "normalizedPhone",
           normalized_email AS "normalizedEmail", lower(coalesce(display_name,'')) AS "normalizedName"
    FROM customers`
  const index = buildIndex(existing)

  let dataRows = rows.slice(1)
  if (limit) dataRows = dataRows.slice(0, limit)

  // Parse rows; collapse within-file duplicates by natural key (same phone/email/
  // name+date) BEFORE classifying, so each person is presented to the DB once and
  // every merge/update targets a real row. Empty rows are skipped here.
  let skipped = 0
  let collapsed = 0
  const uniq = new Map() // sourceKey -> merged record
  for (const cells of dataRows) {
    const rec = parseAutoLeapRow(cells, map)
    // Preserve the FULL raw row (incl. unmapped columns like address/zip/payments)
    // so nothing from the source is lost — kept verbatim in source_values.
    rec.raw = {}
    headers.forEach((h, i) => { const k = String(h ?? '').trim(); if (k) rec.raw[k] = String(cells[i] ?? '').trim() })
    if (!rec.normalizedName && !rec.normalizedPhone && !rec.normalizedEmail) { skipped++; continue }
    const key = sourceKeyFor(rec)
    const prev = uniq.get(key)
    if (prev) { mergeRecords(prev, rec); collapsed++ } else uniq.set(key, rec)
  }
  const records = [...uniq.values()]

  const buckets = { update: [], merge: [], new: [], review: [] }
  const typeCount = {}
  const reasonCount = {}

  for (const rec of records) {
    const d = classify(rec, index, SOURCE)
    if (d.action === 'skip') { skipped++; continue }
    buckets[d.action].push({ rec, d })
    reasonCount[d.reason] = (reasonCount[d.reason] || 0) + 1
    if (d.action === 'new' || d.action === 'merge') typeCount[rec.customerType] = (typeCount[rec.customerType] || 0) + 1
  }

  // ---- report ----
  const line = (label, n) => console.log(`  ${label.padEnd(30)} ${String(n).padStart(6)}`)
  console.log(`\nRows parsed: ${dataRows.length}   unique people: ${records.length}   (collapsed ${collapsed} in-file duplicates, skipped ${skipped} empty)`)
  console.log(`\nWhat a commit would do:`)
  line('→ new customers', buckets.new.length)
  line('→ merge into existing', buckets.merge.length)
  line('→ update (idempotent re-run)', buckets.update.length)
  line('→ owner review queue', buckets.review.length)

  console.log(`\nCustomer type (new + merged):`)
  for (const [t, n] of Object.entries(typeCount).sort((a, b) => b[1] - a[1])) line(t, n)

  console.log(`\nMatch reasons:`)
  for (const [r, n] of Object.entries(reasonCount).sort((a, b) => b[1] - a[1])) line(r, n)

  if (buckets.review.length) {
    console.log(`\nReview-queue samples (first 5):`)
    for (const { rec, d } of buckets.review.slice(0, 5))
      console.log(`  • ${rec.displayName || '(no name)'}  [${d.reason}]  candidates=${(d.candidateIds || []).length}`)
  }
  console.log(`\nNew-customer samples (first 5):`)
  for (const { rec } of buckets.new.slice(0, 5))
    console.log(`  • ${rec.displayName}  ${rec.phone || '—'}  ${rec.email || '—'}  (${rec.customerType})`)

  // persist a JSON report for the record (report only — not customer data)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync(join(INBOX, 'reports'), { recursive: true })
  const reportPath = join(INBOX, 'reports', `import-${stamp}.json`)
  writeFileSync(reportPath, JSON.stringify({
    file: basename(file), fileHash, mode: commit ? 'commit' : 'dry_run',
    rows: dataRows.length, uniquePeople: records.length, collapsed, skipped,
    counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    typeCount, reasonCount, unmapped, missing,
  }, null, 2))
  console.log(`\nReport written: ${reportPath.replace(ROOT + '/', '')}`)

  if (!commit) {
    console.log(`\n✅ DRY-RUN complete — NO changes written. Re-run with --commit to apply.\n`)
    return
  }

  // ---- commit ----
  console.log(`\nApplying changes…`)
  const [batch] = await sql`
    INSERT INTO customer_import_batches (source, file_name, file_hash, status, total_rows,
      matched_existing, new_customers, review_queued, skipped, summary)
    VALUES (${BATCH_SOURCE}, ${basename(file)}, ${fileHash}, 'committed', ${dataRows.length},
      ${buckets.merge.length + buckets.update.length}, ${buckets.new.length}, ${buckets.review.length},
      ${skipped}, ${JSON.stringify({ typeCount, reasonCount, unmapped, collapsed })})
    RETURNING id`
  const batchId = batch.id

  let created = 0, merged = 0, updated = 0, queued = 0
  for (const { rec } of buckets.new) { await insertCustomer(sql, rec, batchId); created++ }
  for (const { rec, d } of buckets.merge) { await mergeCustomer(sql, d.targetId, rec); merged++ }
  for (const { rec, d } of buckets.update) { await mergeCustomer(sql, d.targetId, rec); updated++ }
  for (const { rec, d } of buckets.review) { await queueReview(sql, batchId, rec, d); queued++ }

  console.log(`\n✅ COMMIT complete (batch ${batchId})`)
  console.log(`   created ${created} · merged ${merged} · updated ${updated} · queued ${queued}`)
  console.log(`   rollback with:  node scripts/import-autoleap-customers.mjs --rollback ${batchId}\n`)
}

// Fold a duplicate in-file row into the record we already kept for this natural key:
// fill any missing fields, keep the richer values, and upgrade a prospect once we
// see real invoiced activity.
function mergeRecords(prev, rec) {
  for (const f of ['firstName', 'lastName', 'displayName', 'company', 'phone', 'normalizedPhone',
    'email', 'normalizedEmail', 'createdDate', 'typeRaw']) {
    if (!prev[f] && rec[f]) prev[f] = rec[f]
  }
  prev.autoleapVehicleCount = Math.max(prev.autoleapVehicleCount || 0, rec.autoleapVehicleCount || 0) || null
  prev.invoicedAmount = (prev.invoicedAmount || 0) + (rec.invoicedAmount || 0)
  if (prev.customerType === 'prospect' && prev.invoicedAmount > 0) prev.customerType = 'retail'
}

async function insertCustomer(sql, rec, batchId) {
  await sql`
    INSERT INTO customers (first_name, last_name, display_name, company, phone, normalized_phone,
      email, normalized_email, customer_type, source, source_key, autoleap_vehicle_count,
      source_values, created_by_import_batch_id, first_seen_at)
    VALUES (${rec.firstName || null}, ${rec.lastName || null}, ${rec.displayName || null}, ${rec.company},
      ${rec.phone}, ${rec.normalizedPhone || null}, ${rec.email}, ${rec.normalizedEmail || null},
      ${rec.customerType}, ${SOURCE}, ${sourceKeyFor(rec)}, ${rec.autoleapVehicleCount},
      ${JSON.stringify({ autoleap: rec })}, ${batchId}, ${rec.createdDate ? new Date(rec.createdDate) : null})`
}

// Merge = fill only missing fields on the existing row; never overwrite good data.
// Records the AutoLeap source under source_values. Idempotent.
async function mergeCustomer(sql, targetId, rec) {
  await sql`
    UPDATE customers SET
      first_name       = coalesce(first_name, ${rec.firstName || null}),
      last_name        = coalesce(last_name, ${rec.lastName || null}),
      display_name     = coalesce(display_name, ${rec.displayName || null}),
      company          = coalesce(company, ${rec.company}),
      phone            = coalesce(phone, ${rec.phone}),
      normalized_phone = coalesce(normalized_phone, ${rec.normalizedPhone || null}),
      email            = coalesce(email, ${rec.email}),
      normalized_email = coalesce(normalized_email, ${rec.normalizedEmail || null}),
      source_key       = coalesce(source_key, ${sourceKeyFor(rec)}),
      autoleap_vehicle_count = coalesce(autoleap_vehicle_count, ${rec.autoleapVehicleCount}),
      source_values    = source_values || ${JSON.stringify({ autoleap: rec })}::jsonb,
      updated_at       = now()
    WHERE id = ${targetId}`
}

async function queueReview(sql, batchId, rec, d) {
  await sql`
    INSERT INTO possible_matches (import_batch_id, source, incoming, candidate_customer_ids, match_reason, score, status)
    VALUES (${batchId}, ${SOURCE}, ${JSON.stringify(rec)},
      ${JSON.stringify(d.candidateIds || [])}, ${d.reason}, ${d.score}, 'pending')`
}

async function rollback(sql, batchId) {
  if (!batchId) { console.error('Usage: --rollback <batchId>'); process.exit(1) }
  const [b] = await sql`SELECT id, status FROM customer_import_batches WHERE id = ${batchId}`
  if (!b) { console.error('Batch not found:', batchId); process.exit(1) }
  const cv = await sql`DELETE FROM customer_vehicles WHERE created_by_import_batch_id = ${batchId} RETURNING id`
  const cust = await sql`DELETE FROM customers WHERE created_by_import_batch_id = ${batchId} RETURNING id`
  const pm = await sql`DELETE FROM possible_matches WHERE import_batch_id = ${batchId} RETURNING id`
  await sql`UPDATE customer_import_batches SET status = 'rolled_back', rolled_back_at = now() WHERE id = ${batchId}`
  console.log(`Rolled back batch ${batchId}: removed ${cust.length} customers, ${cv.length} vehicle links, ${pm.length} review items.`)
  console.log(`Note: merges/updates into pre-existing customers are additive field-fills and are not auto-reverted.`)
}

async function listBatches(sql) {
  const rows = await sql`
    SELECT id, source, file_name, status, total_rows, new_customers, matched_existing, review_queued, created_at
    FROM customer_import_batches ORDER BY created_at DESC LIMIT 20`
  if (!rows.length) return console.log('No import batches yet.')
  for (const r of rows)
    console.log(`${r.created_at.toISOString?.() ?? r.created_at}  ${r.status.padEnd(11)} ${r.id}  ${r.file_name || ''}  rows=${r.total_rows} new=${r.new_customers} matched=${r.matched_existing} review=${r.review_queued}`)
}

function defaultCsv() {
  // newest .csv in data/imports/
  try {
    const files = readdirSync(INBOX).filter((f) => f.toLowerCase().endsWith('.csv'))
      .map((f) => ({ f, m: statSync(join(INBOX, f)).mtimeMs })).sort((a, b) => b.m - a.m)
    return files.length ? join(INBOX, files[0].f) : null
  } catch { return null }
}

main().catch((e) => { console.error('Import failed:', e); process.exit(1) })
