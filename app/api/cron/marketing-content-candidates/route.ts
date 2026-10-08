/**
 * GET /api/cron/marketing-content-candidates
 * Detects completed jobs with strong before/after assets + a known premium service that could become
 * proof posts. Read-only — it DOES NOT create or publish anything (a manager turns a candidate into a
 * draft from the Content page). FAIL-CLOSED auth: CRON_SECRET (Vercel Cron) or MARKETING_CRON_TOKEN is
 * REQUIRED; if neither is configured the endpoint denies all requests (never falls open).
 */
import { NextResponse } from 'next/server'
import { findContentCandidates } from '@/apps/marketing/content'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  const token = process.env.MARKETING_CRON_TOKEN
  const auth = req.headers.get('authorization') ?? ''
  if (!secret && !token) return false  // fail-closed: no secret configured → deny
  return (!!secret && auth === `Bearer ${secret}`) || (!!token && auth === `Bearer ${token}`)
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const candidates = await findContentCandidates(50)
    logger.info('cron:marketing-content-candidates', 'scanned', { count: candidates.length })
    return NextResponse.json({ ok: true, count: candidates.length, candidates })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('cron:marketing-content-candidates', 'failed', { error: msg })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
