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
  matcher: '/admin/:path*',
}
