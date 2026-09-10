/**
 * POST /api/print-bridge/result — the bridge reports the outcome of a claimed job. Updates the job AND
 * the underlying check's print status (+ reprint count) with a full audit entry. Never touches
 * QuickBooks. Machine-authenticated by PRINT_BRIDGE_TOKEN (fail closed).
 *
 * Body: { jobId: string, success: boolean, error?: string }
 */
import { NextResponse } from 'next/server'
import { bridgeAuthorized, bridgeAuthConfigured } from '@/apps/checks/bridge-auth'
import { applyBridgeResult, CheckValidationError } from '@/apps/checks/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (!bridgeAuthConfigured()) return NextResponse.json({ error: 'bridge_not_configured' }, { status: 503 })
  if (!bridgeAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { jobId?: string; success?: boolean; error?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  if (!body.jobId) return NextResponse.json({ error: 'jobId_required' }, { status: 400 })

  try {
    await applyBridgeResult(String(body.jobId), body.success !== false, body.error ?? null)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof CheckValidationError) return NextResponse.json({ error: e.code, message: e.message }, { status: 400 })
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}
