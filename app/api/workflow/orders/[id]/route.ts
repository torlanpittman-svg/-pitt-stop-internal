import { NextResponse } from 'next/server'
import { getOrderWithContext } from '@/apps/workflow/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const order = await getOrderWithContext(id)
    if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ order })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
