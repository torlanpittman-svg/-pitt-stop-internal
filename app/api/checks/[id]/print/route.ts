/**
 * POST /api/checks/[id]/print — record the OUTCOME of a print attempt (printed | print_failed) and,
 * when reprint=true, count a reprint. Printing NEVER creates or alters a QuickBooks transaction; this
 * route only moves print_status. Refuses to mark a check printed unless it is recorded in QuickBooks.
 * Manager-only.
 *
 * Body: { success: boolean, reprint?: boolean }
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { recordPrintResult, CheckValidationError } from '@/apps/checks/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { id } = await params
  let body: { success?: boolean; reprint?: boolean }
  try { body = await req.json() } catch { body = {} }
  try {
    const check = await recordPrintResult(id, body.success !== false, { key: actor.key, name: actor.name }, { reprint: !!body.reprint })
    return NextResponse.json({ ok: true, check })
  } catch (e) {
    if (e instanceof CheckValidationError) return NextResponse.json({ error: e.code, message: e.message }, { status: 400 })
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}
