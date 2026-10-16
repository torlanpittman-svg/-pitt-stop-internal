/**
 * Service matching — data access + orchestration for the estimate service picker.
 *
 * Eligible = live retail catalog rows (active, not archived, not dealer-rules packages). The picker
 * shows each candidate's canonical customer-facing description (service_catalog.qb_description, or
 * the catalog name when blank) and its pricing behavior, so the user can correct a wrong match
 * before anything is saved. Interpretation is read-only: nothing is persisted here.
 */
import { getDb } from '@/platform/db'
import { and, eq, isNull, ne, or, asc, inArray } from 'drizzle-orm'
import { serviceCatalog, serviceAliases, servicePriceTiers } from './schema'
import { interpretEntry, type Interpretation, type InterpretCatalogItem, type ServiceRole } from './service-interpret'
import { aiInterpret, mergeAiInterpretation, serviceAiConfigured, type AiOutcome } from './service-interpret-ai'

export interface CatalogChoice {
  catalogId: string
  slug: string
  name: string
  /** Canonical customer-facing description (qb_description, or the name when blank). */
  description: string
  role: ServiceRole | null
  /** Flat default price (cents) — null = manual price (or tiered). */
  defaultPriceCents: number | null
  tiered: boolean
  /** True when invoices use the mapped QuickBooks item; false = generic Labor until reviewed. */
  qbMapped: boolean
}

const ROLES = new Set<ServiceRole>(['odor_duct', 'odor_ozone', 'odor_complete', 'installation'])
const toRole = (r: string | null | undefined): ServiceRole | null => (r && ROLES.has(r as ServiceRole) ? (r as ServiceRole) : null)

/** The canonical description text for a catalog row (what the invoice line says before any detail). */
export function canonicalDescription(c: { name: string; qbDescription: string | null }): string {
  return c.qbDescription && c.qbDescription.trim() ? c.qbDescription.trim() : c.name
}

const ELIGIBLE = () => and(isNull(serviceCatalog.archivedAt), eq(serviceCatalog.active, true), or(isNull(serviceCatalog.source), ne(serviceCatalog.source, 'dealer_rules')))

export async function loadEligibleCatalog(): Promise<{ items: InterpretCatalogItem[]; choices: Map<string, CatalogChoice> }> {
  const db = getDb()
  const cats = await db.select().from(serviceCatalog).where(ELIGIBLE()).orderBy(asc(serviceCatalog.sortOrder), asc(serviceCatalog.name))
  const ids = cats.map((c) => c.id)
  const [aliases, tiers] = ids.length
    ? await Promise.all([
      db.select({ catalogId: serviceAliases.catalogId, alias: serviceAliases.alias }).from(serviceAliases).where(inArray(serviceAliases.catalogId, ids)),
      db.select({ catalogId: servicePriceTiers.catalogId }).from(servicePriceTiers).where(inArray(servicePriceTiers.catalogId, ids)),
    ])
    : [[], []]
  const aliasOf = new Map<string, string[]>()
  for (const a of aliases) (aliasOf.get(a.catalogId) ?? aliasOf.set(a.catalogId, []).get(a.catalogId)!).push(a.alias)
  const tiered = new Set(tiers.map((t) => t.catalogId))
  const items: InterpretCatalogItem[] = cats.map((c) => ({ id: c.id, slug: c.slug, name: c.name, aliases: aliasOf.get(c.id) ?? [], role: toRole(c.serviceRole) }))
  const choices = new Map<string, CatalogChoice>(cats.map((c) => [c.id, {
    catalogId: c.id, slug: c.slug, name: c.name, description: canonicalDescription(c), role: toRole(c.serviceRole),
    defaultPriceCents: c.hasSize || c.hasCondition ? null : c.defaultPriceCents,
    tiered: c.hasSize || c.hasCondition || tiered.has(c.id),
    qbMapped: c.qbSyncEnabled && c.qbItemStatus === 'existing' && !!c.qbItemRef,
  }]))
  return { items, choices }
}

/** A catalog row a user may select for a retail estimate line, or null. */
export async function eligibleCatalogChoice(catalogId: string | null | undefined): Promise<CatalogChoice | null> {
  if (!catalogId || !/^[0-9a-f-]{36}$/i.test(catalogId)) return null
  const { choices } = await loadEligibleCatalog()
  return choices.get(catalogId) ?? null
}

/** Snapshot of the canonical description for a catalog id (any row, incl. archived), or null. */
export async function catalogDescriptionSnapshot(catalogId: string | null | undefined): Promise<string | null> {
  if (!catalogId) return null
  const [c] = await getDb().select({ name: serviceCatalog.name, qbDescription: serviceCatalog.qbDescription }).from(serviceCatalog).where(eq(serviceCatalog.id, catalogId)).limit(1)
  return c ? canonicalDescription(c) : null
}

export type AiStatus = 'used' | 'unavailable' | 'failed' | 'skipped'

export interface InterpretResult {
  interpretation: Interpretation
  /** Display data for each candidate, in order. */
  choices: CatalogChoice[]
  ai: AiStatus
  aiReason?: string
}

/**
 * Interpret one entry: deterministic first; AI only when there is no established match and the
 * entry isn't handled by the odor/tire rules. `ai` can be injected for tests.
 */
export async function interpretServiceEntry(entry: string, opts: { useAi?: boolean; ai?: typeof aiInterpret } = {}): Promise<InterpretResult> {
  const { items, choices } = await loadEligibleCatalog()
  let interp = interpretEntry(entry, items)
  let ai: AiStatus = 'skipped'
  let aiReason: string | undefined
  const wantsAi = opts.useAi !== false && interp.status !== 'resolved' && interp.intent !== 'odor' && interp.intent !== 'tires' && interp.entry.length > 0
  if (wantsAi) {
    const list = items.map((item) => ({ item, description: choices.get(item.id)?.description ?? null }))
    const outcome: AiOutcome = opts.ai
      ? await opts.ai(interp.entry, interp.corrected, list)
      : (serviceAiConfigured() ? await aiInterpret(interp.entry, interp.corrected, list) : { status: 'unavailable', reason: 'OPENAI_API_KEY is not configured' })
    ai = outcome.status
    if (outcome.status === 'used') interp = mergeAiInterpretation(interp, outcome, new Set(items.map((i) => i.id)))
    else aiReason = outcome.reason
  }
  return { interpretation: interp, choices: interp.candidates.map((c) => choices.get(c.catalogId)).filter((c): c is CatalogChoice => !!c), ai, aiReason }
}

/** Full eligible catalog for "browse all services" (searchable on the device). */
export async function listCatalogChoices(): Promise<CatalogChoice[]> {
  return [...(await loadEligibleCatalog()).choices.values()]
}
