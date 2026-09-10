/**
 * POST /api/print-bridge/claim — the always-on Pitt Stop print bridge claims the next queued check and
 * receives a ready-to-print PDF (base64). Machine-authenticated by PRINT_BRIDGE_TOKEN (fail closed).
 * NOT gated by employee/admin auth (it is a headless device) — the bearer token is the ONLY key, and the
 * response contains only the rendered check PDF (no bank credentials, no QuickBooks tokens).
 *
 * Body: { bridgeId?: string }
 * 200 { job: null }                          — queue empty
 * 200 { job: { id, checkNumber, kind }, pdfBase64 } — claimed; print it, then POST /result
 */
import { NextResponse } from 'next/server'
import { bridgeAuthorized, bridgeAuthConfigured } from '@/apps/checks/bridge-auth'
import { claimNextJob, markJobFailed } from '@/apps/checks/print-queue'
import { renderCheckPdf } from '@/apps/checks/pdf'
import { resolveDeferredMicr } from '@/apps/checks/template-server'
import { getCheckConfig } from '@/apps/checks/config'
import type { CheckPrintPayload } from '@/apps/checks/render'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (!bridgeAuthConfigured()) return NextResponse.json({ error: 'bridge_not_configured' }, { status: 503 })
  if (!bridgeAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { bridgeId?: string } = {}
  try { body = await req.json() } catch { /* optional */ }
  const bridgeId = String(body.bridgeId || 'bridge').slice(0, 100)

  const job = await claimNextJob(bridgeId)
  if (!job) return NextResponse.json({ job: null })

  try {
    const payload = job.payload as unknown as CheckPrintPayload
    // SECRET-SAFETY: build the real routing/account MICR line HERE (server-only env), never from the DB
    // payload. No-op unless the job carries a deferred check number AND negotiable printing is fully ready;
    // otherwise the stored non-negotiable placeholder prints (fail closed).
    if (payload.template?.micr?.deferCheckNumber != null) {
      payload.template = resolveDeferredMicr(payload.template, await getCheckConfig())
    }
    const pdf = renderCheckPdf(payload, payload.watermark ? { watermark: payload.watermark } : {})
    return NextResponse.json({
      job: { id: job.id, kind: job.kind, printerTarget: job.printerTarget },
      pdfBase64: pdf.toString('base64'),
    })
  } catch (e) {
    // Payload was unrenderable — fail the job so it doesn't get stuck 'claimed' forever.
    await markJobFailed(job.id, `render_failed: ${String((e as Error)?.message ?? e)}`)
    return NextResponse.json({ error: 'render_failed' }, { status: 500 })
  }
}
