/**
 * The one scoped QuickBooks write for Odor Treatment → Detail Sales: re-point the service's EXISTING item
 * at an EXISTING active income account. Verified, idempotent, audited; never creates items/accounts and
 * never touches other items. PGlite + real schema; QuickBooks mocked (requests recorded).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
const qb = vi.hoisted(() => ({
  items: {} as Record<string, { Id: string; Name: string; Active: boolean; Type: string; SyncToken: string; IncomeAccountRef: { value: string; name: string } }>,
  accounts: {} as Record<string, { Id: string; Name: string; Active: boolean; AccountType: string }>,
  posts: [] as Array<{ path: string; body: Record<string, unknown> }>,
}))
vi.mock('@/apps/quickbooks/client', () => ({
  qboEscape: (v: string) => v.replace(/'/g, "\\'"),
  queryQBO: async (q: string) => {
    const id = q.match(/Id = '([^']+)'/)?.[1] ?? ''
    if (/from Item/i.test(q)) return { Item: qb.items[id] ? [qb.items[id]] : [] }
    if (/from Account/i.test(q)) return { Account: qb.accounts[id] ? [qb.accounts[id]] : [] }
    return {}
  },
  qbApiRequest: async (req: { path: string; body: Record<string, unknown> }) => {
    qb.posts.push(req)
    const it = qb.items[String(req.body.Id)]
    const acct = qb.accounts[(req.body.IncomeAccountRef as { value: string }).value]
    it.IncomeAccountRef = { value: acct.Id, name: acct.Name }
    it.SyncToken = String(Number(it.SyncToken) + 1)
    return { Item: it }
  },
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { setCatalogItemIncomeAccount } from './catalog-item-income'
import { serviceCatalogEvents } from '@/drizzle/schema'

let db: PgliteDatabase<typeof schema>
let CAT: Record<string, string>
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  CAT = await seedProductionCatalog(db)
  qb.posts = []
  // Production as inspected read-only on 2026-10-16.
  qb.items = {
    '68': { Id: '68', Name: 'Odor Treatment', Active: true, Type: 'Service', SyncToken: '1', IncomeAccountRef: { value: '1', name: 'Sales' } },
    '24': { Id: '24', Name: 'Ozone', Active: true, Type: 'Service', SyncToken: '1', IncomeAccountRef: { value: '39', name: 'Detail Sales' } },
  }
  qb.accounts = {
    '39': { Id: '39', Name: 'Detail Sales', Active: true, AccountType: 'Income' },
    '1': { Id: '1', Name: 'Sales', Active: true, AccountType: 'Income' },
    '94': { Id: '94', Name: 'Sales Tax Payable', Active: true, AccountType: 'Other Current Liability' },
  }
})
const audit = async () => (await db.select().from(serviceCatalogEvents)).filter((e) => e.eventType === 'qb_item_income_account')

describe('setCatalogItemIncomeAccount — Odor Treatment (#68) → Detail Sales (#39)', () => {
  it('sends ONE sparse update of only the income account on item #68 (SyncToken-guarded) and audits before/after', async () => {
    const r = await setCatalogItemIncomeAccount(CAT.odor_treatment, '39', 'Owner')
    expect(r).toEqual({ changed: true, item: { id: '68', name: 'Odor Treatment' }, before: { id: '1', name: 'Sales' }, after: { id: '39', name: 'Detail Sales' } })
    expect(qb.posts).toEqual([{ method: 'POST', path: '/item', body: { Id: '68', SyncToken: '1', sparse: true, Name: 'Odor Treatment', IncomeAccountRef: { value: '39' } } }])
    const [ev] = await audit()
    expect(ev).toMatchObject({ catalogId: CAT.odor_treatment, actor: 'Owner' })
    expect(JSON.parse(ev.note!)).toMatchObject({ qbItem: { id: '68' }, before: { id: '1', name: 'Sales' }, after: { id: '39', name: 'Detail Sales' } })
    expect(qb.items['24'].IncomeAccountRef.value).toBe('39')   // other items untouched
  })

  it('is idempotent: already on Detail Sales → no QuickBooks call, no second audit row', async () => {
    await setCatalogItemIncomeAccount(CAT.odor_treatment, '39', 'Owner')
    const again = await setCatalogItemIncomeAccount(CAT.odor_treatment, '39', 'Owner')
    expect(again.changed).toBe(false)
    expect(qb.posts).toHaveLength(1)
    expect(await audit()).toHaveLength(1)
  })

  it('refuses a non-income, inactive, or missing account; a retired or unmapped service; a missing/inactive item — nothing sent', async () => {
    await expect(setCatalogItemIncomeAccount(CAT.odor_treatment, '94', 'Owner')).rejects.toThrow(/not an active income account/)
    await expect(setCatalogItemIncomeAccount(CAT.odor_treatment, '777', 'Owner')).rejects.toThrow(/not an active income account/)
    qb.accounts['39'].Active = false
    await expect(setCatalogItemIncomeAccount(CAT.odor_treatment, '39', 'Owner')).rejects.toThrow(/not an active income account/)
    qb.accounts['39'].Active = true
    await expect(setCatalogItemIncomeAccount(CAT.complete_odor_treatment, '39', 'Owner')).rejects.toThrow(/not in the active catalog/)
    await expect(setCatalogItemIncomeAccount(CAT.paint_touch_up, '39', 'Owner')).rejects.toThrow(/not found or is inactive/)   // mapped to #35, absent here
    qb.items['68'].Active = false
    await expect(setCatalogItemIncomeAccount(CAT.odor_treatment, '39', 'Owner')).rejects.toThrow(/not found or is inactive/)
    await expect(setCatalogItemIncomeAccount(CAT.odor_treatment, 'x; drop', 'Owner')).rejects.toThrow(/existing QuickBooks income account/)
    expect(qb.posts).toEqual([])
    expect(await audit()).toEqual([])
  })
})
