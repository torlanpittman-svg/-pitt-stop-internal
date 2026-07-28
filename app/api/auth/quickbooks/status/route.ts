/**
 * GET /api/auth/quickbooks/status
 * Returns the current connection status + config diagnostics (no secrets, no
 * token material). Used by the admin integration panel.
 */
import { NextResponse } from 'next/server'
import { getConnectionStatus } from '@/apps/quickbooks/connection'
import { configDiagnostics } from '@/apps/quickbooks/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [status, config] = await Promise.all([
      getConnectionStatus(),
      Promise.resolve(configDiagnostics()),
    ])
    return NextResponse.json({ status, config })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
