/**
 * POST /api/checks/resolve-payee — READ-ONLY preview of how a typed payee resolves to a QuickBooks
 * vendor: existing (use), will-create, or ambiguous (pick one). No QuickBooks mutation. Powers the
 * confirmation step so a check never silently creates a duplicate vendor or picks the wrong one.
 * Manager-only.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { previewVendor } from '@/apps/checks/vendor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  let body: { payeeName?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  const name = String(body.payeeName ?? '').trim()
  if (!name) return NextResponse.json({ error: 'payee_required' }, { status: 400 })
  try {
    return NextResponse.json(await previewVendor(name))
  } catch (e) {
    return NextResponse.json({ error: 'qb_error', message: String((e as Error)?.message ?? e) }, { status: 502 })
  }
}
