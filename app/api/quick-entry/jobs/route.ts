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
    // Server-side enforcement: only a manager/admin can set an explicit work price.
    // For anyone else the price is dropped → the Job stays itemized/$0 as today.
    const isManager = actor?.role === 'manager' || actor?.role === 'admin'
    const workPriceCents = isManager && body.workPriceCents && body.workPriceCents > 0 ? Math.round(body.workPriceCents) : null
    const internalNote = typeof body.internalNote === 'string' ? body.internalNote.slice(0, 500) : null
    const res = await createQuickEntryJob({ ...body, customerName: body.customerName.trim(), createdBy, workPriceCents, internalNote })
    return NextResponse.json({ ok: true, ...res })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
