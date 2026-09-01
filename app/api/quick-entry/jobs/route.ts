/** POST /api/quick-entry/jobs — capture a job onto the Work Board (no QB/AutoLeap). */
import { NextResponse } from 'next/server'
import { createQuickEntryJob, type CreateJobInput } from '@/apps/quick-entry/jobs-db'
import { getActor } from '@/apps/workflow/identity'
import { employeeAuthorizedFromRequest } from '@/apps/auth/employee-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    // Defense-in-depth (proxy.ts is the primary gate): no unauthenticated Job creation.
    if (!(await employeeAuthorizedFromRequest(req))) {
      return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
    }
    const body = (await req.json()) as CreateJobInput
    if (!body?.customerName?.trim()) {
      return NextResponse.json({ ok: false, error: 'Customer name is required.' }, { status: 400 })
    }
    // Attribute the check-in to the active employee (falls back to prior default).
    const actor = getActor(req.headers.get('cookie'))
    const createdBy = actor?.name || body.createdBy || 'quick_entry'
    // Server-side enforcement: only a manager/admin can set an AUTHORITATIVE invoice work price
    // (explicit_pretax → drives fees/tax/QB). For anyone else it is dropped, unchanged.
    const isManager = actor?.role === 'manager' || actor?.role === 'admin'
    const workPriceCents = isManager && body.workPriceCents && body.workPriceCents > 0 ? Math.round(body.workPriceCents) : null
    // The EXPECTED/operational Job value is available to ANY authenticated employee (it never touches
    // the invoice). Sanitize + clamp; the per-service audit bundle is size-limited.
    const agreedPriceCents = body.agreedPriceCents && body.agreedPriceCents > 0 ? Math.round(body.agreedPriceCents) : null
    const agreedServices = Array.isArray(body.agreedServices)
      ? body.agreedServices.slice(0, 40).map((s) => ({
          originalText: String(s?.originalText ?? '').slice(0, 200),
          matchedFamily: s?.matchedFamily ? String(s.matchedFamily).slice(0, 120) : null,
          matchedDisplay: s?.matchedDisplay ? String(s.matchedDisplay).slice(0, 200) : null,
          suggestedCents: Number.isFinite(s?.suggestedCents as number) ? Math.round(s!.suggestedCents as number) : null,
          sampleSize: Number.isFinite(s?.sampleSize as number) ? Math.round(s!.sampleSize as number) : null,
          confirmedCents: Math.max(0, Math.round(Number(s?.confirmedCents) || 0)),
        }))
      : undefined
    const internalNote = typeof body.internalNote === 'string' ? body.internalNote.slice(0, 500) : null
    const isUrgent = body.isUrgent === true
    const res = await createQuickEntryJob({ ...body, customerName: body.customerName.trim(), createdBy, workPriceCents, agreedPriceCents, agreedServices, internalNote, isUrgent })
    return NextResponse.json({ ok: true, ...res })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
