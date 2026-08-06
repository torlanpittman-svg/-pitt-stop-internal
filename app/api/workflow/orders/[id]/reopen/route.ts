/**
 * POST /api/workflow/orders/[id]/reopen  { reason, pin }
 *
 * Reopen a Ready Job (work was actually incomplete) — a sensitive correction.
 * Requires (a) the active person's BASE role is manager/admin, and (b) a PIN
 * step-up confirmation (the actor re-enters their own PIN for this one action).
 * This does NOT use a persistent 10-min elevation — normal manager work needs no PIN.
 * Clears completed_at (preserving history in the audit event).
 */
import { NextResponse } from 'next/server'
import { reopenOrder, getEmployee } from '@/apps/workflow/db'
import { parseActor, verifyPin, baseRole } from '@/apps/workflow/identity'

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
    const actor = parseActor(readValue(req.headers.get('cookie'), 'ps_actor'))
    if (baseRole(actor) !== 'manager' && baseRole(actor) !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Only a manager or admin can reopen.' }, { status: 403 })
    }
    const body = (await req.json()) as { reason?: string; pin?: string }
    if (!body.reason?.trim()) return NextResponse.json({ ok: false, error: 'A reason is required.' }, { status: 400 })

    // PIN step-up confirmation against the active person's own PIN.
    const emp = actor?.id ? await getEmployee(actor.id) : null
    if (!emp || !verifyPin(body.pin ?? '', emp.pinHash)) {
      return NextResponse.json({ ok: false, error: 'Manager PIN required to confirm this correction.' }, { status: 401 })
    }

    const result = await reopenOrder({ orderId: id, reason: body.reason, managerName: actor?.name ?? null })
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 })
    return NextResponse.json({ ok: true, order: result.order })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
