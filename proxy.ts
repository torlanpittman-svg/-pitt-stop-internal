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
