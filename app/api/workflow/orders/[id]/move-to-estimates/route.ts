import { NextResponse } from 'next/server'
import { z } from 'zod'
import { managerFromRequest } from '@/apps/checks/authz'
import { estimateEnabled } from '@/apps/workflow/estimate'
import { planMoveToEstimates, executeMoveToEstimates } from '@/apps/estimates/move-to-estimates'

/** Read-only preview: customer + vehicle, or the specific plain-language reason the move is blocked.
 *  The confirm sheet calls this when it opens; the POST re-checks eligibility. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'Manager access required.' }, { status: 403 })
  const { id } = await params
  if (!estimateEnabled() || !z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Estimate not found.' }, { status: 404 })
  }
  const result = await planMoveToEstimates(id)
  if (!result.ok) return NextResponse.json({ error: result.error ?? 'Job not found.' }, { status: 404 })
  return NextResponse.json({ ok: true, preview: result.preview })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'Manager access required.' }, { status: 403 })
  const { id } = await params
  if (!estimateEnabled() || !z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Estimate not found.' }, { status: 404 })
  }
  const result = await executeMoveToEstimates({ orderId: id, actor: actor.name })
  if (!result.ok) {
    const status = result.block === 'not_found' ? 404 : 409
    return NextResponse.json({ error: result.error ?? 'Unable to move this job.', code: result.code }, { status })
  }
  return NextResponse.json({ ok: true, href: `/orders/${id}/estimate` })
}
