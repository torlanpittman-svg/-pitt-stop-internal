import { NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { managerFromRequest } from '@/apps/checks/authz'
import { withIntakeLock, moveIntakeToBoard } from '@/apps/estimates/db'
import { intakeSummary, refreshIntake, sendIntakeEstimate } from '@/apps/estimates/quickbooks'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { getDb } from '@/platform/db'
import { estimateEnabled } from '@/apps/workflow/estimate'

export const maxDuration = 120
const actionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), revision: z.string().length(64) }),
  z.object({ action: z.literal('convert'), revision: z.string().length(64) }),
  z.object({ action: z.literal('contact'), email: z.union([z.email().max(200), z.literal('')]), phone: z.string().max(40) }),
])
const safeSummary = (s: Awaited<ReturnType<typeof intakeSummary>>) => ({
  ok: true, draft: s.draft, revision: s.revision, status: s.order.status,
  email: s.contact?.customerEmail ?? '', phone: s.contact?.customerPhone ?? '',
  qbNumber: s.intake.qbEstimateNumber, sentAt: s.intake.sentAt,
})
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await managerFromRequest(req)) return NextResponse.json({ error: 'Manager access required.' }, { status: 403 })
  const { id } = await params
  if (!estimateEnabled() || !z.uuid().safeParse(id).success) return NextResponse.json({ error: 'Estimate not found.' }, { status: 404 })
  try { return NextResponse.json(safeSummary(await intakeSummary(id))) }
  catch { return NextResponse.json({ error: 'Unable to load estimate.' }, { status: 500 }) }
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'Manager access required.' }, { status: 403 })
  const { id } = await params
  if (!estimateEnabled() || !z.uuid().safeParse(id).success) return NextResponse.json({ error: 'Estimate not found.' }, { status: 404 })
  const parsed = actionInput.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid estimate action.' }, { status: 400 })
  try {
    return await withIntakeLock(id, async () => {
      const state = await intakeSummary(id)
      const body = parsed.data
      if (state.order.status !== 'estimate') {
        if (body.action === 'convert' && state.full?.estimate.convertedAt) return NextResponse.json({ ok: true, converted: true })
        throw new Error('This estimate has already moved onto the Work Board.')
      }
      if (body.action === 'contact') {
        await getDb().update(quickEntryJobs).set({ customerEmail: body.email || null, customerPhone: body.phone || null }).where(eq(quickEntryJobs.serviceOrderId, id))
      } else {
        if (state.revision !== body.revision) throw new Error('The estimate changed. Refresh and review it before continuing.')
        if (body.action === 'send') await sendIntakeEstimate(id, actor.name, body.revision)
        else {
          await moveIntakeToBoard(id, actor.name)
          return NextResponse.json({ ok: true, converted: true })
        }
      }
      return NextResponse.json(safeSummary(await refreshIntake(id)))
    })
  } catch (e) {
    // QB errors can contain response bodies; return a useful, bounded error without exposing them.
    const message = e instanceof Error ? e.message : 'Estimate action failed.'
    return NextResponse.json({ error: message.startsWith('QuickBooks API') ? 'QuickBooks could not complete the request. Retry to recover the same estimate.' : message }, { status: 409 })
  }
}
