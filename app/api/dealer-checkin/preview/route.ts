/**
 * POST /api/dealer-checkin/preview
 * Read-only preview for the confirmation screen — resolves dealer, pricing,
 * duplicate status, and the target invoice without writing anything.
 */
import { NextResponse } from 'next/server'
import { previewDealerCheckIn, type CheckInInput } from '@/apps/dealer-checkin/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CheckInInput
    const preview = await previewDealerCheckIn(body)
    return NextResponse.json(preview)
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
