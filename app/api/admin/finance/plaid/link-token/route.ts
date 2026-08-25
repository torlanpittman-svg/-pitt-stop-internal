/**
 * POST /api/admin/finance/plaid/link-token — create a Plaid Link token for the admin connect.
 * Admin Basic-Auth gated (proxy.ts). Read-only scope; no money movement. Returns only the
 * short-lived link_token (safe to send to the browser to open Plaid Link).
 */
import { NextResponse } from 'next/server'
import { createLinkToken, plaidConfigured, plaidEnv } from '@/apps/finance/plaid'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  if (!plaidConfigured()) return NextResponse.json({ ok: false, error: 'Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET).' }, { status: 503 })
  try {
    const linkToken = await createLinkToken('pittstop-admin')
    return NextResponse.json({ ok: true, linkToken, env: plaidEnv() })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, { status: 500 })
  }
}
