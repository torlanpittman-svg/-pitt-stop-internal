import { NextResponse } from 'next/server'
import { getDb } from '@/platform/db'
import { mockQbInvoices } from '@/apps/vehicle-entry/schema'
import { createMockQBInvoice, nextMockInvoiceNumber } from '@/apps/vehicle-entry/invoice-db'
import { desc } from 'drizzle-orm'
import { demoStore } from '@/platform/demo-store'
import type { MockQBInvoiceRow } from '@/apps/vehicle-entry/invoice-db'

export const dynamic = 'force-dynamic'

function isDemoMode() { return !process.env.DATABASE_URL }

export async function GET() {
  if (isDemoMode()) {
    return NextResponse.json(demoStore.list<MockQBInvoiceRow>('mock_qb_invoices'))
  }
  const db   = getDb()
  const rows = await db.select().from(mockQbInvoices).orderBy(desc(mockQbInvoices.createdAt))
  return NextResponse.json(rows)
}

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const customerId   = typeof body.customerId   === 'string' ? body.customerId   : null
  const customerName = typeof body.customerName === 'string' ? body.customerName : ''

  if (!customerId) {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 })
  }

  const invoiceNumber = typeof body.invoiceNumber === 'string'
    ? body.invoiceNumber
    : await nextMockInvoiceNumber()

  const id  = `mock-${Date.now()}`
  const row = await createMockQBInvoice({ id, customerId, customerName, invoiceNumber })
  return NextResponse.json(row, { status: 201 })
}
