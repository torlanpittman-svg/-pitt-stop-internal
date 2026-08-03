/**
 * Idempotent seed for the Quick Entry catalog (Pitt Stop DB only — no QB/AutoLeap).
 * Run: node_modules/.bin/tsx scripts/seed-quick-entry.ts
 * Safe to re-run: upserts by slug / (catalog,size,condition) / (catalog,alias) / slug.
 * Aliases use DO NOTHING so owner AI-approval flags are never clobbered.
 */
import { readFileSync } from 'node:fs'
for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue
  let v = m[2].trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1)
  if (!process.env[m[1]]) process.env[m[1]] = v
}

;(async () => {
  const { neon } = await import('@neondatabase/serverless')
  const { CATALOG_ITEMS, TECH_INSTRUCTIONS } = await import('@/apps/quick-entry/seed-data')
  const sql = neon(process.env.DATABASE_URL!)

  let items = 0, tiers = 0, aliases = 0, tech = 0
  for (const it of CATALOG_ITEMS) {
    const [row] = await sql`
      insert into service_catalog (slug,name,kind,quick_entry,has_size,has_condition,default_price_cents,price_editable,active,sort_order,source,requires_notes,requires_photo,qb_item_ref,qb_item_status,qb_sync_enabled,review_flag,notes,updated_at)
      values (${it.slug},${it.name},${it.kind},${it.quickEntry},${it.hasSize ?? false},${it.hasCondition ?? false},${it.defaultPriceCents},true,${it.active ?? true},${it.sortOrder},${it.source},${it.requiresNotes ?? false},${it.requiresPhoto ?? false},${it.qbItemRef},${it.qbItemStatus},${it.qbSyncEnabled},${it.reviewFlag ?? false},${it.notes ?? null},now())
      on conflict (slug) do update set
        name=excluded.name, kind=excluded.kind, quick_entry=excluded.quick_entry, has_size=excluded.has_size, has_condition=excluded.has_condition,
        default_price_cents=excluded.default_price_cents, active=excluded.active, sort_order=excluded.sort_order, source=excluded.source,
        requires_notes=excluded.requires_notes, requires_photo=excluded.requires_photo, qb_item_ref=excluded.qb_item_ref,
        qb_item_status=excluded.qb_item_status, qb_sync_enabled=excluded.qb_sync_enabled, review_flag=excluded.review_flag, notes=excluded.notes, updated_at=now()
      returning id`
    items++
    const cid = (row as { id: string }).id
    for (const t of it.tiers ?? []) {
      await sql`insert into service_price_tiers (catalog_id,size,condition,start_price_cents,sort_order)
        values (${cid},${t.size},${t.condition},${t.startPriceCents},${t.sortOrder})
        on conflict (catalog_id,size,condition) do update set start_price_cents=excluded.start_price_cents, sort_order=excluded.sort_order`
      tiers++
    }
    for (const a of it.aliases ?? []) {
      await sql`insert into service_aliases (catalog_id,alias,source) values (${cid},${a},'quickbooks')
        on conflict (catalog_id,alias) do nothing`
      aliases++
    }
  }
  for (const ti of TECH_INSTRUCTIONS) {
    await sql`insert into technician_instructions (slug,label,group_name,billable,sort_order,active)
      values (${ti.slug},${ti.label},${ti.group},false,${ti.sortOrder},true)
      on conflict (slug) do update set label=excluded.label, group_name=excluded.group_name, sort_order=excluded.sort_order`
    tech++
  }

  const [c] = await sql`select
    (select count(*)::int from service_catalog) catalog,
    (select count(*)::int from service_price_tiers) tiers,
    (select count(*)::int from service_aliases) aliases,
    (select count(*)::int from technician_instructions) tech`
  console.log('seed upserts:', { items, tiers, aliases, tech })
  console.log('table row counts:', c)
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1) })
