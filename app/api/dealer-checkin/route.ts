/**
 * POST /api/dealer-checkin
 * Confirm a dealer check-in ("Looks Good"): writes the QB invoice line and
 * creates the Work Board order via the orchestration service.
 *
 * Production-write guard: on the production QuickBooks environment this refuses
 * unless X-QB-Write-Approved: true is present, so a real invoice is never
 * created without an explicit, deliberate approval header. Sandbox runs freely.
 */
import { NextResponse } from 'next/server'
import { checkInDealerVehicle, type CheckInInput } from '@/apps/dealer-checkin/service'
import { getEnvironment } from '@/apps/quickbooks/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    if (getEnvironment() === 'production' && req.headers.get('x-qb-write-approved') !== 'true') {
      return NextResponse.json(
        { ok: false, error: 'Production QuickBooks write requires explicit approval (X-QB-Write-Approved header).' },
        { status: 403 }
      )
    }
    const body = (await req.json()) as CheckInInput
    const result = await checkInDealerVehicle(body)
    const httpStatus = result.ok ? 200 : result.outcome === 'duplicate' ? 409 : result.outcome === 'pricing_prompt_required' ? 200 : 422
    return NextResponse.json(result, { status: httpStatus })
  } catch (err) {
    return NextResponse.json({ ok: false, outcome: 'error', error: String(err) }, { status: 500 })
  }
}
