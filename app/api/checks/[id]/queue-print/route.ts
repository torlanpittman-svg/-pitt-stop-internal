/**
 * POST /api/checks/[id]/queue-print — enqueue a recorded check onto the cloud print queue for the
 * always-on shop print bridge (production path; the phone never talks to the printer). `reprint:true`
 * enqueues another job for the SAME check — never creates/alters a QuickBooks transaction. Manager-only.
 *
 * Body: { reprint?: boolean }
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { queueCheckPrint, CheckValidationError } from '@/apps/checks/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { id } = await params
  let body: { reprint?: boolean }
  try { body = await req.json() } catch { body = {} }
  try {
    const { jobId } = await queueCheckPrint(id, { key: actor.key, name: actor.name }, { reprint: !!body.reprint })
    return NextResponse.json({ ok: true, jobId })
  } catch (e) {
    if (e instanceof CheckValidationError) return NextResponse.json({ error: e.code, message: e.message }, { status: 400 })
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}
