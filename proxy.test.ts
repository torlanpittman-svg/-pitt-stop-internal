import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from './proxy'
import { EMP_COOKIE, signEmployeeSession } from '@/apps/auth/employee-session'

// Throwaway TEST values — NOT the production secret / password / PIN. Real ones live only in the deploy env.
const TORLAN = { key: 'torlan', name: 'Torlan', role: 'manager' as const }

beforeEach(() => {
  vi.stubEnv('IDENTITY_SECRET', 'test-secret')
  vi.stubEnv('ADMIN_PASSWORD', 'test-admin-password')
  vi.stubEnv('PIN_TORLAN', '4003')
})
afterEach(() => { vi.unstubAllEnvs() })

function request(path: string, opts: { method?: string; token?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.token !== undefined) headers.cookie = `${EMP_COOKIE}=${opts.token}`
  return new NextRequest(`https://os.example.test${path}`, { method: opts.method ?? 'GET', headers })
}
/** NextResponse.next() — the request continues to the route handler. */
const passedThrough = (res: Response) => res.status === 200 && res.headers.get('x-middleware-next') === '1'
const basicChallenge = (res: Response) => res.headers.get('www-authenticate')

describe('proxy — /api/checks is the manager check-writing surface, not the admin Basic-Auth surface', () => {
  it.each(['GET', 'POST'])('lets a signed-in manager %s the root /api/checks with no Basic-Auth challenge', async (method) => {
    const res = await proxy(request('/api/checks', { method, token: await signEmployeeSession(TORLAN) }))
    expect(basicChallenge(res)).toBeNull()
    expect(passedThrough(res)).toBe(true)
  })

  it.each([
    ['GET', '/api/checks/links'],
    ['POST', '/api/checks/resolve-payee'],
    ['POST', '/api/checks/test-print'],
    ['POST', '/api/checks/abc123/queue-print'],
    ['POST', '/api/checks/abc123/retry-qb'],
    ['GET', '/api/checks/abc123/jobs'],
  ])('lets a signed-in manager through nested %s %s', async (method, path) => {
    const res = await proxy(request(path, { method, token: await signEmployeeSession(TORLAN) }))
    expect(basicChallenge(res)).toBeNull()
    expect(passedThrough(res)).toBe(true)
  })

  it.each([
    ['no session cookie', undefined],
    ['a malformed token', 'not-a-token'],
    ['a token with a forged signature', 'eyJleHAiOjk5OTk5OTk5OTk5OTl9.forged'],
  ])('answers %s with JSON 401 and never a Basic-Auth challenge', async (_label, token) => {
    for (const [method, path] of [['GET', '/api/checks'], ['POST', '/api/checks'], ['POST', '/api/checks/resolve-payee']]) {
      const res = await proxy(request(path, { method, token }))
      expect(res.status).toBe(401)
      expect(basicChallenge(res)).toBeNull()
      expect(await res.json()).toEqual({ ok: false, error: 'Sign in required' })
    }
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signEmployeeSession(TORLAN)
    vi.stubEnv('IDENTITY_SECRET', 'other-secret')
    const res = await proxy(request('/api/checks', { method: 'POST', token }))
    expect(res.status).toBe(401)
    expect(basicChallenge(res)).toBeNull()
  })
})

describe('proxy — check boundaries that must not move', () => {
  it.each([
    ['GET', '/api/admin/checks/setup'],
    ['POST', '/api/admin/checks/setup'],
    ['GET', '/api/admin/checks/specimen'],
    ['POST', '/api/admin/checks/specimen'],
  ])('still Basic-Auth challenges a manager session on %s %s', async (method, path) => {
    const res = await proxy(request(path, { method, token: await signEmployeeSession(TORLAN) }))
    expect(res.status).toBe(401)
    expect(basicChallenge(res)).toBe('Basic realm="Pitt Stop Admin"')
    expect(passedThrough(res)).toBe(false)
  })

  it.each(['/api/checks-other', '/api/checks-other/thing', '/api/checksum'])('does not treat the look-alike %s as the checks surface', async (path) => {
    const res = await proxy(request(path, { method: 'POST', token: await signEmployeeSession(TORLAN) }))
    // Not operational: a manager session does not open it; it stays on the admin gate.
    expect(passedThrough(res)).toBe(false)
    expect(res.status).toBe(401)
    expect(basicChallenge(res)).toBe('Basic realm="Pitt Stop Admin"')
  })
})
