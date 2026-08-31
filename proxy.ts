import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { EMP_COOKIE, employeePinConfigured, verifyEmployeeToken } from '@/apps/auto-sales/session'

/** Valid admin Basic-Auth? (password-only; trimmed). Admin always satisfies any gate below. */
function adminOk(request: NextRequest): boolean {
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminPassword) return true // no password set = open (local dev / first-run)
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Basic ')) return false
  try {
    const creds = atob(authHeader.slice(6))
    return creds.slice(creds.indexOf(':') + 1).trim() === adminPassword.trim()
  } catch { return false }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ── Employee Auto-Sales surface: /auto-sales/* + /api/auto-sales/* ──
  // Gated by a 4-digit EMPLOYEE_PIN session (or admin Basic-Auth). The login page + session API are
  // exempt so a device CAN log in. This branch ALWAYS returns — it never falls through to the admin
  // Basic-Auth gate below (so the PIN login surface isn't blocked). It never unlocks /admin/*.
  const isEmployeeArea = pathname.startsWith('/auto-sales') || pathname.startsWith('/api/auto-sales')
  if (isEmployeeArea) {
    const isLoginSurface = pathname === '/auto-sales/login' || pathname.startsWith('/api/auto-sales/session')
    if (isLoginSurface) return NextResponse.next()
    if (!employeePinConfigured()) return NextResponse.next() // no PIN configured = open (dev)
    if (adminOk(request)) return NextResponse.next()          // admin always allowed
    const token = request.cookies.get(EMP_COOKIE)?.value
    if (await verifyEmployeeToken(token)) return NextResponse.next()
    // Not authorized: API → 401 JSON (never a Basic-Auth challenge); page → redirect to PIN login.
    if (pathname.startsWith('/api/')) return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
    const url = request.nextUrl.clone(); url.pathname = '/auto-sales/login'; url.search = `?next=${encodeURIComponent(pathname)}`
    return NextResponse.redirect(url)
  }

  // ── Admin surface (/admin/* + gated QB/finance APIs) — existing ADMIN_PASSWORD Basic-Auth ──
  if (!process.env.ADMIN_PASSWORD) return NextResponse.next()
  if (adminOk(request)) return NextResponse.next()

  // Prefetch requests must NOT emit a Basic-Auth challenge (mobile Safari would pop the native
  // sign-in dialog on a normal page that merely prefetched an admin <Link>). Deny silently.
  const isPrefetch =
    request.headers.get('next-router-prefetch') === '1' ||
    request.headers.get('purpose') === 'prefetch' ||
    /prefetch/i.test(request.headers.get('sec-purpose') ?? '')
  if (isPrefetch) return new NextResponse(null, { status: 401 })

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Pitt Stop Admin"' },
  })
}

export const config = {
  // Same admin Basic-Auth gate (ADMIN_PASSWORD) that protects /admin now also protects the
  // QuickBooks diagnostic query routes AND the manual write/setup routes — none may be
  // publicly callable. Reuses the existing model; no second auth system, no change to any
  // route's underlying query/write/setup behavior (access control only). ?raw=1 is the same
  // path → automatically gated. Deliberately NOT gated: the QB OAuth callback/status under
  // /api/auth/quickbooks/*, and the normal Dealer Check-In flow (which calls invoice-write
  // functions directly, never these HTTP routes).
  matcher: [
    '/admin/:path*',
    // Employee Auto-Sales surface (pages + server-action POSTs + the receipt API). Gated by the
    // 4-digit EMPLOYEE_PIN session (login surfaces are exempted inside proxy()).
    '/auto-sales/:path*',
    '/api/auto-sales/:path*',
    // read-only diagnostics (expose customer email / memo / invoice data)
    '/api/quickbooks/query-customers',
    '/api/quickbooks/query-invoice',
    '/api/quickbooks/query-items',
    '/api/quickbooks/discover',
    // CFO finance APIs (admin-only; read-only QuickBooks + read-only Plaid; never move money)
    '/api/admin/finance/:path*',
    // manual write / setup tools (owner-run; not part of any automated flow)
    '/api/quickbooks/selftest-invoice',
    '/api/quickbooks/set-invoice-number',
    '/api/quickbooks/setup-dealers',
  ],
}
