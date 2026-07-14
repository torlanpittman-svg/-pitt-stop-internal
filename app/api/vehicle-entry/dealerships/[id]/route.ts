import { NextResponse } from 'next/server'
import { updateDealership, deleteDealership } from '@/apps/vehicle-entry/db'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body   = await request.json().catch(() => null) as {
    name?: string
    stockPrefix?: string
    active?: boolean
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const patch: typeof body = {}
  if (typeof body.name        === 'string')  patch.name        = body.name.trim()
  if (typeof body.stockPrefix === 'string')  patch.stockPrefix = body.stockPrefix.trim().toUpperCase()
  if (typeof body.active      === 'boolean') patch.active      = body.active

  const updated = await updateDealership(id, patch)
  if (!updated) return NextResponse.json({ error: 'Dealership not found' }, { status: 404 })
  return NextResponse.json(updated)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  await deleteDealership(id)
  return new NextResponse(null, { status: 204 })
}
