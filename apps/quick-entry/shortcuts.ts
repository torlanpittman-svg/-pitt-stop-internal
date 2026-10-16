/**
 * Service shortcuts + catalog management (manager/admin) — data layer.
 *
 * A shortcut is a quick-select button that REFERENCES a catalog item (stable identity). Its label
 * is display-only: renaming or hiding a shortcut never touches the catalog row, its QuickBooks
 * mapping, existing estimate lines, or historical invoices. Hiding = hidden_at (restorable).
 *
 * Catalog edits made here (canonical description, default price behavior, QuickBooks item) apply to
 * FUTURE additions: estimate lines snapshot the description when added (job_services
 * .catalog_description) and copy the price into their own line, so nothing existing is rewritten.
 * A QuickBooks item can only be SELECTED from the live item list — never created here.
 *
 * Every change appends to service_catalog_events (append-only audit). Permission checks live in the
 * API route (manager/admin); employees only read the active list.
 */
import { getDb } from '@/platform/db'
import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, ne, or, sql } from 'drizzle-orm'
import { serviceCatalog, serviceAliases, serviceShortcuts, serviceCatalogEvents, servicePriceTiers } from './schema'
import { jobServices, jobEstimates, serviceOrders } from '@/apps/workflow/schema'
import { normalizeServiceKey } from './catalog-identity'
import { isGenericOdorKey } from './service-interpret'
import { canonicalDescription } from './service-match-db'
import { queryQBO } from '@/apps/quickbooks/client'

export interface ShortcutView {
  id: string; catalogId: string; slug: string; label: string; group: string; sortOrder: number; hidden: boolean
  catalogName: string; description: string; qbDescription: string | null
  priceBehavior: 'manual' | 'fixed' | 'tiered'; defaultPriceCents: number | null
  qbItemRef: string | null; qbMapped: boolean; qbCandidateRef: string | null
  updatedBy: string | null; updatedAt: string
}

export const SHORTCUT_GROUPS = ['Details & washes', 'Paint & exterior', 'Interior & engine', 'Odor', 'Other'] as const

async function audit(catalogId: string | null, eventType: string, actor: string | null, note: Record<string, unknown>) {
  await getDb().insert(serviceCatalogEvents).values({ catalogId, eventType, actor, note: JSON.stringify(note) })
}

const cleanText = (v: unknown, max: number): string => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

type CatRow = typeof serviceCatalog.$inferSelect
const priceBehavior = (c: CatRow, tiered: boolean): ShortcutView['priceBehavior'] =>
  c.hasSize || c.hasCondition || tiered ? 'tiered' : c.defaultPriceCents != null ? 'fixed' : 'manual'
const isMapped = (c: CatRow) => c.archivedAt == null && c.qbSyncEnabled && c.qbItemStatus === 'existing' && !!c.qbItemRef

export async function listShortcuts(opts: { includeHidden?: boolean } = {}): Promise<ShortcutView[]> {
  const db = getDb()
  const rows = await db.select({ s: serviceShortcuts, c: serviceCatalog }).from(serviceShortcuts)
    .innerJoin(serviceCatalog, eq(serviceCatalog.id, serviceShortcuts.catalogId))
    .where(opts.includeHidden ? undefined : and(isNull(serviceShortcuts.hiddenAt), isNull(serviceCatalog.archivedAt), eq(serviceCatalog.active, true)))
    .orderBy(asc(serviceShortcuts.groupName), asc(serviceShortcuts.sortOrder), asc(serviceShortcuts.label))
  const ids = [...new Set(rows.map((r) => r.c.id))]
  const tiers = ids.length ? await db.select({ catalogId: servicePriceTiers.catalogId }).from(servicePriceTiers).where(inArray(servicePriceTiers.catalogId, ids)) : []
  const tiered = new Set(tiers.map((t) => t.catalogId))
  const groupIndex = (g: string) => { const i = (SHORTCUT_GROUPS as readonly string[]).indexOf(g); return i < 0 ? 99 : i }
  return rows.map(({ s, c }) => ({
    id: s.id, catalogId: c.id, slug: c.slug, label: s.label, group: s.groupName, sortOrder: s.sortOrder, hidden: s.hiddenAt != null,
    catalogName: c.name, description: canonicalDescription(c), qbDescription: c.qbDescription,
    priceBehavior: priceBehavior(c, tiered.has(c.id)), defaultPriceCents: c.hasSize || c.hasCondition ? null : c.defaultPriceCents,
    qbItemRef: c.qbItemRef, qbMapped: isMapped(c), qbCandidateRef: c.qbCandidateRef,
    updatedBy: s.updatedBy ?? s.createdBy, updatedAt: s.updatedAt.toISOString(),
  })).sort((a, b) => groupIndex(a.group) - groupIndex(b.group) || a.sortOrder - b.sortOrder)
}

