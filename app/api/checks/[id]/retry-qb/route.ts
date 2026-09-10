/**
 * POST /api/checks/[id]/retry-qb — retry the QuickBooks Purchase/Check write for a check whose prior
 * write FAILED. Same row, same check number, adoption-safe (never creates a duplicate Purchase if the
 * earlier attempt actually reached QuickBooks). No-op returning recorded=true if already recorded.
 * Manager-only.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { retryQbWrite, CheckValidationError } from '@/apps/checks/service'
import { getCheckView } from '@/apps/checks/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { id } = await params
  try {
    const result = await retryQbWrite(id, { key: actor.key, name: actor.name })
    return NextResponse.json({ ok: result.recorded, ...result, check: await getCheckView(id) })
  } catch (e) {
    if (e instanceof CheckValidationError) return NextResponse.json({ error: e.code, message: e.message }, { status: 400 })
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}
