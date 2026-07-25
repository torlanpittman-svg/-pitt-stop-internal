import { NextResponse } from 'next/server'
import { transitionOrder, startAssignment } from '@/apps/workflow/db'

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

    const result = await transitionOrder({
      orderId:      id,
      newStatus:    body.newStatus,
      employeeName: body.employeeName ?? null,
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
