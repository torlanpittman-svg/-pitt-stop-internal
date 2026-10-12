import { vi, describe, it, expect, beforeEach } from 'vitest'

/** The go-live interlock: live check recording can only be switched ON when a negotiable check can
 *  actually be produced and QuickBooks is the production company — which is then pinned. */
const h = vi.hoisted(() => ({
  settings: new Map<string, unknown>(), micrBlocked: false, ready: true, missing: [] as string[],
  token: { realmId: 'REALM-PROD', environment: 'production' } as { realmId: string; environment: string } | null,
}))
vi.mock('@/apps/checks/authz', () => ({ managerFromRequest: vi.fn(async () => ({ key: 'admin', name: 'Admin', role: 'admin' })) }))
vi.mock('@/apps/settings/db', () => ({ updateSetting: vi.fn(async (k: string, v: unknown) => { h.settings.set(k, v) }) }))
vi.mock('@/apps/checks/config', () => ({
  getCheckConfig: vi.fn(async () => ({ enabled: true, liveEnabled: h.settings.get('checks_live_enabled') === true, qboRealmId: String(h.settings.get('check_qbo_realm_id') ?? ''), banks: {}, categoryAccounts: {}, layout: {}, templateMode: 'blank_full', display: {}, micrEnabled: true })),
  checkConfigReadiness: () => ({ ready: h.ready, enabled: true, operatingBankConfigured: h.ready, autoSalesBankConfigured: true, missingCategoryAccounts: h.missing }),
}))
vi.mock('@/apps/checks/numbering', () => ({ peekNextNumber: vi.fn(async () => 20000) }))
vi.mock('@/apps/checks/micr', () => ({ micrReadiness: () => ({ ready: !h.micrBlocked }) }))
vi.mock('@/apps/checks/service', () => ({ micrBlocksRealChecks: () => h.micrBlocked }))
vi.mock('@/apps/quickbooks/connection', () => ({ getValidAccessToken: vi.fn(async () => { if (!h.token) throw new Error('not connected'); return h.token }) }))

import { POST } from './route'
const post = (body: unknown) => POST(new Request('http://x/api/admin/checks/setup', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => { h.settings.clear(); h.micrBlocked = false; h.ready = true; h.missing = []; h.token = { realmId: 'REALM-PROD', environment: 'production' } })

describe('POST /api/admin/checks/setup — go-live interlock', () => {
  it('turns live ON and pins the production QuickBooks company when everything is ready', async () => {
    const res = await post({ liveEnabled: true })
    expect(res.status).toBe(200)
    expect(h.settings.get('checks_live_enabled')).toBe(true)
    expect(h.settings.get('check_qbo_realm_id')).toBe('REALM-PROD')
  })
  it.each([
    ['the MICR line is not ready', () => { h.micrBlocked = true }, /MICR/],
    ['QuickBooks is a sandbox company', () => { h.token = { realmId: 'SBX', environment: 'sandbox' } }, /non-production/],
    ['QuickBooks is not connected', () => { h.token = null }, /not connected/],
    ['the bank account is not set', () => { h.ready = false }, /bank account/],
    ['a category has no account', () => { h.missing = ['equipment'] }, /equipment/],
  ])('REFUSES to turn live on when %s — and changes nothing', async (_l, arrange, why) => {
    arrange()
    const res = await post({ liveEnabled: true })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('not_ready'); expect(body.blockers.join(' ')).toMatch(why)
    expect(h.settings.has('checks_live_enabled')).toBe(false)
    expect(h.settings.has('check_qbo_realm_id')).toBe(false)
  })
  it('turning live OFF always works, even when nothing is ready', async () => {
    h.micrBlocked = true; h.token = null
    const res = await post({ liveEnabled: false })
    expect(res.status).toBe(200)
    expect(h.settings.get('checks_live_enabled')).toBe(false)
  })
})
