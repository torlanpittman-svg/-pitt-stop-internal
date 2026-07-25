import { NextResponse } from 'next/server'
import { startAssignment, stopAssignments } from '@/apps/workflow/db'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const body = await request.json() as {
      action:        'start' | 'stop'
      employeeName?: string
    }

    if (body.action === 'start') {
      if (!body.employeeName) {
        return NextResponse.json({ error: 'employeeName required for start' }, { status: 400 })
      }
      const assignment = await startAssignment({ serviceOrderId: id, employeeName: body.employeeName })
      return NextResponse.json({ assignment })
    }

    if (body.action === 'stop') {
      await stopAssignments(id)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'action must be start or stop' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
