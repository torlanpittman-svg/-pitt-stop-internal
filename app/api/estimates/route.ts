import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { createIntake, intakeInput } from '@/apps/estimates/db'
import { estimateEnabled } from '@/apps/workflow/estimate'

export async function POST(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'Manager access required.' }, { status: 403 })
  if (!estimateEnabled()) return NextResponse.json({ error: 'Estimates are not enabled.' }, { status: 404 })
  const parsed = intakeInput.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Check the customer and vehicle details.' }, { status: 400 })
  try { return NextResponse.json({ ok: true, id: await createIntake(parsed.data, actor.name) }) }
  catch { return NextResponse.json({ error: 'Unable to save estimate. Please retry.' }, { status: 500 }) }
}
