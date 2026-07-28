/**
 * POST /api/auth/quickbooks/disconnect
 * Revokes the refresh token at Intuit and marks the local connection revoked.
 * Only runs on an explicit, user-initiated request (the admin Disconnect button).
 */
import { NextResponse } from 'next/server'
import { revokeToken } from '@/apps/quickbooks/oauth'
import { getActiveConnection, markRevoked, recordError } from '@/apps/quickbooks/db'
import { decrypt } from '@/apps/quickbooks/crypto'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const APP = 'quickbooks:oauth'

export async function POST() {
  try {
    const conn = await getActiveConnection()
    if (!conn) {
      return NextResponse.json({ ok: true, alreadyDisconnected: true })
    }

    try {
      await revokeToken(decrypt(conn.refreshTokenEnc))
    } catch (err) {
      // Even if revoke fails upstream, mark it revoked locally so it stops being used.
      await recordError(conn.id, 'revoke failed: ' + String(err))
      logger.warn(APP, 'disconnect.revoke_failed', { realmId: conn.realmId, error: String(err) })
    }

    await markRevoked(conn.id)
    logger.info(APP, 'disconnect.done', { realmId: conn.realmId })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
