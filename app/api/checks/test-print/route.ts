/**
 * POST /api/checks/test-print — enqueue a NON-NEGOTIABLE VOID test page to the shop printer via the
 * cloud queue + bridge. Proves the full phone → cloud → bridge → Brother path and is the calibration
 * tool. Creates NO check record and NO QuickBooks transaction. Manager-only.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { enqueueTestPrint } from '@/apps/checks/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  try {
    const { jobId } = await enqueueTestPrint({ key: actor.key, name: actor.name })
    return NextResponse.json({ ok: true, jobId })
  } catch (e) {
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}
