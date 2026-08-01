/**
 * POST /api/admin/migrate-images?table=<t>&column=<c>&limit=<n>
 * Header: X-Migration-Key: <MIGRATION_KEY>
 *
 * Phase 2 of the base64 → Vercel Blob migration. Processes a small, restartable
 * batch: decode each base64 image, upload to Blob (deterministic key → idempotent),
 * verify it is publicly accessible with a matching byte length, and record the
 * result in image_migration_log. The SOURCE TABLES ARE NOT MODIFIED here — the
 * base64 stays in place as the backup and keeps displaying. Cleanup (removing
 * base64) is a separate later phase. No QuickBooks interaction.
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { put } from '@vercel/blob'
import { neon } from '@neondatabase/serverless'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const LOG = 'admin:migrate-images'
const ALLOWED: Record<string, string[]> = {
  estimate_photos: ['photo_url'],
  vehicle_entries: ['photo_url', 'original_photo_url', 'stock_debug_overlay_url', 'stock_number_crop_url'],
}

function parseDataUrl(v: string): { mime: string; buffer: Buffer } | null {
  const comma = v.indexOf(',')
  if (!v.startsWith('data:') || comma < 0) return null
  const header = v.slice(5, comma) // e.g. "image/jpeg;base64"
  const mime = header.split(';')[0] || 'image/jpeg'
  const isB64 = /;base64/i.test(header)
  const data = v.slice(comma + 1)
  const buffer = isB64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8')
  return { mime, buffer }
}

export async function POST(req: Request) {
  if (!process.env.MIGRATION_KEY || req.headers.get('x-migration-key') !== process.env.MIGRATION_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const url = new URL(req.url)
  const table = url.searchParams.get('table') ?? ''
  const column = url.searchParams.get('column') ?? ''
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '3', 10) || 3, 1), 10)
  if (!ALLOWED[table]?.includes(column)) {
    return NextResponse.json({ error: 'table/column not allowed', allowed: ALLOWED }, { status: 400 })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const col = sql.unsafe(`"${column}"`)
  const tbl = sql.unsafe(`"${table}"`)

  // Rows still base64 and not already migrated (idempotent + restartable).
  const rows = (await sql`
    select t.id::text as id, t.${col} as val
    from ${tbl} t
    where t.${col} like 'data:%'
      and not exists (
        select 1 from image_migration_log l
        where l.source_table = ${table} and l.row_id = t.id and l.column_name = ${column}
          and l.status in ('migrated','verified','cleaned')
      )
    order by t.id
    limit ${limit}
  `) as Array<{ id: string; val: string }>

  const results: Array<{ id: string; status: string; bytes?: number; error?: string }> = []
  for (const r of rows) {
    try {
      const parsed = parseDataUrl(r.val)
      if (!parsed) throw new Error('not a base64 data URL')
      const { mime, buffer } = parsed
      if (buffer.length === 0) throw new Error('empty image')
      const sha = createHash('sha256').update(buffer).digest('hex')
      const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
      const key = `migrated/${table}/${r.id}-${column}.${ext}` // deterministic → idempotent
      const blob = await put(key, buffer, { access: 'public', contentType: mime, allowOverwrite: true })

      // Verify the uploaded object is accessible + byte length matches.
      const check = await fetch(blob.url)
      if (!check.ok) throw new Error(`verify GET ${check.status}`)
      const len = Number(check.headers.get('content-length') ?? '0')
      if (len && len !== buffer.length) throw new Error(`byte mismatch ${len}!=${buffer.length}`)

      await sql`
        insert into image_migration_log (source_table, row_id, column_name, old_kind, old_bytes, old_sha256, blob_url, status, migrated_at)
        values (${table}, ${r.id}::uuid, ${column}, 'base64', ${buffer.length}, ${sha}, ${blob.url}, 'verified', now())
        on conflict (source_table, row_id, column_name) do update
          set blob_url = excluded.blob_url, old_bytes = excluded.old_bytes, old_sha256 = excluded.old_sha256,
              status = 'verified', migrated_at = now(), error = null`
      results.push({ id: r.id, status: 'verified', bytes: buffer.length })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await sql`
        insert into image_migration_log (source_table, row_id, column_name, old_kind, status, error)
        values (${table}, ${r.id}::uuid, ${column}, 'base64', 'failed', ${msg})
        on conflict (source_table, row_id, column_name) do update set status = 'failed', error = ${msg}`
        .catch(() => {})
      logger.error(LOG, 'row_failed', { table, column, id: r.id, error: msg })
      results.push({ id: r.id, status: 'failed', error: msg })
    }
  }

  const [{ remaining }] = (await sql`
    select count(*)::int as remaining from ${tbl} t
    where t.${col} like 'data:%'
      and not exists (
        select 1 from image_migration_log l
        where l.source_table = ${table} and l.row_id = t.id and l.column_name = ${column}
          and l.status in ('migrated','verified','cleaned'))`) as Array<{ remaining: number }>

  return NextResponse.json({
    ok: true, table, column,
    processed: results.length,
    verified: results.filter((r) => r.status === 'verified').length,
    failed: results.filter((r) => r.status === 'failed').length,
    remaining,
    results,
  })
}
