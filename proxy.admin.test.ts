/**
 * The OWNER surface (/admin/*, incl. the CFO page) — pins who can and cannot open it.
 *   - It is behind ADMIN_PASSWORD (HTTP Basic). The username is ignored; only the password is checked.
 *   - A staff PIN session — even a manager's — never opens it. Manager is not admin.
 *   - A background prefetch is refused quietly (no sign-in pop-up on an ordinary page).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from './proxy'
import { EMP_COOKIE, signEmployeeSession } from '@/apps/auth/employee-session'

const ENV = ['ADMIN_PASSWORD', 'IDENTITY_SECRET', 'PIN_TORLAN'] as const
const saved: Record<string, string | undefined> = {}
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
const get = (path: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`https://pitt-stop-internal.vercel.app${path}`, { headers }))

describe('proxy — /admin/finance is owner-only (ADMIN_PASSWORD), never unlocked by a staff PIN', () => {
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k]
    process.env.ADMIN_PASSWORD = 'owner-test-password'
    process.env.IDENTITY_SECRET = 'test-identity-secret'
    process.env.PIN_TORLAN = '4321'
  })
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

  it('with no credentials: 401 and a Basic challenge, so the browser shows its sign-in box', async () => {
    const res = await get('/admin/finance')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/)
  })

  it('the correct password opens it — with ANY username, and with stray spaces around the password', async () => {
    expect((await get('/admin/finance', { authorization: basic('torlan', 'owner-test-password') })).status).toBe(200)
    expect((await get('/admin/finance', { authorization: basic('', 'owner-test-password') })).status).toBe(200)
    expect((await get('/admin/finance/reconcile', { authorization: basic('x', ' owner-test-password ') })).status).toBe(200)
  })

  it('a wrong password is refused', async () => {
    expect((await get('/admin/finance', { authorization: basic('torlan', 'nope') })).status).toBe(401)
  })

  it('a signed-in MANAGER (PIN session) is refused — manager is not admin', async () => {
    const token = await signEmployeeSession({ key: 'torlan', name: 'Torlan', role: 'manager' })
    const res = await get('/admin/finance', { cookie: `${EMP_COOKIE}=${token}` })
    expect(res.status).toBe(401)
    // …and the finance APIs behind the page are refused the same way.
    expect((await get('/api/admin/finance/sync', { cookie: `${EMP_COOKIE}=${token}` })).status).toBe(401)
  })

  it('a background prefetch gets a quiet 401 with NO challenge (no surprise sign-in pop-up)', async () => {
    const res = await get('/admin/finance', { 'next-router-prefetch': '1' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })
})
