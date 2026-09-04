import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { signEmployeeSession, EMP_COOKIE, type AuthedActor } from './employee-session'
import { authenticatedActorFromRequest, employeeAuthorizedFromRequest } from './employee-guard'

const OLD = { ...process.env }
beforeEach(() => {
  process.env.IDENTITY_SECRET = 'test-secret'
  process.env.ADMIN_PASSWORD = 'admin-pw'
  process.env.PIN_DARRYL = '4001'   // ensure the gate is "configured"
})
afterEach(() => { process.env = { ...OLD } })

async function reqWithSession(actor: AuthedActor | null): Promise<Request> {
  const tok = await signEmployeeSession(actor)
  return new Request('https://x/api', { headers: { cookie: `${EMP_COOKIE}=${tok}` } })
}
const adminReq = () => new Request('https://x/api', { headers: { authorization: 'Basic ' + Buffer.from('admin:admin-pw').toString('base64') } })

describe('authenticatedActorFromRequest — the authoritative identity for authz + attribution', () => {
  it('resolves an employee session to that employee', async () => {
    const req = await reqWithSession({ key: 'darryl', name: 'Darryl', role: 'employee' })
    expect(await authenticatedActorFromRequest(req)).toEqual({ key: 'darryl', name: 'Darryl', role: 'employee' })
  })
  it('resolves a manager session to that manager', async () => {
    const req = await reqWithSession({ key: 'torlan', name: 'Torlan', role: 'manager' })
    expect(await authenticatedActorFromRequest(req)).toEqual({ key: 'torlan', name: 'Torlan', role: 'manager' })
  })
  it('admin Basic-Auth resolves to an admin actor', async () => {
    expect(await authenticatedActorFromRequest(adminReq())).toEqual({ key: 'admin', name: 'Admin', role: 'admin' })
  })
  it('a forged ps_actor cookie CANNOT escalate role (only the signed session is trusted)', async () => {
    const forged = new Request('https://x/api', {
      headers: { cookie: 'ps_actor=' + encodeURIComponent(JSON.stringify({ id: 'x', name: 'Mallory', role: 'admin' })) },
    })
    expect(await authenticatedActorFromRequest(forged)).toBeNull()
  })
  it('an anonymous (legacy) session has no identity', async () => {
    const req = await reqWithSession(null)
    expect(await authenticatedActorFromRequest(req)).toBeNull()
  })
})

describe('manager is NEVER admin — a manager PIN session grants no admin authority', () => {
  it('a signed manager session resolves to role=manager, not admin', async () => {
    for (const m of [
      { key: 'darryl', name: 'Darryl', role: 'manager' as const },
      { key: 'tony', name: 'Tony', role: 'manager' as const },
      { key: 'torlan', name: 'Torlan', role: 'manager' as const },
    ]) {
      const actor = await authenticatedActorFromRequest(await reqWithSession(m))
      expect(actor?.role).toBe('manager')
      expect(actor?.role).not.toBe('admin')
    }
  })
  it('a forged client role/actor cookie cannot escalate a manager to admin (signed session wins)', async () => {
    const tok = await signEmployeeSession({ key: 'darryl', name: 'Darryl', role: 'manager' })
    // Attacker appends client-writable cookies claiming admin alongside the real signed session.
    const req = new Request('https://x/api', {
      headers: { cookie: `ps_actor=${encodeURIComponent(JSON.stringify({ role: 'admin' }))}; ps_elev=1; ${EMP_COOKIE}=${tok}` },
    })
    const actor = await authenticatedActorFromRequest(req)
    expect(actor).toEqual({ key: 'darryl', name: 'Darryl', role: 'manager' }) // still manager — forged claims ignored
  })
})

describe('employeeAuthorizedFromRequest — the shared gate still accepts individual sessions', () => {
  it('accepts a valid employee session', async () => {
    expect(await employeeAuthorizedFromRequest(await reqWithSession({ key: 'tony', name: 'Tony', role: 'employee' }))).toBe(true)
  })
  it('accepts admin Basic-Auth', async () => {
    expect(await employeeAuthorizedFromRequest(adminReq())).toBe(true)
  })
  it('rejects a request with no session when a PIN is configured', async () => {
    const req = new Request('https://x/api', { headers: {} })
    expect(await employeeAuthorizedFromRequest(req)).toBe(false)
  })
})
