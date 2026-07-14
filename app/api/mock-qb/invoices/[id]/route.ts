import { NextResponse } from 'next/server'
import { getMockQBInvoice } from '@/apps/vehicle-entry/invoice-db'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const invoice = await getMockQBInvoice(id)
  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(invoice)
}
