/**
 * POST /api/auto-sales/session   { pin }        → verify the 4-digit EMPLOYEE_PIN, set signed httpOnly
 *                                                 ps_emp session cookie (shift-length TTL).
 * DELETE /api/auto-sales/session                → clear the session (sign out).
 *
 * PUBLIC (exempted from the employee gate in proxy.ts) — this is HOW a device gets a session. The PIN
 * is compared server-side only and never returned/logged. A small in-memory per-IP limiter deters
 * brute-forcing the 4-digit space. The employee session never grants /admin/* access.
 */
import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { EMP_COOKIE, getEmployeePin, employeePinConfigured, signEmployeeSession, employeeSessionMaxAgeSeconds } from '@/apps/auth/employee-session'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// In-memory brute-force limiter (per instance; combined with the 4-digit + session model, sufficient).
const attempts = new Map<string, { n: number; first: number }>()
const WINDOW_MS = 10 * 60_000, MAX_ATTEMPTS = 12

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export async function POST(req: Request) {
  if (!employeePinConfigured()) return NextResponse.json({ ok: false, error: 'PIN not configured' }, { status: 503 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const now = Date.now()
  const rec = attempts.get(ip)
  if (rec && now - rec.first < WINDOW_MS && rec.n >= MAX_ATTEMPTS) {
    return NextResponse.json({ ok: false, error: 'Too many attempts — wait a few minutes.' }, { status: 429 })
  }

  const body = await req.json().catch(() => ({})) as { pin?: string }
  const pin = String(body.pin ?? '')
  const expected = getEmployeePin() ?? ''
  if (!/^\d{4,8}$/.test(pin) || !eq(pin, expected)) {
    const r = rec && now - rec.first < WINDOW_MS ? { n: rec.n + 1, first: rec.first } : { n: 1, first: now }
    attempts.set(ip, r)
    logger.warn('auto-sales:session', 'pin_reject', { ip, n: r.n })
    return NextResponse.json({ ok: false, error: 'Wrong PIN' }, { status: 401 })
  }

  attempts.delete(ip)
  const res = NextResponse.json({ ok: true })
  res.cookies.set(EMP_COOKIE, await signEmployeeSession(), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: employeeSessionMaxAgeSeconds(),
  })
  return res
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(EMP_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 })
  return res
}
