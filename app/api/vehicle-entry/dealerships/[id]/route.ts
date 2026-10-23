import { NextResponse } from 'next/server'
import { listDealerships, updateDealership } from '@/apps/vehicle-entry/db'
import { checkPrefixEdit } from '@/apps/vehicle-entry/dealership-setup'
import { authorizedManagerStrictFromRequest } from '@/apps/auth/employee-guard'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await authorizedManagerStrictFromRequest(request))) {
    return NextResponse.json({ error: 'Manager sign-in required' }, { status: 403 })
  }
  const { id } = await params
  const body   = await request.json().catch(() => null) as {
    name?: string
    stockPrefix?: string | null
    active?: boolean
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const patch: { name?: string; stockPrefix?: string | null; active?: boolean } = {}
  if (typeof body.name === 'string') {
    if (!body.name.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 })
    patch.name = body.name.trim()
  }
  if (typeof body.stockPrefix === 'string' || body.stockPrefix === null) {
    const check = checkPrefixEdit(id, body.stockPrefix, await listDealerships(false))
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
    patch.stockPrefix = check.stockPrefix
  }
  if (typeof body.active === 'boolean') patch.active = body.active

  const updated = await updateDealership(id, patch)
  if (!updated) return NextResponse.json({ error: 'Dealership not found' }, { status: 404 })
  return NextResponse.json(updated)
}

// "Remove" is a soft deactivate, never a hard delete: dealer_scans and invoice
// batches keep pointing at this row, and it can be re-activated.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await authorizedManagerStrictFromRequest(request))) {
    return NextResponse.json({ error: 'Manager sign-in required' }, { status: 403 })
  }
  const { id } = await params
  const updated = await updateDealership(id, { active: false })
  if (!updated) return NextResponse.json({ error: 'Dealership not found' }, { status: 404 })
  return NextResponse.json(updated)
}
