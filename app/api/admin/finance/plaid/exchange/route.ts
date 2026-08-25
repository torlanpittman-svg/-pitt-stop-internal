/**
 * POST /api/admin/finance/plaid/exchange { public_token } — exchange Plaid's public token for an
 * access token (server-side), store it ENCRYPTED, and pull read-only accounts + balances. Admin
 * Basic-Auth gated. The bank login never touches this server — only Plaid's short-lived public
 * token does. No money movement, no QuickBooks writes.
 */
import { NextResponse } from 'next/server'
import { exchangePublicToken, plaidConfigured } from '@/apps/finance/plaid'
import { savePlaidConnection } from '@/apps/finance/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (!plaidConfigured()) return NextResponse.json({ ok: false, error: 'Plaid is not configured.' }, { status: 503 })
  const body = await req.json().catch(() => ({})) as { public_token?: string }
  if (!body?.public_token) return NextResponse.json({ ok: false, error: 'public_token required' }, { status: 400 })
  try {
    const { accessToken, itemId } = await exchangePublicToken(body.public_token)
    const saved = await savePlaidConnection({ itemId, accessToken, connectedBy: 'admin' })
    return NextResponse.json({ ok: true, institution: saved.institutionName, accounts: saved.accounts })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, { status: 500 })
  }
}
