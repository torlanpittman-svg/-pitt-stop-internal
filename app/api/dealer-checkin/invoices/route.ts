/**
 * GET /api/dealer-checkin/invoices
 * Live per-dealer open-invoice overview (read-only).
 */
import { NextResponse } from 'next/server'
import { getDealerInvoiceOverview } from '@/apps/dealer-checkin/overview'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const overview = await getDealerInvoiceOverview()
    return NextResponse.json({ ok: true, ...overview })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
