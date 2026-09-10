/**
 * GET /api/admin/checks/accounts?type=Bank|Expense — READ-ONLY list of QuickBooks accounts for the
 * owner setup screen, so the operating *2649 bank and each category's expense account are PICKED from
 * the real production company (never guessed/typed). Account numbers are masked. Admin-gated.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { listAccounts } from '@/apps/checks/qb-check'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const type = new URL(req.url).searchParams.get('type') === 'Expense' ? 'Expense' : 'Bank'
  try {
    return NextResponse.json({ type, accounts: await listAccounts(type) })
  } catch (e) {
    return NextResponse.json({ error: 'qb_error', message: String((e as Error)?.message ?? e) }, { status: 502 })
  }
}
