import { NextResponse } from 'next/server'
import { transitionOrder, startAssignment } from '@/apps/workflow/db'
import { getActor } from '@/apps/workflow/identity'

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
    }

    if (!body.newStatus) {
      return NextResponse.json({ error: 'newStatus required' }, { status: 400 })
    }

    // Who changed the status = the explicitly chosen tech (picker) or, failing that,
    // the active employee. The tech ASSIGNMENT below still uses the chosen tech only.
    const actorName = getActor(request.headers.get('cookie'))?.name ?? null

    const result = await transitionOrder({
      orderId:      id,
      newStatus:    body.newStatus,
      employeeName: body.employeeName ?? actorName,
      note:         body.note,
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
