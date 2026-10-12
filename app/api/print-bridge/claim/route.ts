/**
 * POST /api/print-bridge/claim — the always-on Pitt Stop print bridge claims the next queued check and
 * receives a ready-to-print PDF (base64). Machine-authenticated by PRINT_BRIDGE_TOKEN (fail closed).
 * NOT gated by employee/admin auth (it is a headless device) — the bearer token is the ONLY key, and the
 * response contains only the rendered check PDF (no bank credentials, no QuickBooks tokens).
 *
 * Every poll also records the bridge's heartbeat (so the app can show whether the shop printer link is
 * online) and expires queued jobs that waited too long (so nothing prints late and unattended).
 *
 * Body: { bridgeId?, version?, platform?, printer?, startedAt? }
 * 200 { job: null }                          — queue empty (or the claimed job was refused server-side)
 * 200 { job: { id, kind }, pdfBase64 }       — claimed; print it, then POST /result
 */
import { NextResponse } from 'next/server'
import { bridgeAuthorized, bridgeAuthConfigured } from '@/apps/checks/bridge-auth'
import { claimNextJob, recordBridgeHeartbeat } from '@/apps/checks/print-queue'
import { reconcileExpiredJobs, renderClaimedJob } from '@/apps/checks/service'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

export async function POST(req: Request) {
  if (!bridgeAuthConfigured()) return NextResponse.json({ error: 'bridge_not_configured' }, { status: 503 })
  if (!bridgeAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* optional */ }
  const bridgeId = str(body.bridgeId, 100) ?? 'bridge'

  // Telemetry + housekeeping are best-effort: neither may ever block a claim.
  try {
    await recordBridgeHeartbeat({ bridgeId, version: str(body.version, 32), platform: str(body.platform, 32), printer: str(body.printer, 120), startedAt: str(body.startedAt, 40) })
  } catch (e) { logger.warn('checks:bridge', 'heartbeat_failed', { error: String((e as Error)?.message ?? e) }) }
  try { await reconcileExpiredJobs() } catch (e) { logger.warn('checks:bridge', 'expire_failed', { error: String((e as Error)?.message ?? e) }) }

  const job = await claimNextJob(bridgeId)
  if (!job) return NextResponse.json({ job: null })

  const rendered = await renderClaimedJob(job)
  if ('refused' in rendered) {
    // The job was failed server-side (e.g. MICR not ready). Nothing is sent to the printer.
    logger.warn('checks:bridge', 'job_refused', { jobId: job.id, reason: rendered.refused })
    return NextResponse.json({ job: null, refused: { id: job.id, reason: rendered.refused } })
  }
  return NextResponse.json({
    job: { id: job.id, kind: job.kind, printerTarget: job.printerTarget },
    pdfBase64: rendered.pdf.toString('base64'),
  })
}
