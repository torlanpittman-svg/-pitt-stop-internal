/**
 * Point a catalog service's EXISTING QuickBooks item at an EXISTING income account — the one scoped
 * QuickBooks change used for "Odor Treatment revenue posts to Detail Sales" (owner-approved 2026-10-16).
 *
 * Narrow on purpose:
 *  - only the item already mapped to a live (non-archived, active, QB-synced) catalog service;
 *  - only an existing, ACTIVE account of type Income (never creates or renames an account or an item);
 *  - a sparse update of IncomeAccountRef alone (name/price/tax/description of the item untouched),
 *    guarded by the item's current SyncToken, then read back and verified;
 *  - idempotent: already on that account → no QuickBooks call, no audit row;
 *  - audited in service_catalog_events ('qb_item_income_account', before/after, actor).
 * It changes which account FUTURE transactions on the item post to; posted transactions are not edited.
 * Manager/admin only (enforced by the calling route).
 */
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { serviceCatalog, serviceCatalogEvents } from '@/apps/quick-entry/schema'
import { qbApiRequest, queryQBO, qboEscape } from './client'

interface QbItem { Id: string; Name: string; Active?: boolean; Type?: string; SyncToken?: string; IncomeAccountRef?: { value: string; name?: string } }
interface QbAccount { Id: string; Name: string; Active?: boolean; AccountType?: string }

export interface IncomeAccountResult {
  changed: boolean
  item: { id: string; name: string }
  before: { id: string | null; name: string | null }
  after: { id: string; name: string }
}

export async function setCatalogItemIncomeAccount(catalogId: string, accountId: string, actor: string | null): Promise<IncomeAccountResult> {
  if (!/^\d+$/.test(accountId)) throw new Error('Choose an existing QuickBooks income account.')
  const db = getDb()
  const [c] = await db.select().from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, catalogId), isNull(serviceCatalog.archivedAt), eq(serviceCatalog.active, true))).limit(1)
  if (!c) throw new Error('That service is not in the active catalog.')
  if (!c.qbItemRef || !c.qbSyncEnabled || c.qbItemStatus !== 'existing') throw new Error(`“${c.name}” is not mapped to a QuickBooks item yet.`)

  const [itemRes, acctRes] = await Promise.all([
    queryQBO<{ Item?: QbItem[] }>(`select * from Item where Id = '${qboEscape(c.qbItemRef)}'`),
    queryQBO<{ Account?: QbAccount[] }>(`select * from Account where Id = '${qboEscape(accountId)}'`),
  ])
  const item = itemRes.Item?.[0]
  const account = acctRes.Account?.[0]
  if (!item || item.Active === false) throw new Error(`QuickBooks item #${c.qbItemRef} for “${c.name}” was not found or is inactive.`)
  if (item.Type && item.Type !== 'Service') throw new Error(`QuickBooks item “${item.Name}” is not a service item.`)
  if (!account || account.Active === false || account.AccountType !== 'Income') throw new Error('That QuickBooks account is not an active income account.')

  const before = { id: item.IncomeAccountRef?.value ?? null, name: item.IncomeAccountRef?.name ?? null }
  const result = { item: { id: item.Id, name: item.Name }, before, after: { id: account.Id, name: account.Name } }
  if (before.id === account.Id) return { changed: false, ...result }

  const updated = await qbApiRequest<{ Item?: QbItem }>({
    method: 'POST', path: '/item',
    body: { Id: item.Id, SyncToken: item.SyncToken, sparse: true, Name: item.Name, IncomeAccountRef: { value: account.Id } },
  })
  if (updated.Item?.IncomeAccountRef?.value !== account.Id) throw new Error('QuickBooks did not confirm the income account change.')

  await db.insert(serviceCatalogEvents).values({
    catalogId: c.id, eventType: 'qb_item_income_account', actor,
    note: JSON.stringify({ name: c.name, qbItem: result.item, before, after: result.after,
      scope: 'future transactions on this item; posted transactions are not edited' }),
  })
  return { changed: true, ...result }
}
