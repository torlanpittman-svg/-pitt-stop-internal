/**
 * GET /api/auth/quickbooks/callback
 * Intuit redirects here after the user authorizes. Verifies the CSRF state,
 * exchanges the code for tokens, stores them encrypted, then bounces back to
 * the admin integration page with a status query param.
 */
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCodeForTokens } from '@/apps/quickbooks/oauth'
import { saveConnection } from '@/apps/quickbooks/db'
import { getQBConfig } from '@/apps/quickbooks/config'
import { logger } from '@/platform/logger'
import { QB_STATE_COOKIE } from '../connect/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const APP = 'quickbooks:oauth'
const ADMIN_PATH = '/admin/integrations/quickbooks'

function redirectToAdmin(origin: string, params: Record<string, string>) {
  const url = new URL(ADMIN_PATH, origin)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url)
  const code    = searchParams.get('code')
  const realmId = searchParams.get('realmId')
  const state   = searchParams.get('state')
  const oauthError = searchParams.get('error')

  if (oauthError) {
    logger.warn(APP, 'callback.provider_error', { error: oauthError })
    return redirectToAdmin(origin, { error: oauthError })
  }
  if (!code || !realmId || !state) {
    return redirectToAdmin(origin, { error: 'missing_params' })
  }

  const jar = await cookies()
  const savedState = jar.get(QB_STATE_COOKIE)?.value
  if (!savedState || savedState !== state) {
    logger.warn(APP, 'callback.state_mismatch', {})
    return redirectToAdmin(origin, { error: 'state_mismatch' })
  }
  jar.delete(QB_STATE_COOKIE)

  try {
    const tokens = await exchangeCodeForTokens(code)
    const { environment } = getQBConfig()
    await saveConnection({ realmId, environment, tokens })
    logger.info(APP, 'callback.connected', { realmId, environment })
    return redirectToAdmin(origin, { connected: '1', realm: realmId })
  } catch (err) {
    logger.error(APP, 'callback.token_exchange_failed', { error: String(err) })
    return redirectToAdmin(origin, { error: 'token_exchange_failed' })
  }
}
