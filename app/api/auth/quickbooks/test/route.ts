/**
 * GET /api/auth/quickbooks/test
 * Read-only connectivity check. Fetches the connected company's profile from
 * QuickBooks — makes no changes. Confirms tokens, refresh, and API host all work.
 */
import { NextResponse } from 'next/server'
import { getCompanyInfo } from '@/apps/quickbooks/client'
import { QBNotConnectedError, QBReauthRequiredError } from '@/apps/quickbooks/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const company = await getCompanyInfo()
    return NextResponse.json({ ok: true, company })
  } catch (err) {
    if (err instanceof QBNotConnectedError) {
      return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status: 409 })
    }
    if (err instanceof QBReauthRequiredError) {
      return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status: 401 })
    }
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
