import { NextResponse } from 'next/server'
import { createCustomer, createEstimate } from '@/apps/estimator/db'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      customerName?: string
      customerPhone?: string
      serviceFocus?: string
    }

    const name  = (body.customerName ?? '').trim()
    const phone = (body.customerPhone ?? '').trim() || null
    const focus = (body.serviceFocus ?? '').trim() || null

    if (!name) {
      return NextResponse.json({ error: 'customerName is required' }, { status: 400 })
    }

    const customer = await createCustomer({ name, phone })
    const estimate = await createEstimate({
      customerId:    customer.id,
      customerName:  customer.name,
      customerPhone: customer.phone,
      serviceFocus:  focus,
    })

    return NextResponse.json({ id: estimate.id, estimateNumber: estimate.estimateNumber })
  } catch (err) {
    console.error('[estimator] POST /estimates', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
