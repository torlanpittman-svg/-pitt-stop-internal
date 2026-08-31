import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { EMP_COOKIE, employeePinConfigured, verifyEmployeeToken } from '@/apps/auth/employee-session'

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

/**
 * Is this the employee OPERATIONAL surface? The shared shop PIN (ps_emp) gates the everyday phone tools
 * — Auto Sales, Work Board, Check In, Quick Entry, Dealer Check-In — and their AI/mutation APIs, so an
 * unauthenticated internet user can't view them, create Jobs/check-ins, or burn AI credits. Broadly
 * shared READ APIs (e.g. /api/workflow/orders) are intentionally NOT here (they'd break /orders,
 * /production, etc. and carry no AI/write). /admin/* is NEVER here (it stays on ADMIN_PASSWORD).
 */
function isEmployeeSurface(pathname: string): boolean {
  const pages = ['/auto-sales', '/work-board', '/check-in', '/quick-entry', '/dealer-check-in']
  if (pages.some((p) => pathname === p || pathname.startsWith(p + '/'))) return true
  const apis = ['/api/auto-sales/', '/api/dealer-checkin', '/api/quick-entry/']
  if (apis.some((p) => pathname.startsWith(p)) || pathname === '/api/dealer-checkin') return true
  if (pathname === '/api/estimator/vin' || pathname === '/api/workflow/vin') return true
  return false
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ── Employee operational surface (Auto Sales + Work Board + Check In + Quick Entry + Dealer Check-In) ──
  // Gated by the shared EMPLOYEE_PIN session (or admin Basic-Auth). The login page + session API are
  // exempt so a device CAN log in. This branch ALWAYS returns — it never falls through to the admin
  // Basic-Auth gate below (so the PIN login surface isn't blocked). It never unlocks /admin/*.
  const isEmployeeArea = isEmployeeSurface(pathname)
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
    // Employee operational surface — pages + server-action POSTs + AI/mutation APIs. Gated by the shared
    // EMPLOYEE_PIN session (login surfaces exempted inside proxy()). Broadly-shared read APIs like
    // /api/workflow/orders are deliberately excluded (no AI/write; used by /orders, /production, …).
    '/auto-sales/:path*',
    '/api/auto-sales/:path*',
    '/work-board/:path*',
    '/check-in/:path*',
    '/quick-entry/:path*',
    '/dealer-check-in/:path*',
    '/api/dealer-checkin/:path*',
    '/api/quick-entry/:path*',
    '/api/estimator/vin',
    '/api/workflow/vin',
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
