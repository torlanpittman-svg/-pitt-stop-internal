/**
 * GET /api/auth/quickbooks/connect
 * Starts the Intuit OAuth flow: sets a CSRF state cookie and redirects the
 * browser to Intuit's authorization page. Reached by the admin "Connect" link.
 */
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'node:crypto'
import { buildAuthorizeUrl } from '@/apps/quickbooks/oauth'
import { isConfigured } from '@/apps/quickbooks/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const QB_STATE_COOKIE = 'qb_oauth_state'

export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json(
      { error: 'QuickBooks is not configured. Set QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, QUICKBOOKS_REDIRECT_URI and QUICKBOOKS_ENCRYPTION_KEY.' },
      { status: 500 }
    )
  }

  const state = crypto.randomBytes(24).toString('hex')

  const jar = await cookies()
  jar.set(QB_STATE_COOKIE, state, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   600, // 10 minutes
  })

  return NextResponse.redirect(buildAuthorizeUrl(state))
}
