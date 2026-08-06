/**
 * POST /api/workflow/orders/[id]/reopen  { reason }
 * Manager-only correction: reopen a Ready Job (work was actually incomplete).
 * Clears completed_at (preserving history in the audit event). Requires active
 * manager elevation + a reason. Employees are rejected.
 */
import { NextResponse } from 'next/server'
import { reopenOrder } from '@/apps/workflow/db'
import { parseActor, verifyElevation, effectiveRole } from '@/apps/workflow/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function readValue(cookieHeader: string | null, name: string): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const cookie = req.headers.get('cookie')
    const actor = parseActor(readValue(cookie, 'ps_actor'))
    const role = effectiveRole(actor, verifyElevation(readValue(cookie, 'ps_elev')))
    if (role !== 'manager' && role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Manager elevation required to reopen.' }, { status: 403 })
    }
    const body = (await req.json()) as { reason?: string }
    if (!body.reason?.trim()) return NextResponse.json({ ok: false, error: 'A reason is required.' }, { status: 400 })

    const result = await reopenOrder({ orderId: id, reason: body.reason, managerName: actor?.name ?? null })
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 })
    return NextResponse.json({ ok: true, order: result.order })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
