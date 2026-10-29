/**
 * importGate boundaries (no network/DB). EQUAL PERMISSIONS: when the feature is enabled every authorized
 * shop user passes with generic attribution (no role surfaced); unauthenticated is denied 401 and
 * feature-off is denied 403. Auth is mocked at the boundary — no real services/credentials.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const authed = vi.hoisted((): { ok: boolean; actor: { name: string; key: string; role?: string } | null } => ({ ok: true, actor: { name: 'Pat', key: 'emp-1', role: 'employee' } }))
vi.mock('@/apps/auth/employee-guard', () => ({
  employeeAuthorizedFromRequest: async () => authed.ok,
  shopActorFromRequest: async () => (authed.actor ? { ...authed.actor } : null),
}))

import { importGate } from './_gate'

const FLAG = 'PARTS_SCREENSHOT_IMPORT_ENABLED'
const OLD = process.env[FLAG]
beforeEach(() => { authed.ok = true; authed.actor = { name: 'Pat', key: 'emp-1', role: 'employee' }; process.env[FLAG] = 'true' })
afterEach(() => { if (OLD === undefined) delete process.env[FLAG]; else process.env[FLAG] = OLD })

const req = () => new Request('http://localhost/x')

it('denies an unauthenticated request with 401', async () => {
  authed.ok = false
  const g = await importGate(req())
  expect('response' in g && g.response.status).toBe(401)
})

it('denies when the feature flag is off with 403', async () => {
  delete process.env[FLAG]
  const g = await importGate(req())
  expect('response' in g && g.response.status).toBe(403)
})

it('admits an authorized EMPLOYEE when enabled (equal permission, generic attribution)', async () => {
  authed.actor = { name: 'Pat', key: 'emp-1', role: 'employee' }
  const g = await importGate(req())
  expect('response' in g).toBe(false)
  if (!('response' in g)) { expect(g.actorName).toBe('Pat'); expect(g.actorKey).toBe('emp-1') }
})

it('admits an authorized MANAGER identically (no role surfaced)', async () => {
  authed.actor = { name: 'Mgr', key: 'mgr-1', role: 'manager' }
  const g = await importGate(req())
  expect('response' in g).toBe(false)
  if (!('response' in g)) { expect(g.actorName).toBe('Mgr'); expect(g).not.toHaveProperty('manager') }
})

it('admits an authorized shared-PIN session as a generic employee', async () => {
  authed.actor = null // anonymous shared-PIN device (authorized, no resolved identity)
  const g = await importGate(req())
  expect('response' in g).toBe(false)
  if (!('response' in g)) { expect(g.actorName).toBe('Employee'); expect(g.actorKey).toBeNull() }
})
