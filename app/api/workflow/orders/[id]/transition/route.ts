import { NextResponse } from 'next/server'
import { transitionOrder, startAssignment, getOrderWithContext } from '@/apps/workflow/db'
import { getActor } from '@/apps/workflow/identity'
import { validateCompletion, completionEnabled, type CompletionPayload } from '@/apps/workflow/completion'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const body = await request.json() as {
      newStatus:     string
      employeeName?: string | null
      note?:         string
      completion?:   CompletionPayload
    }

    if (!body.newStatus) {
      return NextResponse.json({ error: 'newStatus required' }, { status: 400 })
    }

    // Who changed the status = the explicitly chosen tech (picker) or, failing that,
    // the active employee. The tech ASSIGNMENT below still uses the chosen tech only.
    const actorName = getActor(request.headers.get('cookie'))?.name ?? null

    // Completion gate: becoming Ready requires acknowledging every assigned service +
    // the general final checks (QC only when qc_required). Blocks casual one-tap done.
    let checklist: Record<string, unknown> | null = null
    if (completionEnabled() && body.newStatus === 'ready') {
      const order = await getOrderWithContext(id)
      if (!order) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
      const check = validateCompletion(order.services, order.qcRequired, body.completion)
      if (!check.ok) {
        return NextResponse.json({ error: 'completion_incomplete', reason: check.error, missing: check.missing ?? [] }, { status: 422 })
      }
      checklist = { ...body.completion, at: new Date().toISOString(), by: actorName }
    }

    const result = await transitionOrder({
      orderId:      id,
      newStatus:    body.newStatus,
      employeeName: body.employeeName ?? actorName,
      note:         body.note,
      completedBy:  body.newStatus === 'ready' ? actorName : undefined,
      completionChecklist: checklist,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }

    // When moving to in_progress, create an assignment session for the tech
    if (body.newStatus === 'in_progress' && body.employeeName) {
      await startAssignment({ serviceOrderId: id, employeeName: body.employeeName })
    }

    return NextResponse.json({ order: result.order })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
