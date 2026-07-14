import { NextResponse } from 'next/server'
import { listDealerships, createDealership } from '@/apps/vehicle-entry/db'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const all = searchParams.get('all') === 'true'
  const items = await listDealerships(!all)
  return NextResponse.json(items)
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { name?: string; stockPrefix?: string } | null
  if (!body?.name?.trim())        return NextResponse.json({ error: 'name required' },        { status: 400 })
  if (!body?.stockPrefix?.trim()) return NextResponse.json({ error: 'stockPrefix required' }, { status: 400 })

  const id = await createDealership({
    name:        body.name.trim(),
    stockPrefix: body.stockPrefix.trim().toUpperCase(),
  })
  return NextResponse.json({ id }, { status: 201 })
}