// ── Live QuickBooks items (selection only) ──────────────────────────────────────────────────────
export interface LiveQbItem { id: string; name: string; type: string | null; description: string | null }
export async function listLiveQbItems(): Promise<LiveQbItem[]> {
  const res = await queryQBO<{ Item?: Array<{ Id: string; Name: string; Active?: boolean; Type?: string; Description?: string }> }>(
    `SELECT Id, Name, Active, Type, Description FROM Item MAXRESULTS 1000`)
  return (res.Item ?? []).filter((i) => i.Active !== false && i.Type !== 'Category')
    .map((i) => ({ id: String(i.Id), name: i.Name, type: i.Type ?? null, description: i.Description ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
async function assertLiveQbItem(itemRef: string): Promise<LiveQbItem> {
  const item = (await listLiveQbItems()).find((i) => i.id === itemRef)
  if (!item) throw new Error('That QuickBooks item was not found (or is inactive). Pick an existing item from the list.')
  return item
}

async function getCatalog(catalogId: string): Promise<CatRow> {
  const [c] = await getDb().select().from(serviceCatalog).where(eq(serviceCatalog.id, catalogId)).limit(1)
  if (!c) throw new Error('Service not found.')
  if (c.source === 'dealer_rules') throw new Error('Dealer packages are managed by Dealer Check-In, not here.')
  return c
}

async function nextSortOrder(group: string): Promise<number> {
  const [r] = await getDb().select({ m: sql<number>`coalesce(max(${serviceShortcuts.sortOrder}), 0)` }).from(serviceShortcuts)
    .where(and(eq(serviceShortcuts.groupName, group), isNull(serviceShortcuts.hiddenAt)))
  return Number(r?.m ?? 0) + 10
}

export interface NewCatalogInput {
  name: string
  description?: string | null
  /** 'manual' = price entered on each job; 'fixed' = defaultPriceCents prefills (still editable). */
  priceMode: 'manual' | 'fixed'
  defaultPriceCents?: number | null
  /** Existing live QuickBooks item id, or null = bill as Labor until mapped (explicit). */
  qbItemRef: string | null
}

/** Reject a new catalog name that already exists as a live name or approved alternate name. */
async function assertNewServiceName(name: string): Promise<void> {
  const key = normalizeServiceKey(name)
  const db = getDb()
  const cats = await db.select({ name: serviceCatalog.name }).from(serviceCatalog).where(isNull(serviceCatalog.archivedAt))
  const hit = cats.find((c) => normalizeServiceKey(c.name) === key)
  if (hit) throw new Error(`“${hit.name}” already exists — add a shortcut to it instead of creating a duplicate.`)
  const aliases = await db.select({ alias: serviceAliases.alias, name: serviceCatalog.name }).from(serviceAliases)
    .innerJoin(serviceCatalog, eq(serviceCatalog.id, serviceAliases.catalogId)).where(isNull(serviceCatalog.archivedAt))
  const a = aliases.find((x) => normalizeServiceKey(x.alias) === key)
  if (a) throw new Error(`“${name}” is already an alternate name for “${a.name}” — add a shortcut to that service instead.`)
}

const slugify = (name: string) => normalizeServiceKey(name).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'service'

/** Add a shortcut to an EXISTING catalog item, or create a new catalog item (no QB item created). */
export async function createShortcut(input: { catalogId?: string | null; newService?: NewCatalogInput | null; label?: string | null; group?: string | null }, actor: string | null): Promise<string> {
  const db = getDb()
  const group = cleanText(input.group || 'Other', 40) || 'Other'
  let catalog: CatRow
  if (input.catalogId) {
    catalog = await getCatalog(input.catalogId)
    if (catalog.archivedAt || !catalog.active) throw new Error('That service is archived. Restore it in the catalog first.')
  } else if (input.newService) {
    const n = input.newService
    const name = cleanText(n.name, 120)
    if (name.length < 2) throw new Error('Enter a service name.')
    await assertNewServiceName(name)
    const description = cleanText(n.description, 600) || null
    const defaultPriceCents = n.priceMode === 'fixed' ? Math.round(Number(n.defaultPriceCents)) : null
    if (n.priceMode === 'fixed' && !(Number.isFinite(defaultPriceCents) && (defaultPriceCents ?? 0) > 0)) throw new Error('Enter the default price, or choose “price entered each time”.')
    const qb = n.qbItemRef ? await assertLiveQbItem(String(n.qbItemRef)) : null
    let slug = slugify(name)
    const taken = new Set((await db.select({ slug: serviceCatalog.slug }).from(serviceCatalog)).map((r) => r.slug))
    for (let i = 2; taken.has(slug); i++) slug = `${slugify(name).slice(0, 56)}_${i}`
    ;[catalog] = await db.insert(serviceCatalog).values({
      slug, name, kind: 'addon', quickEntry: false, defaultPriceCents, priceEditable: true, active: true, sortOrder: 500, source: 'manager',
      qbItemRef: qb?.id ?? null, qbItemStatus: qb ? 'existing' : 'mapping_review', qbSyncEnabled: !!qb, qbDescription: description, reviewFlag: !qb,
      notes: `Created in Manage services by ${actor ?? 'manager'}.`,
    }).returning()
    await audit(catalog.id, 'catalog_created', actor, { name, description, priceMode: n.priceMode, defaultPriceCents, qbItem: qb ? { id: qb.id, name: qb.name } : null })
  } else {
    throw new Error('Choose a service, or describe a new one.')
  }
  const label = cleanText(input.label || catalog.name, 80)
  const [active] = await db.select({ id: serviceShortcuts.id }).from(serviceShortcuts).where(and(eq(serviceShortcuts.catalogId, catalog.id), isNull(serviceShortcuts.hiddenAt))).limit(1)
  if (active) throw new Error('That service already has a shortcut.')
  const [row] = await db.insert(serviceShortcuts).values({ catalogId: catalog.id, label, groupName: group, sortOrder: await nextSortOrder(group), createdBy: actor, updatedBy: actor }).returning()
  await audit(catalog.id, 'shortcut_added', actor, { shortcutId: row.id, label, group })
  return row.id
}

async function getShortcut(id: string) {
  const [s] = await getDb().select().from(serviceShortcuts).where(eq(serviceShortcuts.id, id)).limit(1)
  if (!s) throw new Error('Shortcut not found.')
  return s
}

/** Rename / regroup a shortcut. Display only — the catalog identity is unchanged. */
export async function updateShortcut(id: string, patch: { label?: string; group?: string }, actor: string | null): Promise<void> {
  const s = await getShortcut(id)
  const label = patch.label !== undefined ? cleanText(patch.label, 80) : s.label
  if (!label) throw new Error('Enter a shortcut name.')
  const group = patch.group !== undefined ? cleanText(patch.group, 40) || 'Other' : s.groupName
  const sortOrder = group !== s.groupName ? await nextSortOrder(group) : s.sortOrder
  await getDb().update(serviceShortcuts).set({ label, groupName: group, sortOrder, updatedBy: actor, updatedAt: new Date() }).where(eq(serviceShortcuts.id, id))
  await audit(s.catalogId, 'shortcut_updated', actor, { shortcutId: id, from: { label: s.label, group: s.groupName }, to: { label, group } })
}

/** Move a shortcut up/down within its group (swap with its neighbour). */
export async function moveShortcut(id: string, direction: 'up' | 'down', actor: string | null): Promise<void> {
  const s = await getShortcut(id)
  const db = getDb()
  const peers = await db.select().from(serviceShortcuts).where(and(eq(serviceShortcuts.groupName, s.groupName), isNull(serviceShortcuts.hiddenAt)))
    .orderBy(asc(serviceShortcuts.sortOrder), asc(serviceShortcuts.label))
  const i = peers.findIndex((p) => p.id === id)
  const j = direction === 'up' ? i - 1 : i + 1
  if (i < 0 || j < 0 || j >= peers.length) return
  const order = peers.map((p) => p.id)
  ;[order[i], order[j]] = [order[j], order[i]]
  for (const [k, pid] of order.entries()) await db.update(serviceShortcuts).set({ sortOrder: (k + 1) * 10, updatedAt: new Date(), updatedBy: actor }).where(eq(serviceShortcuts.id, pid))
  await audit(s.catalogId, 'shortcut_moved', actor, { shortcutId: id, direction })
}

/** Hide from future selection. The catalog item, QB mapping, and every existing line are untouched. */
export async function hideShortcut(id: string, actor: string | null): Promise<void> {
  const s = await getShortcut(id)
  if (s.hiddenAt) return
  await getDb().update(serviceShortcuts).set({ hiddenAt: new Date(), hiddenBy: actor, updatedBy: actor, updatedAt: new Date() }).where(eq(serviceShortcuts.id, id))
  await audit(s.catalogId, 'shortcut_hidden', actor, { shortcutId: id, label: s.label })
}

export async function restoreShortcut(id: string, actor: string | null): Promise<void> {
  const s = await getShortcut(id)
  if (!s.hiddenAt) return
  const db = getDb()
  const [active] = await db.select({ id: serviceShortcuts.id }).from(serviceShortcuts).where(and(eq(serviceShortcuts.catalogId, s.catalogId), isNull(serviceShortcuts.hiddenAt))).limit(1)
  if (active) throw new Error('That service already has an active shortcut.')
  await db.update(serviceShortcuts).set({ hiddenAt: null, hiddenBy: null, sortOrder: await nextSortOrder(s.groupName), updatedBy: actor, updatedAt: new Date() }).where(eq(serviceShortcuts.id, id))
  await audit(s.catalogId, 'shortcut_restored', actor, { shortcutId: id, label: s.label })
}

/**
 * Edit the catalog item behind a shortcut: canonical customer-facing description, default price
 * behavior, QuickBooks item (selected from live items, or explicitly "bill as Labor until mapped").
 * Applies to FUTURE additions only. Tiered (size/condition) prices are not edited here.
 */
export async function updateCatalogService(catalogId: string, patch: {
  description?: string | null; priceMode?: 'manual' | 'fixed'; defaultPriceCents?: number | null; qbItemRef?: string | null
}, actor: string | null): Promise<void> {
  const c = await getCatalog(catalogId)
  const set: Partial<CatRow> = {}
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {}
  if (patch.description !== undefined) {
    const d = cleanText(patch.description, 600) || null
    if (d !== c.qbDescription) { before.description = c.qbDescription; after.description = d; set.qbDescription = d }
  }
  if (patch.priceMode !== undefined) {
    const tiered = c.hasSize || c.hasCondition || (await getDb().select({ id: servicePriceTiers.id }).from(servicePriceTiers).where(eq(servicePriceTiers.catalogId, catalogId)).limit(1)).length > 0
    if (tiered) throw new Error('This service is priced by size/condition; its tiers are not edited here.')
    const cents = patch.priceMode === 'fixed' ? Math.round(Number(patch.defaultPriceCents)) : null
    if (patch.priceMode === 'fixed' && !(Number.isFinite(cents) && (cents ?? 0) > 0)) throw new Error('Enter the default price, or choose “price entered each time”.')
    if (cents !== c.defaultPriceCents) { before.defaultPriceCents = c.defaultPriceCents; after.defaultPriceCents = cents; set.defaultPriceCents = cents }
  }
  if (patch.qbItemRef !== undefined) {
    if (patch.qbItemRef) {
      const qb = await assertLiveQbItem(String(patch.qbItemRef))
      if (qb.id !== c.qbItemRef || !c.qbSyncEnabled || c.qbItemStatus !== 'existing') {
        before.qbItem = { ref: c.qbItemRef, status: c.qbItemStatus, sync: c.qbSyncEnabled }; after.qbItem = { ref: qb.id, name: qb.name }
        Object.assign(set, { qbItemRef: qb.id, qbItemStatus: 'existing', qbSyncEnabled: true, reviewFlag: false })
      }
    } else if (c.qbSyncEnabled || c.qbItemStatus !== 'mapping_review') {
      before.qbItem = { ref: c.qbItemRef, status: c.qbItemStatus, sync: c.qbSyncEnabled }; after.qbItem = 'Labor until mapped'
      Object.assign(set, { qbItemStatus: 'mapping_review', qbSyncEnabled: false })
    }
  }
  if (Object.keys(set).length === 0) return
  await getDb().update(serviceCatalog).set({ ...set, updatedAt: new Date() }).where(eq(serviceCatalog.id, catalogId))
  await audit(catalogId, 'catalog_updated', actor, { name: c.name, before, after })
}

/** Confirm a catalog item's business role (e.g. "Odor / Ozone Treatment" is the Ozone-only option). */
export async function confirmServiceRole(catalogId: string, actor: string | null): Promise<void> {
  const c = await getCatalog(catalogId)
  if (!c.serviceRole) throw new Error('This service has no role to confirm.')
  await getDb().update(serviceCatalog).set({ roleConfirmedBy: actor, roleConfirmedAt: new Date(), updatedAt: new Date() }).where(eq(serviceCatalog.id, catalogId))
  await audit(catalogId, 'role_confirmed', actor, { name: c.name, role: c.serviceRole })
}

// ── Approved alternate names ────────────────────────────────────────────────────────────────────
/**
 * Approve a recurring phrase as an alternate name for a catalog item (manager). Refused when it
 * would be ambiguous: another item's name, another item's alternate name, or generic odor wording.
 */
export async function approveAlias(catalogId: string, rawAlias: string, actor: string | null): Promise<void> {
  const c = await getCatalog(catalogId)
  const alias = cleanText(rawAlias, 120)
  const key = normalizeServiceKey(alias)
  if (key.length < 2) throw new Error('Enter the phrase to remember.')
  if (isGenericOdorKey(alias)) throw new Error('General odor wording can mean different treatments, so it always asks which one.')
  const db = getDb()
  const cats = await db.select({ id: serviceCatalog.id, name: serviceCatalog.name }).from(serviceCatalog).where(isNull(serviceCatalog.archivedAt))
  const other = cats.find((x) => x.id !== catalogId && normalizeServiceKey(x.name) === key)
  if (other) throw new Error(`“${alias}” is the name of another service (${other.name}).`)
  const existing = await db.select({ catalogId: serviceAliases.catalogId, alias: serviceAliases.alias }).from(serviceAliases)
  const clash = existing.find((a) => normalizeServiceKey(a.alias) === key)
  if (clash && clash.catalogId !== catalogId) throw new Error(`“${alias}” already means a different service.`)
  if (clash) return   // already approved for this service
  await db.insert(serviceAliases).values({ catalogId, alias, source: 'manager', approvedForAi: true, approvedBy: actor, approvedAt: new Date() })
  await audit(catalogId, 'alias_approved', actor, { name: c.name, alias })
}

/** Remove a MANAGER-approved alternate name (historical QuickBooks names are not removable here). */
export async function removeAlias(aliasId: string, actor: string | null): Promise<void> {
  const db = getDb()
  const [a] = await db.select().from(serviceAliases).where(eq(serviceAliases.id, aliasId)).limit(1)
  if (!a) return
  if (a.source !== 'manager') throw new Error('Only alternate names approved in this app can be removed here.')
  await db.delete(serviceAliases).where(eq(serviceAliases.id, aliasId))
  await audit(a.catalogId, 'alias_removed', actor, { alias: a.alias })
}

export async function listManagerAliases() {
  return getDb().select({ id: serviceAliases.id, alias: serviceAliases.alias, catalogId: serviceAliases.catalogId, name: serviceCatalog.name, approvedBy: serviceAliases.approvedBy, approvedAt: serviceAliases.approvedAt })
    .from(serviceAliases).innerJoin(serviceCatalog, eq(serviceCatalog.id, serviceAliases.catalogId))
    .where(eq(serviceAliases.source, 'manager')).orderBy(desc(serviceAliases.approvedAt))
}

// ── Review queue + usage suggestions ────────────────────────────────────────────────────────────
export interface CatalogReviewItem {
  catalogId: string; name: string; reasons: string[]; qbCandidateRef: string | null; notes: string | null
  role: string | null; roleConfirmed: boolean; defaultPriceCents: number | null; description: string
}

/** Catalog items needing a manager decision: no confirmed QuickBooks item, or an unconfirmed role. */
export async function catalogReviewQueue(): Promise<CatalogReviewItem[]> {
  const rows = await getDb().select().from(serviceCatalog)
    .where(and(isNull(serviceCatalog.archivedAt), eq(serviceCatalog.active, true), or(isNull(serviceCatalog.source), ne(serviceCatalog.source, 'dealer_rules')),
      or(eq(serviceCatalog.qbSyncEnabled, false), ne(serviceCatalog.qbItemStatus, 'existing'), and(isNotNull(serviceCatalog.serviceRole), isNull(serviceCatalog.roleConfirmedAt)))))
    .orderBy(asc(serviceCatalog.sortOrder))
  return rows.map((c) => {
    const reasons: string[] = []
    if (!isMapped(c)) reasons.push('No QuickBooks item confirmed — bills as generic Labor with its approved description.')
    if (c.serviceRole && !c.roleConfirmedAt) reasons.push(c.slug === 'odor_ozone'
      ? 'Named “Odor / Ozone Treatment”; its description covers ozone + fabric steam cleaning (no duct cleaning). Confirm it is the Ozone Treatment option.'
      : 'Confirm this service’s role.')
    if (c.serviceRole === 'odor_complete' && c.defaultPriceCents == null) reasons.push('Package price is entered on each job until a default is confirmed.')
    return { catalogId: c.id, name: c.name, reasons, qbCandidateRef: c.qbCandidateRef, notes: c.notes, role: c.serviceRole, roleConfirmed: !!c.roleConfirmedAt, defaultPriceCents: c.defaultPriceCents, description: canonicalDescription(c) }
  })
}

/**
 * Usage evidence for choosing shortcuts: distinct retail jobs per catalog item over the last N days
 * (cancelled and dealer work excluded). Suggestions only — never applied automatically, so a
 * manager's choices are never undone.
 */
export async function usageSuggestions(days = 90): Promise<Array<{ catalogId: string; name: string; jobs: number; hasShortcut: boolean }>> {
  const db = getDb()
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db.select({ catalogId: jobServices.catalogId, jobs: sql<number>`count(distinct ${serviceOrders.id})` })
    .from(jobServices).innerJoin(jobEstimates, eq(jobEstimates.id, jobServices.jobEstimateId)).innerJoin(serviceOrders, eq(serviceOrders.id, jobEstimates.serviceOrderId))
    .where(and(isNotNull(jobServices.catalogId), ne(serviceOrders.status, 'cancelled'), ne(serviceOrders.source, 'dealer'), gte(serviceOrders.createdAt, since)))
    .groupBy(jobServices.catalogId)
  const ids = rows.map((r) => r.catalogId!).filter(Boolean)
  if (ids.length === 0) return []
  const [cats, active] = await Promise.all([
    db.select({ id: serviceCatalog.id, name: serviceCatalog.name, source: serviceCatalog.source, archivedAt: serviceCatalog.archivedAt }).from(serviceCatalog).where(inArray(serviceCatalog.id, ids)),
    db.select({ catalogId: serviceShortcuts.catalogId }).from(serviceShortcuts).where(isNull(serviceShortcuts.hiddenAt)),
  ])
  const byId = new Map(cats.map((c) => [c.id, c]))
  const has = new Set(active.map((a) => a.catalogId))
  return rows.flatMap((r) => {
    const c = byId.get(r.catalogId!)
    if (!c || c.archivedAt || c.source === 'dealer_rules') return []
    return [{ catalogId: c.id, name: c.name, jobs: Number(r.jobs), hasShortcut: has.has(c.id) }]
  }).sort((a, b) => b.jobs - a.jobs)
}

export async function recentCatalogEvents(limit = 30) {
  return getDb().select().from(serviceCatalogEvents).orderBy(desc(serviceCatalogEvents.createdAt)).limit(limit)
}
