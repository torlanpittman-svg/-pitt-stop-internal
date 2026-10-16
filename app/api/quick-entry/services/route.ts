/**
 * Manage services (shortcuts + catalog review) — MANAGER/ADMIN only, enforced here (the proxy only
 * guarantees a signed-in employee). Employees read the active shortcuts via /api/quick-entry/catalog.
 *
 * GET  → shortcuts (incl. hidden), the full selectable catalog, the review queue, manager-approved
 *        alternate names, usage suggestions, live QuickBooks items (null when QB is unreachable), and
 *        recent audit events.
 * POST → { action, ... } — every change is audited in service_catalog_events. 'set_qb_income_account' is the
 *        one QuickBooks write here: it re-points a service's EXISTING item at an EXISTING income account.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import {
  listShortcuts, createShortcut, updateShortcut, moveShortcut, hideShortcut, restoreShortcut, updateCatalogService,
  confirmServiceRole, approveAlias, removeAlias, listManagerAliases, catalogReviewQueue, usageSuggestions, listLiveQbItems,
  recentCatalogEvents, SHORTCUT_GROUPS,
} from '@/apps/quick-entry/shortcuts'
import { listCatalogChoices } from '@/apps/quick-entry/service-match-db'
import { setCatalogItemIncomeAccount } from '@/apps/quickbooks/catalog-item-income'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function manager(req: Request) {
  const actor = await authenticatedActorFromRequest(req)
  return actor && isManagerRole(actor.role) ? actor : null
}

export async function GET(req: Request) {
  if (!(await manager(req))) return NextResponse.json({ ok: false, error: 'Manager access required.' }, { status: 403 })
  const [shortcuts, catalog, review, aliases, usage, events] = await Promise.all([
    listShortcuts({ includeHidden: true }), listCatalogChoices(), catalogReviewQueue(), listManagerAliases(), usageSuggestions(90), recentCatalogEvents(25),
  ])
  let qbItems: Awaited<ReturnType<typeof listLiveQbItems>> | null = null
  let qbError: string | null = null
  try { qbItems = await listLiveQbItems() } catch (e) { qbError = e instanceof Error ? e.message.slice(0, 200) : 'QuickBooks is unavailable.' }
  return NextResponse.json({ ok: true, groups: SHORTCUT_GROUPS, shortcuts, catalog, review, aliases, usage, events, qbItems, qbError })
}

export async function POST(req: Request) {
  const actor = await manager(req)
  if (!actor) return NextResponse.json({ ok: false, error: 'Manager access required.' }, { status: 403 })
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  try {
    switch (b.action) {
      case 'add_shortcut': {
        const id = await createShortcut({
          catalogId: s(b.catalogId) || null, label: s(b.label) || null, group: s(b.group) || null,
          newService: b.newService && typeof b.newService === 'object' ? b.newService as never : null,
        }, actor.name)
        return NextResponse.json({ ok: true, id, shortcuts: await listShortcuts({ includeHidden: true }) })
      }
      case 'update_shortcut': await updateShortcut(s(b.id), { label: b.label !== undefined ? s(b.label) : undefined, group: b.group !== undefined ? s(b.group) : undefined }, actor.name); break
      case 'move': await moveShortcut(s(b.id), b.direction === 'up' ? 'up' : 'down', actor.name); break
      case 'hide': await hideShortcut(s(b.id), actor.name); break
      case 'restore': await restoreShortcut(s(b.id), actor.name); break
      case 'update_catalog': await updateCatalogService(s(b.catalogId), {
        description: b.description !== undefined ? (b.description == null ? null : s(b.description)) : undefined,
        priceMode: b.priceMode === 'fixed' || b.priceMode === 'manual' ? b.priceMode : undefined,
        defaultPriceCents: b.defaultPriceCents == null ? null : Number(b.defaultPriceCents),
        qbItemRef: b.qbItemRef !== undefined ? (b.qbItemRef ? s(b.qbItemRef) : null) : undefined,
      }, actor.name); break
      case 'confirm_role': await confirmServiceRole(s(b.catalogId), actor.name); break
      case 'set_qb_income_account': {
        // Scoped QuickBooks change: the service's existing item → an existing active income account (audited).
        const result = await setCatalogItemIncomeAccount(s(b.catalogId), s(b.accountId), actor.name)
        return NextResponse.json({ ok: true, result })
      }
      case 'approve_alias': await approveAlias(s(b.catalogId), s(b.alias), actor.name); break
      case 'remove_alias': await removeAlias(s(b.aliasId), actor.name); break
      default: return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, shortcuts: await listShortcuts({ includeHidden: true }), review: await catalogReviewQueue(), aliases: await listManagerAliases() })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Could not save.' }, { status: 400 })
  }
}
