/**
 * POST /api/print-bridge/result — the bridge reports what happened to a claimed job. Machine-authenticated
 * by PRINT_BRIDGE_TOKEN (fail closed). Never touches QuickBooks.
 *
 * Body: { jobId: string, outcome?: 'submitted' | 'failed' | 'uncertain', error?: string }
 *   submitted — handed to the printer driver. NOT proof of paper: the check waits for a manager to confirm.
 *   failed    — the bridge is sure nothing will print.
 *   uncertain — the bridge cannot tell; the job stays open for a manager to settle.
 * Older bridges send { success: boolean } — true is treated as 'submitted', false as 'failed'.
 * Reports are idempotent: a repeated or late report for an already-settled job changes nothing.
 */
import { NextResponse } from 'next/server'
import { bridgeAuthorized, bridgeAuthConfigured } from '@/apps/checks/bridge-auth'
import { applyBridgeResult, CheckValidationError, type BridgeOutcome } from '@/apps/checks/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (!bridgeAuthConfigured()) return NextResponse.json({ error: 'bridge_not_configured' }, { status: 503 })
  if (!bridgeAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { jobId?: string; outcome?: string; success?: boolean; error?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  if (!body.jobId) return NextResponse.json({ error: 'jobId_required' }, { status: 400 })

  let outcome: BridgeOutcome
  if (body.outcome === 'submitted' || body.outcome === 'failed' || body.outcome === 'uncertain') outcome = body.outcome
  else if (typeof body.success === 'boolean') outcome = body.success ? 'submitted' : 'failed'
  else return NextResponse.json({ error: 'outcome_required' }, { status: 400 }) // never assume success

  try {
    const res = await applyBridgeResult(String(body.jobId), outcome, body.error ? String(body.error) : null)
    return NextResponse.json(res)
  } catch (e) {
    if (e instanceof CheckValidationError) return NextResponse.json({ error: e.code, message: e.message }, { status: 400 })
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}
