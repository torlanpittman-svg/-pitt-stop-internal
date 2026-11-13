import { NextResponse } from 'next/server'
import { environmentSummary } from '@/platform/preview-guard'

export const dynamic = 'force-dynamic'

/** Liveness + a NON-SECRET description of which environment this is and whether it may touch data. Used to
 *  verify that a preview deployment is fail-closed. Never returns a URL, host, token or any setting value. */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'pitt-stop-internal',
    timestamp: new Date().toISOString(),
    environment: environmentSummary(),
  })
}
