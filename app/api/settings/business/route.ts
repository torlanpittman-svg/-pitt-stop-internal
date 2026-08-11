/**
 * GET /api/settings/business — resolved shop fee/tax rules (shop supplies, card fee,
 * default tax) for the manager-only pricing card. Read-only, no secrets. Gated to
 * manager/admin so the card (and its data) never surfaces to employees.
 */
import { NextResponse } from 'next/server'
import { getActor } from '@/apps/workflow/identity'
import { getBusinessConfig } from '@/apps/settings/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const actor = getActor(req.headers.get('cookie'))
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return NextResponse.json(await getBusinessConfig())
}
