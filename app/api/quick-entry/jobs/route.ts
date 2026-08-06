/** POST /api/quick-entry/jobs — capture a job onto the Work Board (no QB/AutoLeap). */
import { NextResponse } from 'next/server'
import { createQuickEntryJob, type CreateJobInput } from '@/apps/quick-entry/jobs-db'
import { getActor } from '@/apps/workflow/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateJobInput
    if (!body?.customerName?.trim()) {
      return NextResponse.json({ ok: false, error: 'Customer name is required.' }, { status: 400 })
    }
    // Attribute the check-in to the active employee (falls back to prior default).
    const actor = getActor(req.headers.get('cookie'))
    const createdBy = actor?.name || body.createdBy || 'quick_entry'
    const res = await createQuickEntryJob({ ...body, customerName: body.customerName.trim(), createdBy })
    return NextResponse.json({ ok: true, ...res })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
