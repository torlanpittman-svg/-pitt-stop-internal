/**
 * GET /api/checks/[id]/jobs — print-job statuses for a check, so the manager UI can show "queued →
 * printing → printed / failed" after sending to the shop printer. Manager-only. No sensitive data.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { jobsForCheck, queuedCount } from '@/apps/checks/print-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { id } = await params
  const jobs = await jobsForCheck(id)
  return NextResponse.json({
    queueDepth: await queuedCount(),
    jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, error: j.error, claimedBy: j.claimedBy, printedAt: j.printedAt, createdAt: j.createdAt })),
  })
}
