import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const adminPassword = process.env.ADMIN_PASSWORD

  // No password set = open access (local dev / first-run)
  if (!adminPassword) {
    return NextResponse.next()
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Basic ')) {
    try {
      const credentials = atob(authHeader.slice(6))
      const colonIdx = credentials.indexOf(':')
      const password = credentials.slice(colonIdx + 1)
      if (password === adminPassword) {
        return NextResponse.next()
      }
    } catch {
      // fall through to 401
    }
  }

  // Prefetch requests must NOT emit a Basic-Auth challenge: Next.js / the browser
  // background-prefetch admin <Link>s that can appear on normal pages, and a 401
  // carrying `WWW-Authenticate: Basic` makes mobile Safari pop the native sign-in
  // dialog even though the user never navigated to /admin. Deny the prefetch
  // silently (no challenge) — real navigations below still get the login prompt,
  // so /admin stays fully protected.
  const isPrefetch =
    request.headers.get('next-router-prefetch') === '1' ||
    request.headers.get('purpose') === 'prefetch' ||
    /prefetch/i.test(request.headers.get('sec-purpose') ?? '')
  if (isPrefetch) {
    return new NextResponse(null, { status: 401 })
  }

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Pitt Stop Admin"',
    },
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
    // read-only diagnostics (expose customer email / memo / invoice data)
    '/api/quickbooks/query-customers',
    '/api/quickbooks/query-invoice',
    '/api/quickbooks/query-items',
    '/api/quickbooks/discover',
    // manual write / setup tools (owner-run; not part of any automated flow)
    '/api/quickbooks/selftest-invoice',
    '/api/quickbooks/set-invoice-number',
    '/api/quickbooks/setup-dealers',
  ],
}
