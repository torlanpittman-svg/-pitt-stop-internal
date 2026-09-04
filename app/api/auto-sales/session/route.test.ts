import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { POST, DELETE } from './route'
import { EMP_COOKIE, verifyEmployeeToken, authedActorFromToken } from '@/apps/auth/employee-session'

// Throwaway TEST PINs — NOT production values.
const TEST_PINS = { darryl: '4001', tony: '4002', torlan: '4003' }
const OLD = { ...process.env }
beforeEach(() => {
  process.env.IDENTITY_SECRET = 'test-secret'
  delete process.env.EMPLOYEE_PIN
  process.env.PIN_DARRYL = TEST_PINS.darryl
  process.env.PIN_TONY = TEST_PINS.tony
  process.env.PIN_TORLAN = TEST_PINS.torlan
})
afterEach(() => { process.env = { ...OLD } })

function loginReq(pin: string, ip = '1.2.3.4') {
  return new Request('https://x/api/auto-sales/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ pin }),
  })
}

// The signed session cookie the response would set on the browser → decoded back to its identity.
async function actorFromResponse(res: Response) {
  const raw = res.headers.get('set-cookie') || ''
  const m = raw.match(new RegExp(`${EMP_COOKIE}=([^;]+)`))
  if (!m || !m[1]) return null
  return authedActorFromToken(await verifyEmployeeToken(decodeURIComponent(m[1])))
}

describe('POST /api/auto-sales/session — PIN login mints the signed identity', () => {
  it('valid Darryl PIN authenticates as Darryl (manager) and sets a signed session', async () => {
    const res = await POST(loginReq(TEST_PINS.darryl, '10.0.0.1'))
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.actor).toEqual({ name: 'Darryl', role: 'manager' })  // drives "Signed in as Darryl"
    expect(await actorFromResponse(res)).toEqual({ key: 'darryl', name: 'Darryl', role: 'manager' })
  })
  it('valid Tony PIN authenticates as Tony (manager)', async () => {
    const res = await POST(loginReq(TEST_PINS.tony, '10.0.0.2'))
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.actor).toEqual({ name: 'Tony', role: 'manager' })
    expect(await actorFromResponse(res)).toEqual({ key: 'tony', name: 'Tony', role: 'manager' })
  })
  it('valid Torlan PIN authenticates as Torlan (manager)', async () => {
    const res = await POST(loginReq(TEST_PINS.torlan, '10.0.0.3'))
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.actor).toEqual({ name: 'Torlan', role: 'manager' })
    expect(await actorFromResponse(res)).toEqual({ key: 'torlan', name: 'Torlan', role: 'manager' })
  })
  it('all three managers receive an identical role (no tiers)', async () => {
    const roles = await Promise.all(
      [TEST_PINS.darryl, TEST_PINS.tony, TEST_PINS.torlan].map(async (p, i) => {
        const res = await POST(loginReq(p, `10.1.0.${i}`))
        return (await res.json()).actor.role
      }),
    )
    expect(roles).toEqual(['manager', 'manager', 'manager'])
  })
  it('a valid PIN never resolves to admin', async () => {
    const res = await POST(loginReq(TEST_PINS.torlan, '10.2.0.1'))
    expect((await res.json()).actor.role).not.toBe('admin')
  })
  it('invalid PIN → 401, no session cookie (stays unauthenticated → retry on the login screen)', async () => {
    const res = await POST(loginReq('9999', '10.3.0.1'))
    const j = await res.json()
    expect(res.status).toBe(401)
    expect(j.ok).toBe(false)
    expect(j.error).toBeTruthy()                 // a useful error is returned (shown as "Incorrect PIN")
    expect(await actorFromResponse(res)).toBeNull()
  })
})

describe('DELETE /api/auto-sales/session — Sign Out / Switch User clears the identity', () => {
  it('clears the ps_emp cookie', async () => {
    const res = await DELETE()
    const raw = res.headers.get('set-cookie') || ''
    expect(raw).toContain(`${EMP_COOKIE}=`)
    expect(raw).toMatch(/Max-Age=0/i)            // cookie is expired → next person can enter their PIN
  })
})
